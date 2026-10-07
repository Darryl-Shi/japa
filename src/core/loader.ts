import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { Context } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createRegistry, defineDoc } from "@earendil-works/pi-durable";
import type { Extension, Host } from "./host.ts";

export const MAX_SOURCE_LENGTH = 100_000;
const MAX_EXTENSIONS = 32;
const MAX_REVISIONS = 16; // Keep receipts; reject further growth instead of forgetting replay keys.
type Status = "pending" | "good" | "quarantined";
type Revision = {
  hash: string;
  sourceHash: string;
  sourcePath: string;
  status: Status;
};
export type InstallRecord = {
  name: string;
  current: string;
  previous: string | null;
  sourcePath: string;
  status: Status;
  revisions: Revision[];
  diagnostic: string;
};
export const InstallManifest = defineDoc<{ extensions: InstallRecord[] }>({
  kind: "japa.extensions",
  version: 1,
  scope: "session",
  initial: () => ({ extensions: [] }),
  checkpointWhen: (_value, _ops, info) => info.deltasSinceBase >= 31,
});

const hostDirectory = fileURLToPath(new URL("../../", import.meta.url));
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const diagnostic = (error: unknown) =>
  String(error instanceof Error ? error.message : error).slice(-2048);
function validateName(name: string): void {
  if (typeof name !== "string" || !/^[a-z][a-z0-9_-]{0,63}$/.test(name))
    throw new Error(
      "Name must be a safe lowercase slug (1–64 characters); japa.* is reserved",
    );
}

// These are operational checks of TRUSTED code, not a security boundary. No npm installs.
const buildScript = `
import ts from ${JSON.stringify(import.meta.resolve("typescript"))};
import { build } from ${JSON.stringify(import.meta.resolve("esbuild"))};
import { isBuiltin } from 'node:module';
const [source, output, root] = process.argv.slice(1);
const options = { strict: true, noEmit: true, skipLibCheck: true, allowImportingTsExtensions: true,
  target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler, types: ['node'], typeRoots: [root + '/node_modules/@types'] };
const compiler = ts.createCompilerHost(options);
compiler.resolveModuleNames = (names, containing) => names.map(name =>
  ts.resolveModuleName(name, containing === source ? root + '/src/core/loader.ts' : containing, options, ts.sys).resolvedModule);
const check = source + '.check.ts';
const readSource = compiler.getSourceFile;
compiler.getSourceFile = (file, language, ...rest) => file === check
  ? ts.createSourceFile(file, 'import extension from ' + JSON.stringify(source) + '; import type { Extension } from ' +
      JSON.stringify(root + '/src/core/host.ts') + '; const checked: Extension = extension;', language, true)
  : readSource(file, language, ...rest);
const program = ts.createProgram([source, check], options, compiler);
// Check the candidate against host types, not every implementation re-exported by japa.
const errors = [...program.getOptionsDiagnostics(), ...[source, check].flatMap(file => {
  const unit = program.getSourceFile(file);
  return [...program.getSyntacticDiagnostics(unit), ...program.getSemanticDiagnostics(unit)];
})];
if (errors.length) throw new Error(ts.formatDiagnostics(errors.slice(0, 20), {
  getCanonicalFileName: p => p, getCurrentDirectory: () => root, getNewLine: () => '\\n' }));
await build({ entryPoints: [source], outfile: output, bundle: true, platform: 'node', format: 'esm',
  target: 'node24', logLevel: 'silent', plugins: [{ name: 'host-imports', setup(builder) {
    builder.onResolve({ filter: /.*/ }, args => {
      if (args.kind === 'entry-point') return;
      if (isBuiltin(args.path)) return { path: args.path, external: true };
      if (args.path === 'japa' || args.path === 'japa/core' || /^@earendil-works\\//.test(args.path))
        return { path: import.meta.resolve(args.path), external: true };
      throw new Error('Only japa, @earendil-works/* and Node built-in imports are supported: ' + args.path);
    });
  }}] });
`;

const probeScript = `
import { createRegistry } from ${JSON.stringify(import.meta.resolve("@earendil-works/pi-durable"))};
const [url, name] = process.argv.slice(1);
const module = await import(url);
const extension = module.default;
if (!extension || extension.name !== name || typeof extension.register !== 'function' || extension.adapters || extension.start)
  throw new Error('Expected default Japa Extension with matching name, register(host), and no adapters/start');
const registry = createRegistry();
// register must only declare contributions. Capture host for later tools; do not use live resources here.
const contribution = extension.register({ registry, adapters: {}, report: console.error });
if (!contribution || contribution.name !== name) throw new Error('Contribution name must match');
if (contribution.tasks?.length) throw new Error('Generated custom durable tasks are unsupported in v1');
registry.install(contribution);
if (module.selfTest !== undefined) {
  if (typeof module.selfTest !== 'function') throw new Error('selfTest must be a function');
  await module.selfTest();
}
process.exit(0);
`;

