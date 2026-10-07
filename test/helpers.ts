import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { TestContext } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import type { FauxResponseFactory } from "@earendil-works/pi-ai/providers/faux";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import type {
  Channel,
  Incoming,
  ModelProvider,
  PolicyDecision,
} from "../src/core/contracts.ts";
import { Host } from "../src/core/host.ts";
import type { Extension } from "../src/core/host.ts";
import { defaultExtensions } from "../src/defaults.ts";

export const context = BACKGROUND_CONTEXT;

export function scriptedModels(route: FauxResponseFactory): ModelProvider {
  const faux = fauxProvider({ models: [{ id: "root" }, { id: "worker" }] });
  faux.setResponses(Array.from({ length: 200 }, () => route));
  const models = createModels();
  models.setProvider(faux.provider);
  return {
    models,
    root: { provider: "faux", modelId: "root" },
    worker: { provider: "faux", modelId: "worker" },
  };
}

export function testChannel() {
  const sent: { text: string; key: string; recipient: string }[] = [];
  let receive!: (message: Incoming) => Promise<void>;
  const channel: Channel = {
    settings: {
      async prompt() {
        throw new Error("Unexpected settings prompt");
      },
      async notify() {},
    },
    async start(handler) {
      receive = handler;
      return () => {};
    },
    async send(address, message, key) {
      if (!sent.some((item) => item.key === key))
        sent.push({ ...message, key, recipient: address.recipient });
    },
  };
  return {
    channel,
    sent,
    say: (
      text: string,
      id: string = crypto.randomUUID(),
      recipient = "owner",
    ) => receive({ id, text, address: { channel: "test", recipient } }),
  };
}

export async function until(
  check: () => boolean | Promise<boolean>,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() >= deadline)
      throw new Error("Timed out waiting for test condition");
    await delay(5);
  }
}

export async function fixture(
  t: TestContext,
  route: FauxResponseFactory,
  options: {
    sqlite?: boolean;
    extras?: Extension[];
    rules?: Record<string, PolicyDecision>;
    jobTimeoutMs?: number;
  } = {},
) {
  const home = await mkdtemp(join(tmpdir(), "japa-test-"));
  await mkdir(join(home, "workspace"));
  const channel = testChannel();
  const errors: unknown[] = [];
  const open = async () =>
    Host.open({
      storage: options.sqlite
        ? await openNodeSqliteStorage(join(home, "japa.sqlite"))
        : new MemoryStorage(),
      extensions: [
        ...defaultExtensions({
          home,
          models: scriptedModels(route),
          channel: channel.channel,
          rules: options.rules,
          jobTimeoutMs: options.jobTimeoutMs,
        }),
        ...(options.extras ?? []),
      ],
      settings: { retry: { enabled: false }, compaction: { enabled: false } },
      report: (error) => {
        errors.push(error);
      },
    });
  let host = await open();
  t.after(async () => {
    await host.close();
    await rm(home, { recursive: true, force: true });
  });
  return {
    home,
    ...channel,
    errors,
    get host() {
      return host;
    },
    async reopen() {
      await host.close();
      host = await open();
      return host;
    },
  };
}

export function abortable<T>(
  promise: Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  if (!signal) return promise;
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason ?? new Error("Aborted"));
    if (signal.aborted) {
      abort();
      return;
    }
    signal.addEventListener("abort", abort, { once: true });
    void promise
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", abort));
  });
}
