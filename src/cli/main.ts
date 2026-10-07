#!/usr/bin/env -S node --disable-warning=ExperimentalWarning
import { runChat } from "../../extensions/gateway/chat.ts";
import { connect } from "../../extensions/gateway/client.ts";
import { socketPath } from "../../extensions/gateway/protocol.ts";
import { boot } from "../kernel/boot.ts";
import { check, CHECK_KINDS } from "../kernel/check.ts";
import { rollBack } from "../kernel/install.ts";
import { japaHome } from "../kernel/settings.ts";
import type { Status } from "../kernel/contracts.ts";

const USAGE = `Usage: japa <command>

Commands:
  daemon   Run japa in the foreground
  chat     Chat with japa
  status   Show the model, extensions, and errors
  check <skill|worker|extension> <name>
           Check a skill, worker profile or extension in the current directory
  rollback <skill|worker|extension> <name> [to]
           Roll it back to its last known good version, or to the git ref to`;

async function daemon(home: string): Promise<void> {
  const d = await boot({ home });
  console.log(`japa is running (${socketPath(home)})`);
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
  console.log(`model: ${s.model ? `${s.model.provider}/${s.model.modelId}` : "none"}`);
  console.log("extensions:");
  for (const e of s.extensions) console.log(`  ${e.name} — ${e.summary}`);
  if (s.errors.length > 0) console.log("errors:");
  for (const e of s.errors) console.log(`  ${e.name}: ${e.error}`);
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
  rollBack(home, known, name, to);
  console.log("Rolled back. Restart the daemon to apply.");
}

const commands: Record<string, (home: string) => Promise<void>> = {
  daemon,
  chat: runChat,
  status,
  check: checkCommand,
  rollback,
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
