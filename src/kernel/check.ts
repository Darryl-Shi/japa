import type { ToolRegistration } from "@earendil-works/pi-durable";
import { createModels } from "@earendil-works/pi-ai";
import { execFile } from "node:child_process";
import { existsSync, globSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { boot } from "./boot.ts";
import { CORE_CONTRACTS, type EnvironmentAdapter } from "./contracts.ts";
import { parseFrontmatter } from "./frontmatter.ts";
import { fauxKit } from "./kit.ts";
import { discoverExtensions, linkSdk, loadExtensions, message } from "./loader.ts";
import { loadSkills } from "./skills.ts";
import { profileError, readProfile } from "./workers.ts";

const packageRoot = fileURLToPath(new URL("../..", import.meta.url));
const packaged = join(packageRoot, "extensions");
const contracts = new Map(CORE_CONTRACTS.map((c) => [c.name, c]));

export const CHECK_KINDS = ["skill", "worker", "extension"] as const;

/** The problems with the skill, worker profile or extension `name` in `dir` (the workspace or staging root); `[]` passes. */
export async function check(
  kind: (typeof CHECK_KINDS)[number],
  name: string,
  dir: string,
  home: string,
): Promise<string[]> {
  linkSdk(home, packageRoot); // so `dir`'s extensions resolve "japa/sdk"
  if (kind === "skill") return checkSkill(name, dir);
  if (kind === "worker") return checkWorker(name, dir, home);
  return checkExtension(name, dir, home);
}

function checkSkill(name: string, dir: string): string[] {
  const file = join(dir, "skills", name, "SKILL.md");
  if (!existsSync(file)) return [`${file} does not exist`];
  try {
    const { data } = parseFrontmatter(readFileSync(file, "utf8"));
    return [
      ...(data.name === name ? [] : [`name must be "${name}"`]),
      ...(typeof data.description === "string" && data.description ? [] : ["description is required"]),
    ];
  } catch (error) {
    return [message(error)];
  }
}

/** Checks the profile against the builtin models, built-in tools, and the packaged and `dir`'s extensions and skills. */
async function checkWorker(name: string, dir: string, home: string): Promise<string[]> {
  let profile;
  try {
    profile = readProfile(join(dir, "workers", `${name}.md`), home);
  } catch (error) {
    return [message(error)];
  }
  const { extensions } = await loadExtensions(discoverExtensions([packaged, join(dir, "extensions")]), contracts);
  const environments = extensions.flatMap((e) => (e.provides?.environment ?? []) as EnvironmentAdapter[]);
  const error = profileError(
    profile,
    createModels(),
    new Map(environments.map((a) => [a.name, a])),
    new Map(extensions.filter((e) => e.provides?.tool || e.durable).map((e) => [e.name, e])),
    loadSkills([join(packageRoot, "skills"), join(dir, "skills")]).skills,
  );
  return error === undefined ? [] : [error];
}

/** Manifest, typecheck, the extension's own tests and a smoke load, stopping at the first that fails. */
async function checkExtension(name: string, dir: string, home: string): Promise<string[]> {
  const source = join(dir, "extensions", name);
  const { extensions, errors } = await loadExtensions(discoverExtensions([packaged, join(dir, "extensions")]), contracts);
  const failed = errors.filter((e) => e.name === name).map((e) => e.error);
  if (failed.length > 0) return failed;
  const extension = extensions.find((e) => e.name === name);
  if (extension === undefined) return [`${join(source, "index.ts")} does not exist`];
  const long = ((extension.provides?.tool ?? []) as ToolRegistration[]).filter((t) => t.description.length > 1024);
  if (long.length > 0) return long.map((t) => `tool "${t.name}": description is longer than 1024 characters`);

  const tmp = mkdtempSync(join(tmpdir(), "japa-check-"));
  const config = join(tmp, "tsconfig.json");
  writeFileSync(
    config,
    JSON.stringify({
      extends: join(packageRoot, "tsconfig.json"),
      compilerOptions: { typeRoots: [join(packageRoot, "node_modules", "@types")] },
      include: [source],
      exclude: [join(source, "**/*.test.ts")], // `vitest` resolves only when they run, below
    }),
  );
  const compiled = await run("tsc", ["-p", config]);
  rmSync(tmp, { recursive: true, force: true });
  if (compiled !== undefined) return [compiled];
  if (globSync("**/*.test.ts", { cwd: source }).length > 0) {
    const tested = await run("vitest", ["run", "--root", source]);
    if (tested !== undefined) return [tested];
  }
  return smokeLoad(name, dir);
}

/** Runs japa's own `bin` with `args`; its output when it fails. */
async function run(bin: string, args: string[]): Promise<string | undefined> {
  try {
    await promisify(execFile)(join(packageRoot, "node_modules", ".bin", bin), args);
    return undefined;
  } catch (error) {
    const { stdout, stderr } = error as { stdout: string; stderr: string };
    return `${stdout}${stderr}`.trim();
  }
}

/** Boots a throwaway daemon with `dir`'s extensions, checks that `name` loads, is described and has unique tool names. */
async function smokeLoad(name: string, dir: string): Promise<string[]> {
  const kit = fauxKit();
  const home = mkdtempSync(join(tmpdir(), "japa-check-"));
  writeFileSync(join(home, "settings.json"), JSON.stringify({ storage: { adapter: "memory" }, models: { cos: kit.model } }));
  const problems: string[] = [];
  try {
    const daemon = await boot({ home, extensionDirs: [packaged, join(dir, "extensions")], extensions: [kit.extension] });
    const status = daemon.status();
    if (!status.extensions.some((e) => e.name === name)) problems.push("did not load");
    problems.push(...status.errors.filter((e) => e.name === name).map((e) => e.error));
    if (!daemon.capabilities().includes(`- ${name}: `)) problems.push("missing from the capabilities");
    const tools = daemon.registry.snapshot().tools();
    for (const { tool } of tools.filter((t) => t.extension.name === name)) {
      for (const other of tools.filter((t) => t.tool.name === tool.name && t.extension.name !== name)) {
        problems.push(`tool "${tool.name}" is also provided by ${other.extension.name}`);
      }
    }
    await daemon.close().catch((error) => problems.push(`close: ${message(error)}`));
  } catch (error) {
    problems.push(`boot: ${message(error)}`);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
  return problems;
}
