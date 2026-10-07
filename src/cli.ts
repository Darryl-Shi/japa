import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  BACKGROUND_CONTEXT,
  withAbortSignal,
} from "@earendil-works/chord/context";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import lockfile from "proper-lockfile";
import type { Channel, Dispose } from "./core/contracts.ts";
import { Host } from "./core/host.ts";
import { defaultExtensions } from "./defaults.ts";
import { configureModels, SetupCancelled } from "./extensions/setup.ts";
import { AssistantState } from "./extensions/state.ts";
import { terminalChannel } from "./extensions/terminal.ts";
import { readTelegramConfig, telegramChannel } from "./extensions/telegram.ts";

type ChannelSession = {
  channel: Channel;
  closed: Promise<"exit" | "eof" | "settings">;
  close?: Dispose;
};

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes("--help")) {
    console.log(
      "Usage: japa [--telegram] [--safe] [--setup]\n\nFirst launch opens native provider setup in the selected interface.\n/settings reopens setup; /exit stops the terminal. Pending work resumes next time.\n--telegram uses a private owner chat configured in <JAPA_HOME>/telegram.json\n  ({token, chatId}) or TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID.\n--setup opens settings before starting; --safe skips generated extensions.\nJAPA_HOME defaults to ./.japa when running from source.\nNative provider credentials and JAPA_MODEL / JAPA_WORKER_MODEL remain supported.",
    );
    return;
  }
  if (
    args.some(
      (arg) => arg !== "--safe" && arg !== "--setup" && arg !== "--telegram",
    )
  )
    throw new Error("Unknown argument; use --help");
  const home = resolve(process.env.JAPA_HOME ?? ".japa");
  await mkdir(join(home, "workspace"), { recursive: true, mode: 0o700 });
  // Covers both Pi storage and credential refresh: one process owns this home.
  const unlock = await lockfile.lock(home, {
    stale: 10_000,
    retries: { retries: 6, minTimeout: 2_000, maxTimeout: 2_000 },
  });
  let host: Host | undefined;
  let session: ChannelSession | undefined;
  const useTelegram = args.includes("--telegram");
  const controller = new AbortController();
  let interrupt!: () => void;
  const interrupted = new Promise<"exit">((resolve) => {
    interrupt = () => {
      controller.abort();
      resolve("exit");
    };
  });
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", interrupt);
  try {
    let force = args.includes("--setup");
    while (!controller.signal.aborted) {
      session = useTelegram
        ? telegramChannel({ home, ...(await readTelegramConfig(home)) })
        : terminalChannel();
      const current = session;
      const context = withAbortSignal(controller.signal, BACKGROUND_CONTEXT);
      const models = await configureModels(
        home,
        current.channel.settings,
        context,
        { force },
      ).catch((error: unknown) => {
        if (useTelegram && error instanceof SetupCancelled) return undefined;
        throw error;
      });
      if (controller.signal.aborted) break;
      if (!models) {
        if (!useTelegram) break;
        // Keep setup reachable after logout/cancellation without resuming any
        // durable work or sending ordinary input to a model.
        const disconnected = () =>
          current.channel.settings.notify(
            "No model is connected. Send /settings to configure a provider.",
            context,
          );
        await disconnected();
        await current.channel.start(disconnected);
      } else {
        host = await Host.open({
          storage: await openNodeSqliteStorage(join(home, "japa.sqlite")),
          extensions: defaultExtensions({
            home,
            models,
            channel: current.channel,
            safe: args.includes("--safe"),
          }),
        });
        if (process.stdin.isTTY || useTelegram)
          console.log(
            `Japa is ready on ${useTelegram ? "Telegram" : "the terminal"}. /settings for setup. Workers have full access to this environment.`,
          );
      }
      const reason = await Promise.race([current.closed, interrupted]);
      if (reason === "eof" && host) {
        const state = await host.harness.snapshot(
          AssistantState,
          BACKGROUND_CONTEXT,
        );
        await Promise.race([
          Promise.all(
            Object.values(state?.receipts ?? {}).map((id) =>
              host!.harness.waitForTask(id, BACKGROUND_CONTEXT),
            ),
          ),
          interrupted,
        ]);
      }
      await host?.close();
      host = undefined;
      await current.close?.();
      session = undefined;
      if (reason !== "settings") break;
      // Stop ingress/work before prompting for credentials. Durable work resumes afterward.
      force = true;
    }
  } catch (error) {
    if (!controller.signal.aborted) throw error;
  } finally {
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", interrupt);
    try {
      await host?.close();
    } finally {
      try {
        // Settings may have started polling before a Host was ever opened.
        await session?.close?.();
      } finally {
        await unlock();
      }
    }
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
