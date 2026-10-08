#!/usr/bin/env -S node --disable-warning=ExperimentalWarning
import { runChat } from "../../extensions/gateway/chat.ts";
import { connect } from "../../extensions/gateway/client.ts";
import { socketPath } from "../../extensions/gateway/protocol.ts";
import { boot } from "../kernel/boot.ts";
import { check, CHECK_KINDS } from "../kernel/check.ts";
import { rollBack } from "../kernel/install.ts";
import { enterSafeMode } from "../kernel/safety.ts";
import { japaHome } from "../kernel/settings.ts";
import { statusText } from "../kernel/status.ts";
import type { Status } from "../kernel/contracts.ts";

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
           Restore the last working setup, and optionally the default storage and secrets adapters`;

async function daemon(home: string): Promise<void> {
  const d = await boot({ home });
  console.log(`japa is running (${socketPath(home)})`);
  for (const e of d.status().errors) console.error(`${e.name}: ${e.error}`);
  const stop = () => void d.close();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}

async function status(home: string): Promise<void> {
  const client = await connect(home);
  const s = await new Promise<Status>((resolve) => {
    client.onMessage((m) => m.type === "status" && resolve(m.status));
    client.send({ type: "status" });
  });
  client.close();
  console.log(statusText(s));
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

const commands: Record<string, (home: string) => Promise<void>> = {
  daemon,
  chat: runChat,
  status,
  check: checkCommand,
  rollback,
  "safe-mode": safeMode,
};
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
