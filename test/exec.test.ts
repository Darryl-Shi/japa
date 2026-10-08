import { expect, test } from "vitest";
import { exec } from "../src/cli/exec.ts";

test("exec runs a command and captures its exit code, stdout and stderr", async () => {
  const result = await exec(process.execPath, ["-e", "console.log('out'); console.error('err'); process.exitCode = 3;"]);
  expect(result).toEqual({ code: 3, stdout: "out\n", stderr: "err\n" });
});

test("exec never throws: a command that can't be spawned resolves with code 127", async () => {
  const result = await exec("japa-definitely-not-a-real-command", ["--version"]);
  expect(result).toEqual({ code: 127, stdout: "", stderr: "" });
});
