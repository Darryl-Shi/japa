import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { ExecutionError } from "@earendil-works/pi-durable/env";
import { registerEnvConformance } from "@earendil-works/pi-durable/testing";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, onTestFinished, test, vi } from "vitest";
import { ENV_MODULE, LOST, remoteEnv, SERVER, startEnvServer } from "../src/kernel/sandbox/remote-env.ts";

const server = startEnvServer([process.execPath, SERVER, ENV_MODULE]);
afterAll(() => server.close());

registerEnvConformance({ describe, expect, it }, "remote environment (local server)", async (use) => {
  const dir = mkdtempSync(join(tmpdir(), "japa-env-"));
  try {
    await use(remoteEnv(async () => server, dir, "test"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("calls on a lost connection fail with the lost message", async () => {
  const doomed = startEnvServer([process.execPath, "-e", "process.exit(3)"]);
  const env = remoteEnv(async () => doomed, tmpdir(), "test");
  expect(await env.readTextFile("x", ctx)).toMatchObject({
    ok: false,
    error: { code: "unknown", message: expect.stringContaining(LOST) },
  });
  const ran = await env.exec("true", undefined, ctx);
  expect(ran.ok ? undefined : ran.error).toBeInstanceOf(ExecutionError);
});

test("a lost server's calls fail with the message it was started with", async () => {
  const doomed = startEnvServer([process.execPath, "-e", "process.exit(3)"], { lost: "The test server stopped" });
  const env = remoteEnv(async () => doomed, tmpdir(), "test");
  const read = await env.readTextFile("x", ctx);
  expect(read).toMatchObject({ ok: false, error: { message: expect.stringContaining("The test server stopped") } });
  expect(read.ok ? undefined : read.error.message).not.toContain(LOST);
});

// The server's stdout is reachable from the sandbox (/proc/<pid>/fd/1): what's written there mustn't throw here.
/** A server that answers its first request with `line`; console.error is spied on until the test finishes. */
function garbledServer(line: string) {
  const script = `process.stdin.once("data", () => process.stdout.write(${JSON.stringify(`${line}\n`)})); setInterval(() => {}, 1000);`;
  const garbled = startEnvServer([process.execPath, "-e", script]);
  const logged = vi.spyOn(console, "error").mockImplementation(() => {});
  onTestFinished(() => {
    garbled.close();
    logged.mockRestore();
  });
  return { garbled, logged, env: remoteEnv(async () => garbled, tmpdir(), "test") };
}

/** `text` as a regular expression that matches it literally. */
const literal = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

test.each([
  ["not json", "Unexpected token"],
  ["null", "null"],
  ['{"id":1,"call":[1]}', "not a function"],
  ['{"id":1,"result":{"$bytes":5}}', "argument"],
])("a line the server can't have meant (%s) is logged, then fails the calls in flight like a lost server", async (
  line,
  why,
) => {
  const { garbled, logged, env } = garbledServer(line);
  const read = await env.readTextFile("x", ctx);
  expect(read).toMatchObject({ ok: false, error: { code: "unknown", message: expect.stringContaining(LOST) } });
  expect(garbled.closed).toBe(true);
  const quoted = literal(JSON.stringify(line));
  expect(logged.mock.calls).toEqual([[expect.stringMatching(new RegExp(`${why}.*: ${quoted}$`))]]);
  expect(await env.exists("/", ctx)).toMatchObject({ ok: false, error: { message: expect.stringContaining(LOST) } });
});

test("a long garbled line is logged shortened to 200 characters", async () => {
  const { logged, env } = garbledServer(`${"x".repeat(200)}${"y".repeat(1000)}`);
  expect(await env.readTextFile("x", ctx)).toMatchObject({ ok: false });
  expect(logged.mock.calls).toEqual([[expect.stringMatching(new RegExp(`: "${"x".repeat(200)}…"$`))]]);
});

// It comes from the sandbox: escape sequences would reach the terminal or journal reading the log.
test("a garbled line is logged quoted, its control characters escaped", async () => {
  const { logged, env } = garbledServer("\u001b[2J\u001b]0;pwned\u0007 forged");
  expect(await env.readTextFile("x", ctx)).toMatchObject({ ok: false });
  const [[message]] = logged.mock.calls as [[string]];
  expect(message).toMatch(/: "\\u001b\[2J\\u001b\]0;pwned\\u0007 forged"$/);
  expect(message).not.toMatch(/[\u0000-\u001f]/);
});

test("a callback that throws is logged, then fails the calls in flight like a lost server", async () => {
  const { garbled, logged, env } = garbledServer('{"id":1,"call":["out",{"$context":true},{}]}');
  const onOutput = () => {
    throw new Error("boom in the callback");
  };
  const ran = await env.exec("true", { onOutput }, ctx);
  expect(ran).toMatchObject({ ok: false, error: { message: expect.stringContaining(LOST) } });
  expect(garbled.closed).toBe(true);
  expect(logged.mock.calls).toEqual([[expect.stringMatching(/boom in the callback.*: "\{\\"id\\":1,\\"call\\":/)]]);
});

test("a server that can't be reached answers with the reason", async () => {
  const env = remoteEnv(async () => {
    throw new Error("Jobs can't run: x");
  }, "/", "test");
  expect(await env.exists("/", ctx)).toMatchObject({ ok: false, error: { message: "Jobs can't run: x" } });
});
