import type { MessagingContext, OutgoingMessage } from "../../contracts.ts";
import { liveness, type UpdateCheck } from "../../update-state.ts";
import { alreadyRunning, interruptedReport, short } from "../update-report.ts";
import type { Nav, Page } from "./nav.ts";

/** Shown while /update checks, then replaced by what it found. */
export const CHECKING = "Checking for updates…";
/** New commits the screen lists; the rest are counted. */
const LISTED = 20;
const UPDATING: OutgoingMessage = { markdown: "Updating… japa will restart and report back here." };

type Chat = { adapter: string; chat: string };

/** `N <what>`, an `s` added unless N is 1. */
const count = (n: number, what: string) => `${n} ${what}${n === 1 ? "" : "s"}`;

/**
 * The /update screen (design doc §4.1), asked in `chat`. While an update runs it says so; an interrupted one not yet
 * reported is reported here (`home`'s update log) and marked so. Otherwise it checks: up to date, or the new commits
 * (the newest `LISTED`, then how many more) and how many jobs are active, with `Update now`, which starts the update
 * to the commit checked (whatever origin has by then), and `Cancel`.
 */
export function updateMenu(
  nav: Nav,
  messaging: MessagingContext,
  activeJobs: () => number,
  chat: Chat,
  home: string,
): Page {
  const offer = ({ current, target, commits }: UpdateCheck): Page => async (outcome) => {
    const more = commits.length - LISTED;
    const listed = [...commits.slice(0, LISTED), ...(more > 0 ? [`+${more} more`] : [])].join("\n");
    const restart = `japa will restart; ${count(activeJobs(), "job")} active.`;
    const body = [`${short(current)} → ${short(target)}`, listed, restart].filter((p) => p !== "").join("\n\n");
    const start: Page = async () => {
      await messaging.update.start(chat, current, target, false);
      return UPDATING;
    };
    const cancel: Page = async () => ({ markdown: "Update cancelled." });
    const rows = [[nav.button("Update now", start)], [nav.button("Cancel", cancel)]];
    return nav.screen({ title: count(commits.length, "new commit"), body, rows, outcome });
  };
  return async (outcome) => {
    const state = await messaging.update.state();
    const now = Date.now();
    const live = state === undefined ? undefined : liveness(state, now);
    if (live === "running") return { markdown: alreadyRunning(state!, now) };
    if (live === "interrupted" && !state!.reported) {
      await messaging.update.markReported(state!.started);
      return interruptedReport(home);
    }
    const check = await messaging.update.check();
    if (check.current === check.target) return { markdown: `✓ japa is up to date (${short(check.current)})` };
    return nav.show(offer(check), outcome); // the screen an error pressing its buttons is shown on
  };
}

/**
 * The confirmation a report's Roll back button asks, in `chat`: `Roll back` starts the update back to `to` (from the
 * commit japa is on now) as a Roll back; `Cancel` ends it.
 */
export function rollbackConfirm(nav: Nav, messaging: MessagingContext, chat: Chat, to: string): Page {
  const roll: Page = async () => {
    const { current } = await messaging.update.check();
    await messaging.update.start(chat, current, to, true);
    return UPDATING;
  };
  const cancel: Page = async () => ({ markdown: "Roll back cancelled." });
  return async (outcome) =>
    nav.screen({
      title: `Roll back to ${short(to)}? japa will restart.`,
      rows: [[nav.button("Roll back", roll)], [nav.button("Cancel", cancel)]],
      outcome,
    });
}
