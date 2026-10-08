// `japa setup`: the interactive wizard (first run, the rerun menu, and `--whats-new` after an update) and its
// `--non-interactive`, env-var-driven mode (design spec §4, §5.2).
import type { ModelRef } from "@earendil-works/pi-durable";
import { askedSecretNames } from "../kernel/extension.ts";
import { checkModel, loadSettings, readUserSettings, saveSettings, setPath } from "../kernel/settings.ts";
import { statusText } from "../kernel/status.ts";
import { configurable, configureStep, markOffered, unseen, type Unseen } from "./configure.ts";
import { openSetupContext, type SetupContext } from "./context.ts";
import { waitForDaemon } from "./daemon.ts";
import { APP, layoutOf } from "./layout.ts";
import { chooseModels } from "./models-step.ts";
import { Cancelled, clackPrompter, type Prompter } from "./prompt.ts";
import {
  installAction,
  installService,
  restartService,
  serviceEnv,
  type ServiceEnv,
  serviceState,
  startService,
  statusAction,
  stopService,
  unavailable,
  uninstallService,
} from "./service.ts";

export type SetupOptions = {
  interactive: boolean;
  service: boolean;
  whatsNew: boolean;
  env: NodeJS.ProcessEnv;
  serviceEnv: ServiceEnv;
  extensionDirs?: string[];
  log: (s: string) => void;
  /** How long the summary waits for the daemon's socket (design spec §4.2 step 6: 30s); shortened in tests. */
  waitMs?: number;
  /** Opens a sign-in link in a browser; default: the desktop's opener, when there is one. */
  openUrl?: (url: string) => void;
};

/** Installs and starts the background service, unless `--no-service` or there is no service manager. Returns
 * whether it started. japa is meant to keep running, so there's nothing to ask. */
async function serviceStep(o: SetupOptions): Promise<boolean> {
  if (!o.service) return false;
  const reason = await unavailable(o.serviceEnv);
  if (reason !== undefined) {
    o.log(reason);
    return false;
  }
  await installService(o.serviceEnv, o.log);
  return true;
}

/** First run's final step (design spec §4.2 step 6): what the service start achieved, or how to start it by hand. */
async function summary(ctx: SetupContext, o: SetupOptions, started: boolean, p?: Prompter): Promise<void> {
  if (!started) {
    o.log("start japa with: japa daemon");
    return;
  }
  const waiting = waitForDaemon(ctx.home, o.waitMs);
  const status = await (p ? p.wait("Starting japa", waiting) : waiting);
  if (status === undefined) {
    o.log("japa didn't answer within 30 s; see: japa service logs");
    return;
  }
  o.log(statusText(status));
}

/** `models.cos` unset (design spec §4.2): CoS model and key, extensions, the service, then the summary. */
async function firstRun(ctx: SetupContext, p: Prompter, o: SetupOptions): Promise<void> {
  await chooseModels(ctx, p, { env: o.env, openUrl: o.openUrl });
  await configureStep(ctx, p);
  const started = await serviceStep(o);
  await summary(ctx, o, started, p);
}

/** The rerun's "Service" menu item (design spec §4.3): the same actions as `japa service <...>`. */
async function serviceMenu(ctx: SetupContext, p: Prompter, o: SetupOptions): Promise<void> {
  const action = await p.select<"install" | "start" | "stop" | "uninstall" | "status">("Background service", [
    { label: "Install", value: "install", hint: "run japa in the background and start it when you log in" },
    { label: "Start", value: "start" },
    { label: "Stop", value: "stop" },
    { label: "Uninstall", value: "uninstall" },
    { label: "Status", value: "status" },
  ]);

  switch (action) {
    case "install":
      return installAction(o.serviceEnv, o.log);
    case "start":
      return startService(o.serviceEnv, o.log);
    case "stop":
      return stopService(o.serviceEnv);
    case "uninstall":
      return uninstallService(o.serviceEnv, o.log);
    case "status":
      return statusAction(o.serviceEnv, ctx.home, o.log);
  }
}

/** `models.cos` already set (design spec §4.3): a menu until Done, then an offer to restart an active service. */
async function rerun(ctx: SetupContext, p: Prompter, o: SetupOptions): Promise<void> {
  let saved = false;
  for (;;) {
    const choice = await p.select<"Models" | "Extensions" | "Service" | "Done">("What would you like to change?", [
      { label: "Model and sign-in", value: "Models", hint: "the AI provider and model japa runs on" },
      { label: "Integrations", value: "Extensions", hint: "Telegram, web search, the desktop, ..." },
      { label: "Background service", value: "Service" },
      { label: "Done", value: "Done" },
    ]);
    if (choice === "Done") break;
    if (choice === "Models") {
      if (await chooseModels(ctx, p, { env: o.env, openUrl: o.openUrl })) saved = true;
    } else if (choice === "Extensions") {
      if (await configureStep(ctx, p)) saved = true;
    } else {
      await serviceMenu(ctx, p, o);
    }
  }

  if (saved && (await serviceState(o.serviceEnv)) === "active") {
    o.log("Restarting japa to apply the changes.");
    await restartService(o.serviceEnv);
  }
}

