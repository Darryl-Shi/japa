// The chat's report of an update started from chat (design doc §4.5): sent by the messaging surface to the chat that
// asked, once `update.json` records how it ended.
import type { OutgoingMessage } from "../contracts.ts";
import { type Restarted, type UpdateState, updateLog } from "../update-state.ts";
import { ago } from "./menu/nav.ts";

/** A report's Roll back button's action is this, then the full sha to go back to: not tied to the menu's per-run token,
 * it outlives the restart it reports. */
export const ROLLBACK = "rb:";

/** `japa setup --whats-new`'s pointer to the terminal: the report points to /settings instead. */
const RUN_SETUP = "run `japa setup` to configure";

/** What the owner still has to do, by how `japa update` restarted japa. */
const RESTART: Partial<Record<Restarted, string>> = {
  foreground: "Restart `japa daemon` to apply.",
  stopped: "japa's service is stopped; start it with `japa service start`.",
};

export const short = (sha: string) => sha.slice(0, 7);

/**
 * A finished update's report. Updated: `✓ Updated <from> → <to>` (`✓ Rolled back …` for a Roll back), the new commits,
 * what's new, then what is left to do to run the new code, with a Roll back button unless it was one. Failed:
 * `✗ <summary>`, then the output of the command that failed in a code block. Up to date: `✓ japa is up to date
 * (<sha>)`. A record still running is reported as interrupted.
 */
export function updateReport(state: UpdateState, home: string): OutgoingMessage {
  if (state.state === "running") return interruptedReport(home);
  const to = state.to ?? state.from;
  if (state.state === "up to date") return { markdown: `✓ japa is up to date (${short(to)})` };
  if (state.state === "failed") {
    const summary = `✗ ${state.summary ?? `The update failed; see \`${updateLog(home)}\`.`}`;
    return { markdown: state.output ? `${summary}\n\n\`\`\`\n${state.output}\n\`\`\`` : summary };
  }
  const parts = [`✓ ${state.rollback ? "Rolled back" : "Updated"} ${short(state.from)} → ${short(to)}`];
  if (state.commits?.length) parts.push(state.commits.join("\n"));
  const news = (state.whatsNew ?? []).filter((line) => line !== RUN_SETUP);
  if (news.length > 0) parts.push(`New:\n${news.join("\n")}`, "Configure them in /settings.");
  const restart = state.restarted === undefined ? undefined : RESTART[state.restarted];
  if (restart !== undefined) parts.push(restart);
  const markdown = parts.join("\n\n");
  if (state.rollback) return { markdown };
  return { markdown, buttons: [[{ label: "Roll back", action: `${ROLLBACK}${state.from}` }]] };
}

/** Why another update can't start while `state`, started earlier, runs (at `now`). */
export const alreadyRunning = (state: UpdateState, now: number) =>
  `An update is already running (started ${ago(now - state.started)} ago).`;

/** The report of an update that stopped before recording how it ended. */
export function interruptedReport(home: string): OutgoingMessage {
  return { markdown: `✗ The update was interrupted; see \`${updateLog(home)}\`.` };
}
