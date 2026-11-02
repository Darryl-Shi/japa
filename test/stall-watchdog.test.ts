import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

const MODULE = fileURLToPath(new URL("../src/cli/stall-watchdog.ts", import.meta.url));

/** Runs `body` in a child Node process that starts the watchdog (stalls after 1 s); answers how it ended. */
function child(body: string, env: Record<string, string> = {}) {
  const script = `import { watchForStalls } from ${JSON.stringify(MODULE)};
watchForStalls({ stallMs: 1000, checkMs: 100, beatMs: 50 });
${body}`;
  return new Promise<{ code: number | null; signal: NodeJS.Signals | null; stderr: string; ms: number }>((resolve) => {
    const started = Date.now();
    const proc = spawn(process.execPath, ["--input-type=module", "-e", script], { env: { ...process.env, ...env } });
    let stderr = "";
    proc.stderr.on("data", (chunk: Buffer) => (stderr += chunk));
    proc.on("close", (code, signal) => resolve({ code, signal, stderr, ms: Date.now() - started }));
  });
}

/** Blocks the event loop for `ms`, then prints "unblocked". */
const block = (ms: number) => `const end = Date.now() + ${ms}; while (Date.now() < end) {} console.log("unblocked");`;

test("a daemon whose event loop is stuck is killed, with a line saying why", async () => {
  const ended = await child(block(10_000));
  expect(ended.signal).toBe("SIGKILL");
  expect(ended.ms).toBeLessThan(6_000);
  expect(ended.stderr).toContain("japa: the daemon stopped responding for 1 s; ending it so that it restarts");
});

test("a turning event loop is left alone, and the watchdog doesn't keep the process alive", async () => {
  const ended = await child("let n = 0; const t = setInterval(() => { if (++n === 30) clearInterval(t); }, 100);");
  expect({ code: ended.code, signal: ended.signal, stderr: ended.stderr }).toEqual({ code: 0, signal: null, stderr: "" });
});

test("JAPA_STALL_WATCHDOG=0 turns it off", async () => {
  const ended = await child(block(2_000), { JAPA_STALL_WATCHDOG: "0" });
  expect({ code: ended.code, signal: ended.signal }).toEqual({ code: 0, signal: null });
});