/** One line per unseen extension or key (design spec §5.2): a brand new extension (needing secrets, or just
 * described by its summary when it has none), or a new secret or setting on one already offered. */
function unseenLines(items: Unseen[]): string[] {
  const lines: string[] = [];
  for (const { extension, keys, isNew } of items) {
    if (isNew) {
      const secrets = askedSecretNames(extension);
      lines.push(
        secrets.length > 0
          ? `New: ${extension.name} — needs ${secrets.join(", ")}`
          : `New extension: ${extension.name} — ${extension.summary}`,
      );
      continue;
    }
    for (const key of keys) {
      lines.push(
        key.startsWith("setting:")
          ? `${extension.name} has a new setting ${key.slice("setting:".length)}`
          : `${extension.name} has a new secret ${key.slice("secret:".length)}`,
      );
    }
  }
  return lines;
}

/** `--whats-new` (design spec §5.2), run by `japa update` in the new code. Never touches models. */
async function runWhatsNew(ctx: SetupContext, p: Prompter | undefined, o: SetupOptions): Promise<number> {
  const items = await unseen(ctx);
  if (items.length === 0) return 0;

  for (const line of unseenLines(items)) o.log(line);

  const extensions = items.map((i) => i.extension);
  const toConfigure = configurable(extensions); // a new extension with nothing to configure is news, nothing more
  if (toConfigure.length > 0) {
    if (o.interactive && p !== undefined) {
      await configureStep(ctx, p, toConfigure); // picking none skips
    } else {
      o.log("run `japa setup` to configure");
    }
  }

  markOffered(ctx.home, extensions);
  return 0;
}

/** `japa setup --non-interactive` (design spec §4.5): env vars only, no prompts; 1 if `models.cos` is still unset. */
async function runNonInteractive(ctx: SetupContext, o: SetupOptions): Promise<number> {
  const { JAPA_PROVIDER: provider, JAPA_MODEL: modelId, JAPA_API_KEY: apiKey } = o.env;
  if (provider !== undefined && modelId !== undefined) {
    const ref: ModelRef = { provider, modelId };
    checkModel(ctx.models, ref);
    const user = readUserSettings(ctx.home);
    setPath(user, "models.cos", ref);
    saveSettings(ctx.home, user);
    if (apiKey !== undefined) await ctx.secrets.set(`${provider}.apiKey`, apiKey.trim());
  }

  await serviceStep(o);

  markOffered(ctx.home, ctx.extensions);

  if (loadSettings(ctx.home).models.cos === undefined) {
    o.log("missing: models.cos (set JAPA_PROVIDER and JAPA_MODEL, or run japa setup in a terminal)");
    return 1;
  }
  return 0;
}

/** Runs the wizard in `home`, returning its exit code. `p` is unused (and may be undefined) outside the
 * interactive first-run/rerun flows. */
export async function runSetup(home: string, p: Prompter | undefined, o: SetupOptions): Promise<number> {
  const ctx = await openSetupContext(home, o.extensionDirs);

  if (o.whatsNew) return runWhatsNew(ctx, p, o);
  if (!o.interactive) return runNonInteractive(ctx, o);

  if (p === undefined) throw new Error("interactive setup needs a Prompter");
  if (loadSettings(home).models.cos === undefined) await firstRun(ctx, p, o);
  else await rerun(ctx, p, o);
  return 0;
}

/** The `japa setup` CLI entry point: parses flags, drives `runSetup` with a real terminal prompter when
 * interactive, and turns a cancelled prompt into the documented message and exit code. */
export async function setupCommand(home: string, args: string[]): Promise<void> {
  const interactive = !args.includes("--non-interactive") && process.stdin.isTTY === true;
  const prompter = interactive ? clackPrompter() : undefined;
  const o: SetupOptions = {
    interactive,
    service: !args.includes("--no-service"),
    whatsNew: args.includes("--whats-new"),
    env: process.env,
    serviceEnv: serviceEnv(layoutOf(APP)),
    log: prompter ? (s) => prompter.note(s) : (s) => console.log(s),
  };

  // `--whats-new` runs inside `japa update`, often with nothing to say: no frame around it.
  if (!o.whatsNew) prompter?.intro("japa setup");
  try {
    process.exitCode = await runSetup(home, prompter, o);
    if (!o.whatsNew) prompter?.close("All set. Chat with japa: japa chat");
  } catch (error) {
    if (!(error instanceof Cancelled)) throw error;
    prompter?.close("Setup stopped. Steps you finished are saved; run japa setup to continue.");
    process.exitCode = 130;
  }
}
