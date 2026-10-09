// The out-of-process env's server: `node env-server.ts <path of pi-durable's env/node.js>` answers the JSON-lines
// requests of `remote-env.ts` on stdin with a NodeExecutionEnv, and exits when stdin ends. Imports only `node:`
// built-ins, so it runs in the container next to a copy of pi-durable's `dist/env/`.
import { createInterface } from "node:readline";

type Target = Record<string, (...args: unknown[]) => Promise<unknown>>;
type Request = { id: number; cwd?: string; handle?: number; method: string; args: unknown[]; aborted?: boolean };

const { NodeExecutionEnv }: typeof import("@earendil-works/pi-durable/env/node") = await import(process.argv[2]!);

const handles = new Map<number, Target>();
const controllers = new Map<number, AbortController>();
let lastHandle = 0;

const send = (message: object) => process.stdout.write(`${JSON.stringify(message)}\n`);

/** `value` for the host: bytes, errors, the request's `context` and kept handles (readers, watchers) as markers. */
function encode(value: unknown, context: object): unknown {
  if (value === context) return { $context: true };
  if (value instanceof Uint8Array) return { $bytes: Buffer.from(value).toString("base64") };
  if (value instanceof Error) {
    const { name, code, message, path, spillPath } = value as Error & Record<string, unknown>;
    return { $error: name, code, message, path, spillPath };
  }
  if (Array.isArray(value)) return value.map((item) => encode(item, context));
  if (typeof value !== "object" || value === null) return value;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    handles.set(++lastHandle, value as Target);
    const methods = Object.getOwnPropertyNames(prototype).filter(
      (name) => name !== "constructor" && typeof Object.getOwnPropertyDescriptor(prototype, name)!.value === "function",
    );
    return { $handle: lastHandle, methods, ...("mode" in value ? { mode: value.mode } : {}) };
  }
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, encode(item, context)]));
}

/** The host's `value`: bytes, and callbacks that send their calls as `{ id, call }`; JSON's `null` is `undefined`. */
function decode(value: unknown, id: number, context: object): unknown {
  if (value === null) return undefined;
  if (Array.isArray(value)) return value.map((item) => decode(item, id, context));
  if (typeof value !== "object") return value;
  if ("$bytes" in value) return Buffer.from(value.$bytes as string, "base64");
  if ("$callback" in value) return (...args: unknown[]) => send({ id, call: encode(args, context) });
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, decode(item, id, context)]));
}

async function answer({ id, cwd, handle, method, args, aborted }: Request) {
  const controller = new AbortController();
  controllers.set(id, controller);
  if (aborted) controller.abort();
  const context = { abortSignal: controller.signal };
  try {
    const target = handle === undefined ? (new NodeExecutionEnv({ cwd: cwd! }) as unknown as Target) : handles.get(handle);
    if (target === undefined) {
      // A closed handle: closing again does nothing, any other call fails as on a closed reader.
      const closed = { ok: false, error: { $error: "FileError", code: "invalid", message: "Closed" } };
      return send({ id, result: method === "close" ? undefined : closed });
    }
    const result = await target[method]!(...(decode(args, id, context) as unknown[]), context);
    if (method === "close") handles.delete(handle!);
    send({ id, result: encode(result, context) });
  } catch (error) {
    send({ id, thrown: (error as Error).message });
  } finally {
    controllers.delete(id);
  }
}

createInterface({ input: process.stdin })
  .on("line", (line) => {
    const message = JSON.parse(line) as Request | { cancel: number };
    if ("cancel" in message) controllers.get(message.cancel)?.abort();
    else void answer(message);
  })
  .on("close", () => process.exit(0));
