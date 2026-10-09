import type { Context } from "@earendil-works/chord";
import { type ConversationId, type HarnessOptions, ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import { err, type ExecutionEnv, ExecutionError, FileError } from "@earendil-works/pi-durable/env";
import { resolve, sep } from "node:path";
import type { EnvironmentAdapter } from "./contracts.ts";

export const READ_ONLY_MESSAGE = "Read-only here: delegate changes and commands to a job.";

const SECRETS_MESSAGE = "Secrets are not readable here.";

/** How `readOnly` treats each `ExecutionEnv` method: typed over all of them, so a new one must be classified. */
const ACCESS: Record<Exclude<keyof ExecutionEnv, "id" | "cwd">, "read" | "write" | "exec" | "pass"> = {
  absolutePath: "pass",
  joinPath: "pass",
  readTextFile: "read",
  openTextLineReader: "read",
  readTextLines: "read",
  readBinaryFile: "read",
  openBinaryReader: "read",
  writeFile: "write",
  appendFile: "write",
  truncateFile: "write",
  flushFile: "write",
  renameFile: "write",
  fileInfo: "read",
  listDir: "read",
  openDirReader: "read",
  watch: "pass",
  canonicalPath: "read",
  exists: "read",
  createDir: "write",
  remove: "write",
  createTempDir: "write",
  createTempFile: "write",
  cleanup: "pass",
  exec: "exec",
};

/**
 * `env` with every write and `exec` failing with `READ_ONLY_MESSAGE`, and every read of a path inside a `deny`
 * dir (resolved against `env.cwd`) failing with `SECRETS_MESSAGE`; other reads pass through.
 */
export function readOnly(env: ExecutionEnv, deny: string[]): ExecutionEnv {
  const denied = (path: string) => {
    const p = resolve(env.cwd, path);
    return deny.some((dir) => p === resolve(dir) || p.startsWith(resolve(dir) + sep));
  };
  return new Proxy(env, {
    get(target, key, receiver) {
      const access = ACCESS[key as keyof typeof ACCESS];
      if (access === "write") {
        return async (path: unknown) =>
          err(new FileError("permission_denied", READ_ONLY_MESSAGE, typeof path === "string" ? path : undefined));
      }
      if (access === "exec") return async () => err(new ExecutionError("unknown", READ_ONLY_MESSAGE));
      const value = Reflect.get(target, key, receiver);
      if (access === "read") {
        return async (path: string, ...rest: unknown[]) =>
          denied(path) ? err(new FileError("permission_denied", SECRETS_MESSAGE, path)) : value.call(target, path, ...rest);
      }
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

/**
 * The Harness `env` option: for the CoS (root), the `local` environment, read-only and with the `deny` dirs
 * unreadable; for any other conversation, a job's, the environment `jobs` gives (its sandbox), under the call's context.
 */
export function createEnvDispatcher(
  local: EnvironmentAdapter,
  deny: string[],
  jobs: (conversationId: ConversationId, context: Context) => Promise<ExecutionEnv>,
): NonNullable<HarnessOptions["env"]> {
  return async (target, context) => {
    if (target.conversationId !== ROOT_CONVERSATION_ID) return jobs(target.conversationId, context);
    return readOnly(local.create({ conversationId: String(target.conversationId), cwd: target.cwd }), deny);
  };
}
