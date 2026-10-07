import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  BACKGROUND_CONTEXT,
  withAbortSignal,
} from "@earendil-works/chord/context";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import lockfile from "proper-lockfile";
import { Host } from "./core/host.ts";
import { defaultExtensions } from "./defaults.ts";
import { configureModels } from "./extensions/setup.ts";
import { AssistantState } from "./extensions/state.ts";
import { terminalChannel } from "./extensions/terminal.ts";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes("--help")) {
    console.log(
      "Usage: japa [--safe] [--setup]\n\nFirst launch opens provider login/API-key setup in the interface.\n/settings reopens setup; /exit stops. Pending jobs and wakes resume next time.\n--setup opens settings before starting; --safe skips generated extensions.\nJAPA_HOME defaults to ./.japa when running from source.\nOPENAI_API_KEY / ANTHROPIC_API_KEY and JAPA_MODEL / JAPA_WORKER_MODEL remain supported.",
    );
    return;
  }
  if (args.some((arg) => arg !== "--safe" && arg !== "--setup"))
    throw new Error("Unknown argument; use --help");
  const home = resolve(process.env.JAPA_HOME ?? ".japa");
  await mkdir(join(home, "workspace"), { recursive: true, mode: 0o700 });
  // Covers both Pi storage and credential refresh: one process owns this home.
  const unlock = await lockfile.lock(home, {
    stale: 10_000,
    retries: { retries: 6, minTimeout: 2_000, maxTimeout: 2_000 },
  });
  let host: Host | undefined;
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
      const terminal = terminalChannel();
      const models = await configureModels(
        home,
        terminal.channel.settings,
        withAbortSignal(controller.signal, BACKGROUND_CONTEXT),
        { force },
      );
      if (controller.signal.aborted || !models) break;
      host = await Host.open({
        storage: await openNodeSqliteStorage(join(home, "japa.sqlite")),
        extensions: defaultExtensions({
          home,
          models,
          channel: terminal.channel,
          safe: args.includes("--safe"),
        }),
      });
      if (process.stdin.isTTY)
        console.log(
          "Japa is ready. /settings for setup; /exit to stop. Workers have full access to this environment.",
        );
      const reason = await Promise.race([terminal.closed, interrupted]);
      if (reason === "eof") {
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
      await host.close();
      host = undefined;
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
      await unlock();
    }
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