async function child(
  script: string,
  args: string[],
  context: Context,
  timeout: number,
): Promise<void> {
  context.abortSignal?.throwIfAborted();
  await new Promise<void>((done, reject) => {
    const processChild = spawn(
      process.execPath,
      [
        "--import",
        import.meta.resolve("tsx"),
        "--input-type=module",
        "--eval",
        script,
        ...args,
      ],
      {
        cwd: hostDirectory,
        stdio: ["ignore", "ignore", "pipe"],
      },
    );
    let stderr = "";
    let failure: Error | undefined;
    const stop = (reason: string) => {
      failure = new Error(reason);
      processChild.kill("SIGKILL");
    };
    const abort = () => stop("Extension check cancelled");
    const timer = setTimeout(
      () => stop(`Extension check timed out after ${timeout}ms`),
      timeout,
    );
    context.abortSignal?.addEventListener("abort", abort, { once: true });
    processChild.stderr.on("data", (data: Buffer) => {
      stderr = (stderr + data.toString()).slice(-8192);
    });
    processChild.on("error", (error) => {
      failure = error;
    });
    processChild.on("close", (code) => {
      clearTimeout(timer);
      context.abortSignal?.removeEventListener("abort", abort);
      if (failure || code !== 0)
        reject(
          new Error(
            `${failure?.message ?? "Extension check failed"}\n${stderr}`,
          ),
        );
      else done();
    });
  });
}

