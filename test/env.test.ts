import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { type ConversationId, type EnvTarget, ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import { getOrThrow } from "@earendil-works/pi-durable/env";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, expect, test } from "vitest";
import localEnv from "../extensions/local-env/index.ts";
import { CORE_CONTRACTS, type EnvironmentAdapter } from "../src/sdk.ts";
import { validateExtension } from "../src/kernel/extension.ts";
import { createEnvDispatcher, READ_ONLY_MESSAGE, readOnly } from "../src/kernel/env.ts";

const localAdapter = localEnv.provides!.environment![0] as EnvironmentAdapter;
const read = undefined as unknown as EnvTarget["read"];

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "japa-env-"));
});

test("local-env manifest is valid", () => {
  const contracts = new Map(CORE_CONTRACTS.map((c) => [c.name, c]));
  expect(validateExtension(localEnv, contracts)).toEqual([]);
  expect(localAdapter.name).toBe("local");
});

test("read-only env reads but cannot write or exec", async () => {
  writeFileSync(join(dir, "a.txt"), "hi");
  const env = readOnly(new NodeExecutionEnv({ cwd: dir }));
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

test("dispatcher wraps the root conversation only", async () => {
  const dispatch = createEnvDispatcher(new Map([["local", localAdapter]]));
  const rootEnv = await dispatch({ conversationId: ROOT_CONVERSATION_ID, cwd: dir, read } as EnvTarget, ctx);
  const otherEnv = await dispatch({ conversationId: 2 as ConversationId, cwd: dir, read } as EnvTarget, ctx);
  expect((await rootEnv!.writeFile(join(dir, "c.txt"), "x", ctx)).ok).toBe(false);
  expect((await otherEnv!.writeFile(join(dir, "c.txt"), "x", ctx)).ok).toBe(true);
});

test("dispatcher throws when the default environment is missing", async () => {
  const dispatch = createEnvDispatcher(new Map());
  await expect(async () =>
    dispatch({ conversationId: 2 as ConversationId, cwd: dir, read } as EnvTarget, ctx),
  ).rejects.toThrow('No environment "local" is installed');
});
