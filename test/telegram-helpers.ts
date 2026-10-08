import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { vi } from "vitest";
import telegram from "../extensions/telegram/index.ts";
import type { Incoming, KernelContext, MessagingAdapter } from "../src/kernel/contracts.ts";

const API = "https://api.telegram.org";

/**
 * A fake Bot API on a local HTTP server, which `fetch` to api.telegram.org is sent to until `close()`. It records every
 * call; `fail` answers a method's next `times` calls (all, when absent) with `status` and `body`.
 */
export async function fakeBotApi() {
  const realFetch = globalThis.fetch;
  const calls: { token: string; method: string; params: any; at: number }[] = [];
  const failures = new Map<string, { status: number; body: object; times: number }>();
  const files = new Map<string, Uint8Array>();
  let queue: { update_id: number }[] = [];
  let last: object[] = [];
  let replay = false;
  let messageId = 0;

  const result = async (method: string, params: any): Promise<unknown> => {
    if (method === "sendMessage") return { message_id: ++messageId };
    if (method === "getFile") return { file_path: params.file_id };
    if (method !== "getUpdates") return true;
    queue = queue.filter((u) => u.update_id >= (params.offset ?? 0));
    if (replay && last.length > 0) {
      replay = false;
      return last;
    }
    if (queue.length > 0) return (last = queue);
    await new Promise((resolve) => setTimeout(resolve, 200));
    return [];
  };

  const server = createServer(async (req, res) => {
    const file = req.url!.match(/^\/file\/bot[^/]+\/(.+)$/);
    if (file) return void res.end(files.get(decodeURIComponent(file[1]!)));
    const [, token, method] = req.url!.match(/^\/bot([^/]+)\/(.+)$/)!;
    let body = "";
    for await (const chunk of req) body += chunk;
    const params = JSON.parse(body || "{}");
    calls.push({ token: token!, method: method!, params, at: Date.now() });
    const failure = failures.get(method!);
    const [status, json] =
      failure && failure.times-- > 0 ? [failure.status, failure.body] : [200, { ok: true, result: await result(method!, params) }];
    res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(json));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  vi.stubGlobal("fetch", (input: string | URL | Request, init?: RequestInit) =>
    String(input).startsWith(API) ? realFetch(base + String(input).slice(API.length), init) : realFetch(input, init),
  );

  return {
    calls,
    push: (...updates: object[]) => void queue.push(...(updates as { update_id: number }[])),
    replayOnce: () => void (replay = true),
    fail: (method: string, status: number, body: object, times = Infinity) =>
      void failures.set(method, { status, body, times }),
    file: (path: string, data: Uint8Array) => void files.set(path, data),
    close: async () => {
      vi.unstubAllGlobals();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

/** A `KernelContext` holding only the bot token's secret functions; `provide` sets the token and fulfils the waiters. */
export function kernelStub(token?: string) {
  let secret = token;
  let waiters: ((value: string) => void)[] = [];
  const requested: { name: string; why: string }[] = [];
  const provided = () => new Promise<string>((resolve) => waiters.push(resolve));
  const kernel = {
    secret: async () => secret,
    secretProvided: provided,
    requestSecret: async (name: string, why: string) => {
      requested.push({ name, why });
      return provided();
    },
  } as unknown as KernelContext;
  const provide = (value: string) => {
    secret = value;
    for (const resolve of waiters) resolve(value);
    waiters = [];
  };
  return { kernel, requested, provide };
}

/** Sets up the telegram extension with `stub` and starts its adapter, recording what it receives. */
export async function startTelegram(stub: ReturnType<typeof kernelStub>, receive?: (m: Incoming) => Promise<void>) {
  await telegram.setup!(stub.kernel);
  const adapter = telegram.provides!.messaging![0] as MessagingAdapter;
  const received: Incoming[] = [];
  const stop = await adapter.start({
    receive: async (m) => {
      received.push(m);
      await receive?.(m);
    },
  });
  return { adapter, received, stop };
}
