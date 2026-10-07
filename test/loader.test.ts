import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { TestContext } from "node:test";
import {
  BACKGROUND_CONTEXT as context,
  withCancel,
} from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  createRegistry,
  Harness,
  MemoryStorage,
  ToolTask,
} from "@earendil-works/pi-durable";
import type { ToolExecutionApi } from "@earendil-works/pi-durable";
import { Host } from "../src/core/host.ts";
import {
  createLoader,
  InstallManifest,
  MAX_SOURCE_LENGTH,
} from "../src/core/loader.ts";
import { selfExtension } from "../src/extensions/self.ts";

// Reopen the same native storage data with a fresh Harness/registry (no model calls).
class ReopenStorage extends MemoryStorage {
  override async close() {}
}
async function openHost(storage = new ReopenStorage()) {
  const registry = createRegistry();
  const harness = await Harness.open(
    storage,
    { models: createModels(), registry },
    context,
  );
  // Exercise the real Host.install implementation without configuring eight adapters.
  const host = Object.assign(Object.create(Host.prototype), {
    registry,
    harness,
    adapters: {},
    builtins: new Set(["japa.self"]),
    report: () => {},
  }) as Host;
  return { host, storage };
}
const api = {} as ToolExecutionApi;
function source(version: string, extra = "") {
  return `
import type { Extension } from "japa";
import { Host } from "japa";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, ToolTask } from "@earendil-works/pi-durable";
export default {
  name: "hello",
  register(_host) { return { name: "hello", tools: [defineTool({
    name: "hello", description: "Fixture", parameters: Type.Object({}), replay: "safe",
    execute: async () => ({ content: [{ type: "text", text: ${JSON.stringify(version)} }], details: ToolTask.definition.name })
  })] }; }
} satisfies Extension;
export { Host, ToolTask };
${extra}
`;
}
async function setup(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "japa-loader-"));
  const { host, storage } = await openHost();
  t.after(async () => {
    await host.harness.close(context);
    await rm(directory, { recursive: true, force: true });
  });
  const loader = createLoader(host, directory);
  await loader.restore(context);
  return { host, storage, loader, directory };
}

test("validates names and source before creating a manifest", async (t) => {
  const { loader } = await setup(t);
  for (const name of ["../hello", "japa.self", "Hello", "", "a".repeat(65)])
    await assert.rejects(loader.install(name, source("one"), context), /slug/);
  for (const text of ["", " ", "x".repeat(MAX_SOURCE_LENGTH + 1)])
    await assert.rejects(loader.install("hello", text, context), /Source/);
  assert.deepEqual(await loader.list(context), []);
});

test("builds native contributions; typecheck and probe failures preserve working code", async (t) => {
  const { loader, host, directory } = await setup(t);
  const [first, duplicate] = await Promise.all([
    loader.install("hello", source("one"), context),
    loader.install("hello", source("one"), context),
  ]);
  assert.equal(
    duplicate.status,
    "unchanged",
    "concurrent installs serialize before publication",
  );
  const original = host.registry.snapshot().extension("hello");
  const module = await import(join(directory, `hello.${first.hash}.mjs`));
  assert.equal(
    module.ToolTask,
    ToolTask,
    "native imports must use the host module identity",
  );
  assert.equal(
    module.Host,
    Host,
    "Japa imports must use the host module identity",
  );
  assert.equal(
    (await original!.tools![0]!.execute({}, api, context)).content?.[0]?.type,
    "text",
  );
  await assert.rejects(
    loader.install(
      "hello",
      source("bad", 'const error: number = "not a number";'),
      context,
    ),
    /not assignable/,
  );
  await assert.rejects(
    loader.install(
      "hello",
      source(
        "bad",
        'export function selfTest() { process.stderr.write("x".repeat(50_000)); throw new Error("probe failed"); }',
      ),
      context,
    ),
    (error: Error) => {
      assert.match(error.message, /probe failed/);
      assert.ok(error.message.length < 8300, "child stderr is bounded");
      return true;
    },
  );
  assert.equal(host.registry.snapshot().extension("hello"), original);
  assert.equal((await loader.list(context))[0]!.current, first.hash);
  const second = await loader.install("hello", source("two"), context);
  assert.notEqual(second.hash, first.hash);
  assert.equal((await loader.list(context))[0]!.previous, first.hash);
  assert.equal(
    (await loader.install("hello", source("one"), context)).status,
    "unchanged",
  );
  assert.equal(
    (await loader.list(context))[0]!.current,
    second.hash,
    "old replay cannot revert a newer install",
  );
  const record = (await loader.list(context))[0]!;
  assert.equal(await readFile(record.sourcePath, "utf8"), source("two"));
});

