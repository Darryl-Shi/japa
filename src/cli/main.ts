#!/usr/bin/env -S node --disable-warning=ExperimentalWarning
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runChat } from "../../extensions/gateway/chat.ts";
import { socketPath } from "../../extensions/gateway/protocol.ts";
import { boot } from "../kernel/boot.ts";
import { check, CHECK_KINDS } from "../kernel/check.ts";
import { rollBack } from "../kernel/install.ts";
import { enterSafeMode } from "../kernel/safety.ts";
import { japaHome } from "../kernel/settings.ts";
import { statusText } from "../kernel/status.ts";
import { daemonStatus } from "./daemon.ts";
import { APP, layoutOf } from "./layout.ts";
import { tuiPrompter } from "./prompt.ts";
import { serviceCommand, serviceEnv } from "./service.ts";
import { setupCommand } from "./setup.ts";
import { uninstall } from "./uninstall.ts";
import { updateCommand } from "./update.ts";

const USAGE = `Usage: japa <command>

Commands:
  daemon   Run japa in the foreground
  chat     Chat with japa
  status   Show the model, extensions, and errors
  check <skill|worker|extension> <name>
           Check a skill, worker profile or extension in the current directory
  rollback <skill|worker|extension> <name> [to]
           Roll it back to its last known good version, or to the git ref to
  safe-mode [--default-adapters]
           Restore the last working setup, and optionally the default storage and secrets adapters
  service <install|uninstall|start|stop|restart|status|logs>
           Run japa in the background: a systemd user service (Linux) or launchd agent (macOS)
  setup [--non-interactive] [--no-service]
           Configure models, extensions and the background service
  update [--check] [--branch <b>] [--to <sha>] [--no-restart]
           Update japa to origin's latest commit and restart it
  uninstall [--purge]
           Remove japa; --purge also deletes the japa home once you type "delete"
  --version  Print the version and git commit`;

async function daemon(home: string): Promise<void> {
  const d = await boot({ home });
  console.log(`japa is running (${socketPath(home)})`);
  for (const e of d.status().errors) console.error(`${e.name}: ${e.error}`);
  const stop = () => void d.close();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}

async function status(home: string): Promise<void> {
  console.log(statusText(await daemonStatus(home)));
}

async function checkCommand(home: string): Promise<void> {
  const [kind, name] = process.argv.slice(3);
  const known = CHECK_KINDS.find((k) => k === kind);
  if (known === undefined || name === undefined) throw new Error("Usage: japa check <skill|worker|extension> <name>");
  const problems = await check(known, name, process.cwd(), home);
  console.log(problems.length === 0 ? "ok" : problems.join("\n"));
  if (problems.length > 0) process.exitCode = 1;
}

async function rollback(home: string): Promise<void> {
  const [kind, name, to] = process.argv.slice(3);
  const known = CHECK_KINDS.find((k) => k === kind);
  if (known === undefined || name === undefined) throw new Error("Usage: japa rollback <skill|worker|extension> <name> [to]");
  const sha = rollBack(home, known, name, to);
  console.log(sha === undefined ? "Nothing to roll back." : "Rolled back. Restart the daemon to apply.");
}

async function safeMode(home: string): Promise<void> {
  const restored = enterSafeMode(home, { defaultAdapters: process.argv.includes("--default-adapters") });
  console.log(restored === undefined ? "Already at the last working setup." : "Restored the last working setup. Start the daemon with: japa daemon");
}

async function uninstallCommand(home: string): Promise<void> {
  const layout = layoutOf(APP);
  await uninstall(layout, home, {
    purge: process.argv.includes("--purge"),
    confirm: async () => {
      const prompter = tuiPrompter();
      try {
        return await prompter.text(`Type "delete" to permanently remove ${home}`);
      } finally {
        prompter.close();
      }
    },
    serviceEnv: serviceEnv(layout),
    log: (s) => console.log(s),
  });
}

/** `japa <package.json version> (<short HEAD sha in APP, or "unknown">)`. */
function versionText(): string {
  const pkg = JSON.parse(readFileSync(join(APP, "package.json"), "utf8")) as { version: string };
  let sha = "unknown";
  try {
    sha = execFileSync("git", ["-C", APP, "rev-parse", "--short", "HEAD"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    // Not a git checkout (e.g. an extracted tarball) or git is missing: "unknown" stands.
  }
  return `japa ${pkg.version} (${sha})`;
}

const commands: Record<string, (home: string) => Promise<void>> = {
  daemon,
  chat: runChat,
  status,
  check: checkCommand,
  rollback,
  "safe-mode": safeMode,
  service: (home) => serviceCommand(home, process.argv.slice(3)),
  setup: (home) => setupCommand(home, process.argv.slice(3)),
  update: (home) => updateCommand(home, process.argv.slice(3)),
  uninstall: uninstallCommand,
};
if (process.argv[2] === "--version") {
  console.log(versionText());
} else {
  const command = commands[process.argv[2]];
  if (command === undefined) {
    console.error(USAGE);
    process.exitCode = 1;
  } else {
    command(japaHome()).catch((error: Error) => {
      console.error(error.message);
      process.exit(1);
    });
  }
}
