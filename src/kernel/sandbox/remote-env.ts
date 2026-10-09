// An out-of-process ExecutionEnv: a client of `env-server.ts`, which runs NodeExecutionEnv in another process (a job's
// sandbox).
import type { Context } from "@earendil-works/chord";
import { err, type ExecutionEnv, ExecutionError, FileError } from "@earendil-works/pi-durable/env";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

/** What a call answers once the server is gone: it was closed, or every process in the job's sandbox was killed. */
export const LOST = "The job's sandbox stopped";
/** pi-durable's `dist/env/node.js`, which `env-server.ts` loads; `dist/env/` imports only `node:` built-ins. */
export const ENV_MODULE = createRequire(import.meta.url).resolve("@earendil-works/pi-durable/env/node");
export const SERVER = fileURLToPath(new URL("./env-server.ts", import.meta.url));

export type EnvServer = {
  call(target: { cwd: string } | { handle: number }, method: string, args: unknown[], context: Context): Promise<unknown>;
  readonly closed: boolean;
  close(): void;
};

type Callback = (...args: unknown[]) => void;
type Request = { context: Context; resolve(value: unknown): void; reject(error: Error): void; callback?: Callback };

const METHODS = [
  "absolutePath", "joinPath", "readTextFile", "openTextLineReader", "readTextLines", "readBinaryFile",
  "openBinaryReader", "writeFile", "appendFile", "truncateFile", "flushFile", "renameFile", "fileInfo", "listDir",
  "openDirReader", "watch", "canonicalPath", "exists", "createDir", "remove", "createTempDir", "createTempFile",
  "cleanup", "exec",
] as const;

/** What a failed call answers: `cleanup` and `close` return nothing, `exec` an ExecutionError, the rest a FileError. */
function failure(method: string, error: unknown) {
  const message = (error as Error).message;
  if (method === "cleanup" || method === "close") return undefined;
  return err(method === "exec" ? new ExecutionError("unknown", message) : new FileError("unknown", message));
}

/** Calls `method` with `args` whose last one is the Context, answering a failure instead of throwing. */
async function invoke(server: () => Promise<EnvServer>, target: () => { cwd: string } | { handle: number }, method: string, args: unknown[]) {
  try {
    return await (await server()).call(target(), method, args.slice(0, -1), args.at(-1) as Context);
  } catch (error) {
    return failure(method, error);
  }
}

/** `value` for the server: bytes and callbacks as markers; `onCallback` receives each callback. */
function encode(value: unknown, onCallback: (callback: Callback) => void): unknown {
  if (typeof value === "function") {
    onCallback(value as Callback);
    return { $callback: true };
  }
  if (value instanceof Uint8Array) return { $bytes: Buffer.from(value).toString("base64") };
  if (Array.isArray(value)) return value.map((item) => encode(item, onCallback));
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, encode(item, onCallback)]));
}

/** Spawns `command` as the env server; calls fail with `lost` and the server's last stderr line once it dies. */
export function startEnvServer(command: string[], lost = LOST): EnvServer {
  const child = spawn(command[0]!, command.slice(1), { stdio: ["pipe", "pipe", "pipe"] });
  const requests = new Map<number, Request>();
  let lastId = 0;
  let lastStderr = "";
  let closed = false;
  const reason = () => (lastStderr ? `${lost}: ${lastStderr}` : lost);
  const send = (message: object) => child.stdin.write(`${JSON.stringify(message)}\n`);
  const onLost = () => {
    closed = true;
    for (const request of requests.values()) request.reject(new Error(reason()));
    requests.clear();
  };

  /** The server's `value`: bytes, errors, the request's `context`, and handles whose methods call the server. */
  const decode = (value: unknown, context: Context): unknown => {
    if (Array.isArray(value)) return value.map((item) => decode(item, context));
    if (typeof value !== "object" || value === null) return value;
    const v = value as Record<string, unknown>;
    if ("$bytes" in v) return new Uint8Array(Buffer.from(v.$bytes as string, "base64"));
    if ("$context" in v) return context;
    if ("$error" in v) {
      const [code, message] = [v.code as never, v.message as string];
      if (v.$error === "ExecutionError") return Object.assign(new ExecutionError(code, message), { spillPath: v.spillPath });
      return new FileError(code, message, v.path as string | undefined);
    }
    if ("$handle" in v) {
      const { $handle, methods, ...rest } = v as { $handle: number; methods: string[] };
      const handle: Record<string, unknown> = rest;
      for (const method of methods) {
        handle[method] = (...args: unknown[]) => invoke(async () => server, () => ({ handle: $handle }), method, args);
      }
      return handle;
    }
    return Object.fromEntries(Object.entries(v).map(([key, item]) => [key, decode(item, context)]));
  };

  createInterface({ input: child.stderr }).on("line", (line) => {
    if (line.trim()) lastStderr = line;
  });
  createInterface({ input: child.stdout }).on("line", (line) => {
    const message = JSON.parse(line) as { id: number; call?: unknown[]; result?: unknown; thrown?: string };
    const request = requests.get(message.id);
    if (request === undefined) return; // answered after the connection was lost
    if (message.call) request.callback!(...(decode(message.call, request.context) as unknown[]));
    else if (message.thrown !== undefined) request.reject(new Error(message.thrown));
    else request.resolve(decode(message.result, request.context));
  });
  child.on("close", onLost);
  child.on("error", onLost);
  child.stdin.on("error", onLost);

  const server: EnvServer = {
    call(target, method, args, context) {
      if (closed) return Promise.reject(new Error(reason()));
      const id = ++lastId;
      const signal = context.abortSignal;
      const cancel = () => send({ cancel: id });
      return new Promise<unknown>((resolve, reject) => {
        const request: Request = { context, resolve, reject };
        requests.set(id, request);
        const encoded = encode(args, (callback) => (request.callback = callback));
        send({ id, ...target, method, args: encoded, aborted: signal?.aborted });
        signal?.addEventListener("abort", cancel);
      }).finally(() => {
        signal?.removeEventListener("abort", cancel);
        // A watcher's callback is called until it is closed.
        if (method !== "watch") requests.delete(id);
      });
    },
    get closed() {
      return closed;
    },
    close: () => child.kill(),
  };
  return server;
}

/** The environment `id` at `cwd`, served by `server()`; one function per ExecutionEnv method. */
export function remoteEnv(server: () => Promise<EnvServer>, cwd: string, id: string): ExecutionEnv {
  const env: Record<string, unknown> & { cwd: string } = { id, cwd };
  for (const method of METHODS) {
    env[method] = (...args: unknown[]) => invoke(server, () => ({ cwd: env.cwd }), method, args);
  }
  return env as unknown as ExecutionEnv;
}