test("self tools install through the registry, return diagnostics, and stay out of root selection", async (t) => {
  const { host, directory } = await setup(t);
  const self = selfExtension(directory);
  host.registry.install(self.register!(host));
  await self.start!(host);
  const tools = host.registry.snapshot().extension("japa.self")!.tools!;
  const install = tools.find((tool) => tool.name === "extension_install")!;
  assert.equal(install.replay, "safe");
  const result = await install.execute(
    { name: "hello", source: source("from tool") },
    api,
    context,
  );
  assert.notEqual(result.isError, true);
  const root = await host.harness.root(context, { agent: { extensions: [] } });
  assert.deepEqual((await root.agent(context)).tools, []);
  const worker = await host.harness.createConversation(
    { ownership: { kind: "ownerless" } },
    context,
  );
  const hello = (await worker.agent(context)).tools.find(
    (tool) => tool.name === "hello",
  )!;
  assert.deepEqual((await hello.execute({}, api, context)).content, [
    { type: "text", text: "from tool" },
  ]);
  const invalid = await install.execute(
    { name: "../unsafe", source: "" },
    api,
    context,
  );
  assert.equal(invalid.isError, true);
  assert.equal(invalid.diagnostics?.[0]?.severity, "error");
  for (const name of ["extension_catalog", "extension_guide"])
    assert.ok(
      (
        await tools
          .find((tool) => tool.name === name)!
          .execute({}, api, context)
      ).content?.length,
    );
});

test("persistent manifest reopens and restores known-good immutable bundles", async (t) => {
  const { host, storage, loader, directory } = await setup(t);
  const installed = await loader.install("hello", source("reopened"), context);
  for (let index = 0; index < 70; index++) {
    await host.harness.commit(async (tx) => {
      (await tx.doc(InstallManifest)).extensions[0]!.diagnostic = String(index);
    }, context);
  }
  const document = await storage.findDocument(
    { kind: "japa.extensions", scope: { kind: "session" } },
    "current",
    context,
  );
  assert.ok(
    (await storage.document(document!.id, "current", context))!
      .deltasSinceBase < 32,
  );
  await host.harness.close(context);
  const reopened = (await openHost(storage)).host;
  t.after(() => reopened.harness.close(context));
  const restored = createLoader(reopened, directory);
  await restored.restore(context);
  assert.equal((await restored.list(context))[0]!.current, installed.hash);
  const tool = reopened.registry.snapshot().extension("hello")!.tools![0]!;
  assert.deepEqual((await tool.execute({}, api, context)).content, [
    { type: "text", text: "reopened" },
  ]);
  assert.equal(
    (await restored.install("hello", source("reopened"), context)).status,
    "unchanged",
  );
});

