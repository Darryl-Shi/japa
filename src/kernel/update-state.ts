// The record of an update started from chat (design doc §4.2): `<home>/update.json`, written by the daemon when it
// starts one and by the detached `japa update --from-chat` as it goes, and read by whichever daemon reports it.
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isAlive } from "./lock.ts";

/** How `japa update` restarted japa: the service, not at all because a foreground daemon runs (it's told to restart
 * itself) or the service is stopped, or not at all because there is neither. */
export type Restarted = "service" | "foreground" | "stopped" | "none";

export type UpdateState = {
  state: "running" | "updated" | "up to date" | "failed";
  /** The `japa update` process, which writes it first thing; none yet while it starts. */
  pid?: number;
  started: number;
  finished?: number;
  /** The chat that asked, which gets the report. */
  chat: { adapter: string; chat: string };
  /** Full shas: where the checkout stood, and where it went (or, when up to date, stays). */
  from: string;
  to?: string;
  /** This run was a Roll back. */
  rollback: boolean;
  restarted?: Restarted;
  /** A failure's one-line reason and the output of the command that failed. */
  summary?: string;
  output?: string;
  /** The newest 20 new commits, as `<short sha> <subject>`, and the new code's what's new lines. */
  commits?: string[];
  whatsNew?: string[];
  reported: boolean;
};

/** What an update would bring in: full shas, and the commits as "abc1234 subject", newest first. */
export type UpdateCheck = { current: string; target: string; commits: string[] };

/** Checks for and launches updates, for the chat's /update (injected by the CLI, which owns `japa update`). */
export type Updater = {
  check(): Promise<UpdateCheck>;
  /** Starts `japa update --to <to> --from-chat` detached: fast-forward only, unless it's a Roll back. */
  launch(to: string, rollback: boolean): Promise<void>;
};

const STATES: readonly string[] = ["running", "updated", "up to date", "failed"];

/** A running update with no pid this long after it started never got going. */
const START_MS = 60_000;

export const updateFile = (home: string) => join(home, "update.json");
export const updateLog = (home: string) => join(home, "logs", "update.log");

/** Whether `value` has the fields every reader relies on. */
function isUpdateState(value: unknown): value is UpdateState {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const s = value as Record<string, unknown>;
  const chat = s.chat as Record<string, unknown> | null | undefined;
  return (
    typeof s.state === "string" &&
    STATES.includes(s.state) &&
    typeof s.started === "number" &&
    typeof chat === "object" &&
    chat !== null &&
    typeof chat.adapter === "string" &&
    typeof chat.chat === "string" &&
    typeof s.from === "string" &&
    typeof s.rollback === "boolean" &&
    typeof s.reported === "boolean"
  );
}

/** The recorded update; undefined when there is none or the file can't be read as one. */
export function readUpdateState(home: string): UpdateState | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(updateFile(home), "utf8"));
  } catch {
    return undefined;
  }
  return isUpdateState(parsed) ? parsed : undefined;
}

/** Replaces the record atomically: a temp file beside it, renamed over it, so a reader never sees half of one. */
export function writeUpdateState(home: string, state: UpdateState): void {
  const file = updateFile(home);
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(state, null, 2)}\n`);
  renameSync(temp, file);
}

/** Merges `patch` into the record; without one (or with an unreadable one) there is nothing to update. */
export function patchUpdateState(home: string, patch: Partial<UpdateState>): void {
  const state = readUpdateState(home);
  if (state !== undefined) writeUpdateState(home, { ...state, ...patch });
}

/** "running", "interrupted" (its pid is dead, or it has none 60 s after it started) or "finished". */
export function liveness(
  state: UpdateState,
  now: number,
  alive: (pid: number) => boolean = isAlive,
): "running" | "interrupted" | "finished" {
  if (state.state !== "running") return "finished";
  if (state.pid === undefined) return now - state.started > START_MS ? "interrupted" : "running";
  return alive(state.pid) ? "running" : "interrupted";
}
