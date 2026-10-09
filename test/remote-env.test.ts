import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { ExecutionError } from "@earendil-works/pi-durable/env";
import { registerEnvConformance } from "@earendil-works/pi-durable/testing";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, test } from "vitest";
import { ENV_MODULE, LOST, remoteEnv, SERVER, startEnvServer } from "../src/kernel/sandbox/remote-env.ts";

const server = startEnvServer([process.execPath, SERVER, ENV_MODULE]);
afterAll(() => server.close());

registerEnvConformance({ describe, expect, it }, "desktop environment (local server)", async (use) => {
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
  const doomed = startEnvServer([process.execPath, "-e", "process.exit(3)"], "The job's sandbox stopped");
  const env = remoteEnv(async () => doomed, tmpdir(), "test");
  const read = await env.readTextFile("x", ctx);
  expect(read).toMatchObject({ ok: false, error: { message: expect.stringContaining("The job's sandbox stopped") } });
  expect(read.ok ? undefined : read.error.message).not.toContain(LOST);
});

test("a server that can't be reached answers with the reason", async () => {
  const env = remoteEnv(async () => {
    throw new Error("The desktop needs Docker: x");
  }, "/", "test");
  expect(await env.exists("/", ctx)).toMatchObject({ ok: false, error: { message: "The desktop needs Docker: x" } });
});
