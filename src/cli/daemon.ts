// The daemon's status over the socket, used by `japa status` and by `japa service` (and setup/update/uninstall) to
// tell a live foreground `japa daemon` apart from the service-managed one.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { connect } from "../../extensions/gateway/client.ts";
import type { Status } from "../kernel/contracts.ts";
import { isAlive } from "../kernel/lock.ts";

/** Asks the running daemon for its status over the socket. Rejects "japa is not running..." if it isn't. */
export async function daemonStatus(home: string): Promise<Status> {
  const client = await connect(home);
  const status = await new Promise<Status>((resolve) => {
    client.onMessage((m) => m.type === "status" && resolve(m.status));
    client.send({ type: "status" });
  });
  client.close();
  return status;
}

/** Retries `daemonStatus` every 500 ms until it answers or `ms` elapses; undefined if it never does. */
export async function waitForDaemon(home: string, ms = 30_000): Promise<Status | undefined> {
  const deadline = Date.now() + ms;
  for (;;) {
    try {
      return await daemonStatus(home);
    } catch {
      if (Date.now() >= deadline) return undefined;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
}

/** The pid in `<home>/daemon.lock`, if that process is alive — a `japa daemon` running in the foreground. */
export function foregroundPid(home: string): number | undefined {
  let text: string;
  try {
    text = readFileSync(join(home, "daemon.lock"), "utf8");
  } catch {
    return undefined;
  }
  const pid = Number(text.trim());
  return isAlive(pid) ? pid : undefined;
}
