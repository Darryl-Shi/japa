import type { Context } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { type ConversationId, type EnvTarget, ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import { getOrThrow } from "@earendil-works/pi-durable/env";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, expect, test } from "vitest";
import localEnv from "../extensions/local-env/index.ts";
import type { EnvironmentAdapter } from "../src/sdk.ts";
import { validateExtension } from "../src/kernel/extension.ts";
import { createEnvDispatcher, READ_ONLY_MESSAGE, readOnly } from "../src/kernel/env.ts";

const localAdapter = localEnv.provides!.environment![0] as EnvironmentAdapter;
const read = { snapshot: async () => undefined } as unknown as EnvTarget["read"];

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "japa-env-"));
});

test("local-env manifest is valid", () => {
  expect(validateExtension(localEnv)).toEqual([]);
  expect(localAdapter.name).toBe("local");
});

test("read-only env reads but cannot write or exec", async () => {
  writeFileSync(join(dir, "a.txt"), "hi");
  const env = readOnly(new NodeExecutionEnv({ cwd: dir }), []);
  expect(getOrThrow(await env.readTextFile(join(dir, "a.txt"), ctx))).toBe("hi");
  const w = await env.writeFile(join(dir, "b.txt"), "x", ctx);
  expect(w.ok).toBe(false);
  if (!w.ok) {
    expect(w.error.code).toBe("permission_denied");
    expect(w.error.message).toBe(READ_ONLY_MESSAGE);
    expect(w.error.path).toBe(join(dir, "b.txt"));
  }
  expect(existsSync(join(dir, "b.txt"))).toBe(false);
  const e = await env.exec("echo hi", undefined, ctx);
  expect(e.ok).toBe(false);
  if (!e.ok) expect(e.error.message).toBe(READ_ONLY_MESSAGE);
});

test("read-only env refuses reads inside a denied dir, relative to cwd", async () => {
  const secrets = join(dir, "secrets");
  mkdirSync(secrets);
  writeFileSync(join(secrets, "k"), "sk");
  writeFileSync(join(dir, "secrets-notes"), "ok");
  const env = readOnly(new NodeExecutionEnv({ cwd: dir }), [secrets]);
  for (const r of [await env.readTextFile("secrets/k", ctx), await env.listDir(secrets, ctx)]) {
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("permission_denied");
      expect(r.error.message).toBe("Secrets are not readable here.");
    }
  }
  expect(getOrThrow(await env.readTextFile("secrets-notes", ctx))).toBe("ok");
  const w = await env.writeFile(join(dir, "b.txt"), "x", ctx);
  expect(!w.ok && w.error.message).toBe(READ_ONLY_MESSAGE);
});

test("jobs get the env from the jobs callback, the root a read-only local env", async () => {
  const created: { conversationId: string; cwd?: string }[] = [];
  const local: EnvironmentAdapter = {
    name: "local",
    create: (input) => {
      created.push(input);
      return localAdapter.create(input);
    },
  };
  const asked: [ConversationId, Context][] = [];
  const jobEnv = new NodeExecutionEnv({ cwd: dir });
  const dispatch = createEnvDispatcher(local, [join(dir, "secrets")], async (conversationId, context) => {
    asked.push([conversationId, context]);
    return jobEnv;
  });

  const rootEnv = (await dispatch({ conversationId: ROOT_CONVERSATION_ID, cwd: dir, read } as EnvTarget, ctx))!;
  expect(created).toEqual([{ conversationId: String(ROOT_CONVERSATION_ID), cwd: dir }]);
  expect(asked).toEqual([]);
  const w = await rootEnv.writeFile(join(dir, "c.txt"), "x", ctx);
  expect(!w.ok && w.error.message).toBe(READ_ONLY_MESSAGE);
  const r = await rootEnv.readTextFile(join(dir, "secrets", "k"), ctx);
  expect(!r.ok && r.error.message).toBe("Secrets are not readable here.");

  // The call's context, not a background one: the job's doc is read under it.
  const context = { ...ctx };
  const env = await dispatch({ conversationId: 2 as ConversationId, cwd: dir, read } as EnvTarget, context);
  expect(env).toBe(jobEnv);
  expect(asked).toHaveLength(1);
  expect(asked[0]![0]).toBe(2);
  expect(asked[0]![1]).toBe(context);
  expect(created).toHaveLength(1);
});