async function immutable(path: string, contents: string): Promise<void> {
  try {
    if ((await readFile(path, "utf8")) !== contents)
      throw new Error(`Hash file is corrupt: ${path}`);
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  // A crash must not leave a partial file occupying its permanent content hash.
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    const file = await open(temporary, "wx", 0o444);
    try {
      await file.writeFile(contents);
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

/** One loader per host. Call restore during startup, before ingress or harness.resume(). */
export function createLoader(host: Host, directory: string) {
  directory = resolve(directory);
  let line = Promise.resolve();
  let needsRecovery = false;
  const active = new Map<string, string>();
  function serial<T>(context: Context, work: () => Promise<T>): Promise<T> {
    const result = line.then(() => {
      context.abortSignal?.throwIfAborted();
      return work();
    });
    line = result.then(
      () => {},
      () => {},
    );
    // Join the real operation even on cancellation. Otherwise a tool could finish
    // while its loader still imports code or commits into a closing harness.
    return result;
  }
  const records = async (context: Context) =>
    (await host.harness.snapshot(InstallManifest, context))?.extensions ?? [];
  const list = async (context: Context) =>
    (await records(context)).map(({ revisions: _history, ...record }) => ({
      ...record,
      active: active.get(record.name) ?? null,
    }));
  async function save(record: InstallRecord, context: Context): Promise<void> {
    await host.harness.commit(async (tx) => {
      const records = (await tx.doc(InstallManifest)).extensions;
      const index = records.findIndex((item) => item.name === record.name);
      if (index < 0) records.push(record);
      else records[index] = record;
    }, context);
  }
  function bundlePath(name: string, version: string): string {
    validateName(name);
    if (!/^[a-f0-9]{64}$/.test(version)) throw new Error("Invalid bundle hash");
    return join(directory, `${name}.${version}.mjs`);
  }
  async function load(
    record: InstallRecord,
    context: Context,
    probe = true,
  ): Promise<void> {
    const path = bundlePath(record.name, record.current);
    if (hash(await readFile(path, "utf8")) !== record.current)
      throw new Error(`Corrupt bundle: ${path}`);
    if (probe)
      await child(
        probeScript,
        [pathToFileURL(path).href, record.name],
        context,
        5000,
      );
    context.abortSignal?.throwIfAborted();
    const extension = (await import(pathToFileURL(path).href))
      .default as Extension;
    if (
      !extension ||
      extension.name !== record.name ||
      !extension.register ||
      extension.adapters ||
      extension.start
    )
      throw new Error(
        "Expected a matching Japa Extension without adapters/start",
      );
    const contribution = extension.register(host);
    if (contribution?.name !== record.name)
      throw new Error("Contribution name must match");
    if (
      contribution.tasks?.length ||
      host.registry.snapshot().extension(record.name)?.tasks?.length
    )
      throw new Error(
        "Generated custom durable tasks and replacement of task extensions are unsupported in v1",
      );
    const candidate = createRegistry();
    candidate.install(contribution); // Validate without changing the live registry.
    host.install({ name: record.name, register: () => contribution });
    active.set(record.name, record.current);
  }
  async function restore(context: Context): Promise<void> {
    return serial(context, async () => {
      if (active.size || needsRecovery)
        throw new Error("Restore is startup-only; restart the host");
      for (const stored of await records(context)) {
        const record = structuredClone(stored);
        if (record.status === "pending") {
          record.revisions.find(
            (revision) => revision.hash === record.current,
          )!.status = "quarantined";
          const previous = record.revisions.find(
            (revision) =>
              revision.hash === record.previous && revision.status === "good",
          );
          record.diagnostic =
            "Interrupted activation quarantined; code recovery does not undo state migrations";
          if (previous) {
            record.current = previous.hash;
            record.sourcePath = previous.sourcePath;
            record.previous = null;
            record.status = "good";
          } else record.status = "quarantined";
          await save(record, context);
        }
        if (record.status !== "good") continue;
        try {
          await load(record, context);
        } catch (error) {
          context.abortSignal?.throwIfAborted();
          record.status = "quarantined";
          const revision = record.revisions.find(
            (item) => item.hash === record.current,
          );
          if (revision) revision.status = "quarantined";
          record.diagnostic = diagnostic(error);
          await save(record, context);
          host.report(error);
        }
      }
    });
  }
  async function install(name: string, source: string, context: Context) {
    return serial(context, async () => {
      validateName(name);
      if (
        typeof source !== "string" ||
        !source.trim() ||
        source.length > MAX_SOURCE_LENGTH
      )
        throw new Error(
          `Source must contain 1–${MAX_SOURCE_LENGTH} characters`,
        );
      if (needsRecovery)
        throw new Error(
          "Activation interrupted; restart before installing more extensions",
        );
      const catalog = await records(context);
      const old = catalog.find((record) => record.name === name);
      if (old?.status === "pending")
        throw new Error("Restore pending installs before accepting inputs");
      const installed = host.registry.snapshot().extension(name);
      if (installed && (!old || installed.tasks?.length))
        throw new Error(
          "Cannot replace an unmanaged or durable-task extension",
        );
      const sourceHash = hash(source);
      const prior = old?.revisions.find(
        (revision) => revision.sourceHash === sourceHash,
      );
      if (prior) {
        if (prior.status !== "good")
          throw new Error(
            "This content is quarantined; edit the source before retrying",
          );
        // Receipts survive later installs: replaying A after B must not revert B.
        return {
          name,
          hash: prior.hash,
          current: old!.current,
          active: active.get(name) ?? null,
          status: "unchanged" as const,
        };
      }
      if (!old && catalog.length >= MAX_EXTENSIONS)
        throw new Error(`Catalog limit reached (${MAX_EXTENSIONS} extensions)`);
      if (old && old.revisions.length >= MAX_REVISIONS)
        throw new Error(
          `Revision limit reached (${MAX_REVISIONS} per extension); operator maintenance required`,
        );
      await mkdir(directory, { recursive: true });
      const sourcePath = join(directory, `${name}.${sourceHash}.ts`);
      await immutable(sourcePath, source);
      const temporary = join(directory, `.build-${randomUUID()}.mjs`);
      let contents: string;
      try {
        await child(
          buildScript,
          [sourcePath, temporary, hostDirectory],
          context,
          20_000,
        );
        contents = await readFile(temporary, "utf8");
      } finally {
        await rm(temporary, { force: true });
      }
      const version = hash(contents);
      const path = bundlePath(name, version);
      await immutable(path, contents);
      await child(probeScript, [pathToFileURL(path).href, name], context, 5000);
      const folder = await open(directory, "r");
      try {
        await folder.sync();
      } finally {
        await folder.close();
      }
      context.abortSignal?.throwIfAborted();
      const record: InstallRecord = {
        name,
        current: version,
        previous: old?.status === "good" ? old.current : null,
        sourcePath,
        status: "pending",
        diagnostic: "",
        revisions: [
          ...(old?.revisions ?? []),
          { hash: version, sourceHash, sourcePath, status: "pending" },
        ],
      };
      // Once pending is durable, finish publication even if the tool caller cancels.
      // Any activation/commit failure leaves pending and blocks more installs until restart.
      needsRecovery = true;
      await save(record, BACKGROUND_CONTEXT);
      await load(record, BACKGROUND_CONTEXT, false);
      record.status = "good";
      record.revisions[record.revisions.length - 1]!.status = "good";
      await save(record, BACKGROUND_CONTEXT);
      needsRecovery = false;
      return {
        name,
        hash: version,
        current: version,
        status: "installed" as const,
      };
    });
  }
  return { restore, install, list };
}
