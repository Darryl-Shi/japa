// A non-throwing child-process runner. Service management, `npm ci` and `update`'s git calls inject this (or a fake
// in tests); production code uses `exec` below.
import { spawn } from "node:child_process";

export type ExecResult = { code: number; stdout: string; stderr: string };
export type Exec = (
  cmd: string,
  args: string[],
  opts?: { cwd?: string; env?: NodeJS.ProcessEnv; stdio?: "inherit" },
) => Promise<ExecResult>;

/** Runs `cmd args`. Never rejects: a command that can't even be spawned (e.g. not found) resolves with `code: 127`. */
export const exec: Exec = (cmd, args, opts = {}) =>
  new Promise((resolve) => {
    const inherit = opts.stdio === "inherit";
    const child = spawn(cmd, args, { cwd: opts.cwd, env: opts.env, stdio: inherit ? "inherit" : ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk: Buffer) => (stdout += chunk));
    child.stderr?.on("data", (chunk: Buffer) => (stderr += chunk));
    child.on("error", () => resolve({ code: 127, stdout, stderr }));
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
