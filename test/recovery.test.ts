import assert from "node:assert/strict";
import { test } from "node:test";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

function child(
  home: string,
  mode: string,
  onOutput?: (text: string, kill: () => void) => void,
) {
  const processChild = spawn(process.execPath, [
    "--import",
    "tsx",
    fileURLToPath(new URL("./crash-child.ts", import.meta.url)),
    home,
    mode,
  ]);
  let stdout = "";
  let stderr = "";
  const timer = setTimeout(() => processChild.kill("SIGKILL"), 15_000);
  processChild.stdout.on("data", (data: Buffer) => {
    stdout += data;
    onOutput?.(stdout, () => {
      processChild.kill("SIGKILL");
    });
  });
  processChild.stderr.on("data", (data: Buffer) => {
    stderr += data;
  });
  return new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
    stdout: string;
    stderr: string;
  }>((resolve, reject) => {
    processChild.on("error", reject);
    processChild.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr });
    });
  });
}

test(
  "SIGKILL recovery resumes a checkpoint without duplicating ingress or jobs",
  { timeout: 35_000 },
  async (t) => {
    const home = await mkdtemp(join(tmpdir(), "japa-crash-"));
    t.after(() => rm(home, { recursive: true, force: true }));
    const killed = await child(home, "crash", (text, kill) => {
      if (text.includes("READY")) kill();
    });
    assert.match(killed.stdout, /READY/);
    assert.equal(killed.signal, "SIGKILL");
    const recovered = await child(home, "resume");
    assert.equal(recovered.code, 0, recovered.stderr);
    const result = /^RESULT (.+)$/m.exec(recovered.stdout);
    assert(result, recovered.stdout);
    const jobs = JSON.parse(result[1]!) as { id: string; status: string }[];
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0]!.status, "completed");
    assert.equal(
      await readFile(join(home, "workspace", "result.txt"), "utf8"),
      "one idempotent result",
    );
  },
);
