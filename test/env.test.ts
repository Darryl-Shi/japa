import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { type ConversationId, type EnvTarget, ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import { getOrThrow } from "@earendil-works/pi-durable/env";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, expect, test } from "vitest";
import localEnv from "../extensions/local-env/index.ts";
import { CORE_CONTRACTS, type EnvironmentAdapter } from "../src/sdk.ts";
import { validateExtension } from "../src/kernel/extension.ts";
import { createEnvDispatcher, READ_ONLY_MESSAGE, readOnly } from "../src/kernel/env.ts";

const localAdapter = localEnv.provides!.environment![0] as EnvironmentAdapter;
/** A reader whose job conversations have `JobDoc` `doc`. */
const reading = (doc?: { jobId: string; environment: string }) =>
  ({ snapshot: async () => doc }) as unknown as EnvTarget["read"];
const read = reading();

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

test("dispatcher wraps the root conversation only", async () => {
  const dispatch = createEnvDispatcher(new Map([["local", localAdapter]]), []);
  const rootEnv = await dispatch({ conversationId: ROOT_CONVERSATION_ID, cwd: dir, read } as EnvTarget, ctx);
  const otherEnv = await dispatch({ conversationId: 2 as ConversationId, cwd: dir, read } as EnvTarget, ctx);
  expect((await rootEnv!.writeFile(join(dir, "c.txt"), "x", ctx)).ok).toBe(false);
  expect((await otherEnv!.writeFile(join(dir, "c.txt"), "x", ctx)).ok).toBe(true);
});

test("dispatcher gives a job its own environment, unwrapped", async () => {
  const created: string[] = [];
  const probe: EnvironmentAdapter = {
    name: "probe",
    create: (input) => {
      created.push(input.conversationId);
      return localAdapter.create(input);
    },
  };
  const dispatch = createEnvDispatcher(
    new Map([
      ["local", localAdapter],
      ["probe", probe],
    ]),
    [],
  );
  const job = { conversationId: 2 as ConversationId, cwd: dir, read: reading({ jobId: "1", environment: "probe" }) };
  const env = await dispatch(job as EnvTarget, ctx);
  expect(created).toEqual(["2"]);
  expect((await env!.writeFile(join(dir, "d.txt"), "x", ctx)).ok).toBe(true);
  const unknown = { ...job, read: reading({ jobId: "1", environment: "nope" }) };
  await expect(async () => dispatch(unknown as EnvTarget, ctx)).rejects.toThrow('No environment "nope" is installed');
});

test("dispatcher throws when the default environment is missing", async () => {
  const dispatch = createEnvDispatcher(new Map(), []);
  await expect(async () =>
    dispatch({ conversationId: 2 as ConversationId, cwd: dir, read } as EnvTarget, ctx),
  ).rejects.toThrow('No environment "local" is installed');
});