test("pending activation recovers previous code and quarantines a first install", async (t) => {
  const { host, storage, loader, directory } = await setup(t);
  const first = await loader.install("hello", source("stable"), context);
  const second = await loader.install("hello", source("interrupted"), context);
  // Model a crash after publication but before marking good. No state rollback is claimed.
  await host.harness.commit(async (tx) => {
    const manifest = await tx.doc(InstallManifest);
    const record = manifest.extensions[0]!;
    record.status = "pending";
    record.revisions[1]!.status = "pending";
    manifest.extensions.push({
      diagnostic: "",
      name: "orphan",
      current: "f".repeat(64),
      previous: null,
      sourcePath: "/unused",
      status: "pending",
      revisions: [
        {
          hash: "f".repeat(64),
          sourceHash: "e".repeat(64),
          sourcePath: "/unused",
          status: "pending",
        },
      ],
    });
  }, context);
  await host.harness.close(context);
  const reopened = (await openHost(storage)).host;
  t.after(() => reopened.harness.close(context));
  const restored = createLoader(reopened, directory);
  await restored.restore(context);
  const records = await restored.list(context);
  assert.equal(records[0]!.current, first.hash);
  const manifest = await reopened.harness.snapshot(InstallManifest, context);
  assert.equal(
    manifest!.extensions[0]!.revisions.find(
      (item) => item.hash === second.hash,
    )!.status,
    "quarantined",
  );
  assert.equal(records[1]!.status, "quarantined");
  assert.equal(reopened.registry.snapshot().extension("orphan"), undefined);
  await assert.rejects(
    restored.install("hello", source("interrupted"), context),
    /quarantined/,
  );
});

test("rejects generated tasks and cancels a running child check", async (t) => {
  const { loader, host } = await setup(t);
  await assert.rejects(
    loader.install(
      "hello",
      `import { ToolTask } from "@earendil-works/pi-durable"; export default { name: "hello", register() { return { name: "hello", tasks: [ToolTask] }; } };`,
      context,
    ),
    /custom durable tasks/,
  );
  const cancelled = withCancel(context);
  const pending = loader.install(
    "hello",
    source("hanging", "await new Promise(() => {});"),
    cancelled.context,
  );
  const timer = setTimeout(() => cancelled.cancel(), 100);
  try {
    await assert.rejects(pending);
  } finally {
    clearTimeout(timer);
  }
  assert.equal(host.registry.snapshot().extension("hello"), undefined);
  assert.deepEqual(await loader.list(context), []);
});

test("probe timeout rejects hanging code before publication", async (t) => {
  const { loader, host } = await setup(t);
  await assert.rejects(
    loader.install(
      "hello",
      source("hanging", "export function selfTest() { while (true) {} }"),
      context,
    ),
    /timed out/,
  );
  assert.equal(host.registry.snapshot().extension("hello"), undefined);
  assert.deepEqual(await loader.list(context), []);
});

test("safe startup keeps tools but skips restoration; catalog and revision growth are bounded", async (t) => {
  const { host, loader, directory } = await setup(t);
  await host.harness.commit(async (tx) => {
    const records = (await tx.doc(InstallManifest)).extensions;
    for (let index = 0; index < 32; index++)
      records.push({
        name: `slot-${index}`,
        current: "a".repeat(64),
        previous: null,
        sourcePath: "/not-present",
        status: "good",
        diagnostic: "x".repeat(2048),
        revisions: Array.from({ length: 16 }, (_, revision) => ({
          hash: "a".repeat(64),
          sourceHash: String(revision).padStart(64, "0"),
          sourcePath: "/not-present",
          status: "good" as const,
        })),
      });
  }, context);
  const self = selfExtension(directory, { safe: true });
  host.registry.install(self.register!(host));
  await self.start!(host);
  assert.equal(host.registry.snapshot().extension("slot-0"), undefined);
  assert.equal(
    (await loader.list(context))[0]!.status,
    "good",
    "safe boot did not probe missing files",
  );
  const tools = host.registry.snapshot().extension("japa.self")!.tools!;
  assert.equal(tools.length, 3);
  const catalog = await tools
    .find((tool) => tool.name === "extension_catalog")!
    .execute({}, api, context);
  const content = catalog.content![0]!;
  assert.equal(content.type, "text");
  if (content.type === "text") assert.ok(content.text.length <= 32_020);
  await assert.rejects(
    loader.install("hello", source("new"), context),
    /Catalog limit/,
  );
  await assert.rejects(
    loader.install("slot-0", source("revision"), context),
    /Revision limit/,
  );
});

test("weather example builds and activates without network access", async (t) => {
  const { loader, host } = await setup(t);
  const weather = await readFile(
    new URL("../examples/weather.ts", import.meta.url),
    "utf8",
  );
  await loader.install("weather", weather, context);
  assert.equal(
    host.registry.snapshot().extension("weather")!.tools![0]!.name,
    "weather",
  );
});
