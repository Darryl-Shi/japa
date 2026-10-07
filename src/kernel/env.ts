import { type EnvTarget, type HarnessOptions, ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import { err, type ExecutionEnv, ExecutionError, FileError } from "@earendil-works/pi-durable/env";
import type { EnvironmentAdapter } from "./contracts.ts";
import { JobDoc } from "./jobs/state.ts";

export const READ_ONLY_MESSAGE = "Read-only here: delegate changes and commands to a job.";

const WRITE_METHODS = new Set<PropertyKey>([
  "writeFile",
  "appendFile",
  "truncateFile",
  "renameFile",
  "createDir",
  "remove",
  "createTempDir",
  "createTempFile",
]);

/** `env` with every write and `exec` failing with `READ_ONLY_MESSAGE`; reads pass through. */
export function readOnly(env: ExecutionEnv): ExecutionEnv {
  return new Proxy(env, {
    get(target, key, receiver) {
      if (WRITE_METHODS.has(key)) {
        return async (path: unknown) =>
          err(new FileError("permission_denied", READ_ONLY_MESSAGE, typeof path === "string" ? path : undefined));
      }
      if (key === "exec") return async () => err(new ExecutionError("unknown", READ_ONLY_MESSAGE));
      const value = Reflect.get(target, key, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

/** The Harness `env` option: the default environment, read-only for the CoS (root); a job's own environment. */
export function createEnvDispatcher(
  environments: ReadonlyMap<string, EnvironmentAdapter>,
  defaultName = "local",
): NonNullable<HarnessOptions["env"]> {
  const create = (name: string, target: EnvTarget) => {
    const adapter = environments.get(name);
    if (adapter === undefined) throw new Error(`No environment "${name}" is installed`);
    return adapter.create({ conversationId: String(target.conversationId), cwd: target.cwd });
  };
  return async (target, context) => {
    if (target.conversationId === ROOT_CONVERSATION_ID) return readOnly(create(defaultName, target));
    const job = await target.read.snapshot(JobDoc, target.conversationId, context);
    return create(job?.environment || defaultName, target);
  };
}
