import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { getCurrentTools } from "@earendil-works/pi-ai";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { Host } from "../src/core/host.ts";
import type { Extension } from "../src/core/host.ts";
import { defaultExtensions } from "../src/defaults.ts";
import { context, scriptedModels, testChannel, until } from "./helpers.ts";

test("core fails startup on a missing required adapter", async () => {
  await assert.rejects(
    Host.open({ storage: new MemoryStorage(), extensions: [] }),
    /Adapter 'channel'/,
  );
});

test("provider replacement is explicit, not dependent on load order", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "japa-bindings-"));
  await mkdir(join(home, "workspace"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const channel = testChannel();
  let assembled = 0;
  const alternate: Extension = {
    name: "alternate-context",
    adapters: {
      context: () => ({
        async assemble(messages) {
          assembled++;
          return messages;
        },
      }),
    },
  };
  const extensions = [
    ...defaultExtensions({
      home,
      models: scriptedModels(() => fauxAssistantMessage("Hello")),
      channel: channel.channel,
    }),
    alternate,
  ];
  await assert.rejects(
    Host.open({ storage: new MemoryStorage(), extensions }),
    /explicit binding/,
  );
  const host = await Host.open({
    storage: new MemoryStorage(),
    extensions,
    bindings: { context: alternate.name },
  });
  t.after(() => host.close());
  await channel.say("Hi");
  await until(() => channel.sent.length === 1);
  assert.equal(assembled, 1);
  await assert.rejects(
    Host.open({
      storage: new MemoryStorage(),
      extensions,
      bindings: { context: "missing" },
    }),
    /explicit binding/,
  );
});

test("failed startup unwinds acquired resources; close is idempotent", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "japa-lifecycle-"));
  await mkdir(join(home, "workspace"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const lifecycle: string[] = [];
  const extensions = defaultExtensions({
    home,
    models: scriptedModels(() => fauxAssistantMessage("Hello")),
    channel: testChannel().channel,
  });
  extensions.push({
    name: "resource",
    async start() {
      lifecycle.push("start");
      return () => {
        lifecycle.push("stop");
      };
    },
  });
  await assert.rejects(
    Host.open({
      storage: new MemoryStorage(),
      extensions: [
        ...extensions,
        {
          name: "broken",
          async start() {
            throw new Error("broken startup");
          },
        },
      ],
    }),
    /broken startup/,
  );
  assert.deepEqual(lifecycle, ["start", "stop"]);
  const host = await Host.open({ storage: new MemoryStorage(), extensions });
  await Promise.all([host.close(), host.close()]);
  assert.deepEqual(lifecycle, ["start", "stop", "start", "stop"]);
});

test("context failure does not silently send unbounded history or offered tools", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "japa-context-failure-"));
  await mkdir(join(home, "workspace"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const channel = testChannel();
  const reported: unknown[] = [];
  const extensions = defaultExtensions({
    home,
    channel: channel.channel,
    models: scriptedModels((request) => {
      assert(
        !JSON.stringify(request.messages).includes("private user content"),
      );
      assert.equal(getCurrentTools(request.messages).length, 0);
      return fauxAssistantMessage("Please retry.");
    }),
  });
  extensions.push({
    name: "broken-context",
    adapters: {
      context: () => ({
        async assemble() {
          throw new Error("Memory unavailable");
        },
      }),
    },
  });
  const host = await Host.open({
    storage: new MemoryStorage(),
    extensions,
    bindings: { context: "broken-context" },
    report: (error) => {
      reported.push(error);
    },
  });
  t.after(() => host.close());
  await channel.say("private user content");
  await until(() => channel.sent.length === 1);
  assert.equal(reported.length, 1);
  assert.equal(channel.sent[0]!.text, "Please retry.");
  const root = await host.harness.root(context);
  assert.equal(
    (await root.context(context)).messages.length,
    0,
    "Successful turns reset active context, not stored history",
  );
  assert((await root.entries({}, 30, undefined, context)).items.length > 0);
});
