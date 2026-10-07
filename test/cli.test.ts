import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

function run(home: string, input: string, env: NodeJS.ProcessEnv = {}) {
  return new Promise<{ code: number | null; output: string }>(
    (resolveResult, reject) => {
      const child = spawn(
        process.execPath,
        ["--import", "tsx", resolve("src/cli.ts")],
        {
          env: { PATH: process.env.PATH, HOME: home, JAPA_HOME: home, ...env },
          stdio: ["pipe", "pipe", "pipe"],
          timeout: 10_000,
        },
      );
      let output = "";
      child.stdout.on("data", (chunk) => {
        output += chunk.toString();
      });
      child.stderr.on("data", (chunk) => {
        output += chunk.toString();
      });
      child.on("error", reject);
      child.on("close", (code) => resolveResult({ code, output }));
      child.stdin.end(input);
    },
  );
}

test("CLI starts and exits without a model request using environment credentials", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "japa-cli-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const key = "sk-offline-test-key-not-used-for-inference";
  const result = await run(home, "/exit\n", { OPENAI_API_KEY: key });
  assert.equal(result.code, 0, result.output);
  assert(!result.output.includes(key));
  const settings = await readFile(join(home, "settings.json"), "utf8");
  assert(!settings.includes(key));
  assert.equal(JSON.parse(settings).root.provider, "openai");
  assert((await readdir(home)).includes("japa.sqlite"));
  assert.equal(await readFile(join(home, "MEMORY.md"), "utf8"), "");
});

test("CLI refuses to treat piped conversation text as setup credentials", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "japa-cli-no-auth-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const text = "do-not-log-or-use-this-as-a-provider-key";
  const result = await run(home, `${text}\n`);
  assert.equal(result.code, 1);
  assert.match(result.output, /interactive terminal/);
  assert(!result.output.includes(text));
  assert(!(await readdir(home)).includes("japa.sqlite"));
  assert(!(await readdir(home)).includes("credentials.json"));
});
