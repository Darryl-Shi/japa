import { randomUUID } from "node:crypto";
import type { Incoming, KernelContext, MessagingAdapter, MessagingContext, OutgoingMessage } from "../../contracts.ts";
import type { Job } from "../../jobs/state.ts";
import { message } from "../../loader.ts";
import { statusText } from "../../status.ts";
import { splitMessage } from "../split.ts";
import { jobsMenu } from "./jobs.ts";
import { createNav, INPUT_MS, outcomeLine, type Nav, type Page } from "./nav.ts";
import { settingsMenu } from "./settings.ts";

export const COMMANDS = [
  { name: "jobs", description: "Jobs: progress, results and cleanup" },
  { name: "status", description: "Model, extensions and errors" },
  { name: "settings", description: "Models, extensions, schedules, general settings and changes" },
];

export const HELP = `Commands:\n${COMMANDS.map((c) => `/${c.name} — ${c.description}`).join("\n")}`;

/** Told to the owner when their message carrying a secret can't be deleted. */
export const UNDELETED = "Couldn't delete your message — please delete it yourself.";
/** Room left after whole paragraphs below which the next one isn't cut in. */
const MIN_FILL = 20;

/**
 * The first part `splitMessage` gives of `markdown`, then, when that ends at a paragraph, the start of the next
 * paragraph in the room left: a long body isn't dropped after a short title.
 */
function fitted(markdown: string, max: number): string {
  const first = splitMessage(markdown, max)[0]!;
  const rest = markdown.slice(first.length);
  const room = max - first.length - 2;
  if (!markdown.startsWith(first) || !rest.startsWith("\n\n") || room < MIN_FILL) return first;
  return `${first}\n\n${splitMessage(rest.slice(2), room)[0]!}`;
}

/**
 * Answers the owner's commands, their presses of the buttons it sends, and the values its screens ask for. Buttons
 * carry a per-run token, so those from before a restart expire. A command or any press cancels a pending input, and
 * one waiting `INPUT_MS` expires. While a secret one waits, its open time is saved as the adapter's `secretInput`
 * (before its screen is shown), so a restart can't send that secret to the CoS.
 */
export function createMenu(
  adapter: MessagingAdapter,
  kernel: KernelContext,
  messaging: MessagingContext,
  jobs: () => Job[],
) {
  const run = randomUUID().slice(0, 8);
  const navs = { s: createNav("s", run), j: createNav("j", run) };
  const homes = new Map<string, [Nav, Page]>([
    ["settings", [navs.s, settingsMenu(navs.s, kernel, messaging)]],
    ["jobs", [navs.j, jobsMenu(navs.j, jobs, messaging)]],
  ]);
  let at: { chat: string; messageId: string } | undefined; // the message showing the pending input's screen
  let marked: number | undefined; // the saved `secretInput`
  // The nav whose screen waits for a value, expired or not.
  const waiting = () => (navs.s.pending() !== undefined ? navs.s : navs.j.pending() !== undefined ? navs.j : undefined);
  const live = () => {
    const input = waiting()?.pending();
    return input !== undefined && Date.now() - input.opened < INPUT_MS;
  };
  const cancelInput = () => {
    navs.s.cancel();
    navs.j.cancel();
    at = undefined;
  };
  /** Saves the open time of the secret input waiting as `secretInput`, or clears it; cancels an input it can't save. */
  const mark = async () => {
    const input = waiting()?.pending();
    const opened = input?.secret ? input.opened : undefined;
    if (opened === marked) return;
    try {
      await messaging.saveSecretInput(adapter.name, opened);
    } catch (error) {
      cancelInput();
      throw error;
    }
    marked = opened;
  };
  const fit = (m: OutgoingMessage) => ({ ...m, markdown: fitted(m.markdown, adapter.maxMessageChars) });
  const failed = (error: unknown): OutgoingMessage => ({ markdown: `✗ ${message(error)}` });

  return {
    async command(m: Incoming) {
      cancelInput();
      const home = homes.get(m.command!);
      let shown: OutgoingMessage;
      if (home !== undefined) shown = await home[0].show(home[1]).catch(failed);
      else if (m.command === "status") shown = { markdown: statusText(kernel.surface.status()) };
      else shown = { markdown: HELP };
      await mark();
      const messageId = await adapter.send(m.chat, fit(shown));
      if (waiting() !== undefined) at = { chat: m.chat, messageId };
    },

    async press(m: Incoming) {
      cancelInput();
      const [token, scope] = m.action!.split(":");
      const nav = token === run && (scope === "s" || scope === "j") ? navs[scope] : undefined;
      const opened = nav?.open(m.action!);
      const again = token === run && scope === "j" ? "/jobs" : "/settings";
      const expired = { markdown: `This menu expired — send ${again} again.` };
      const shown = opened === undefined ? expired : await opened.catch(failed);
      await mark();
      await adapter.edit(m.chat, m.messageId, fit(shown));
      if (waiting() !== undefined) at = { chat: m.chat, messageId: m.messageId };
    },

    /** Whether a screen is waiting for the owner's next text, and has for less than `INPUT_MS`. */
    pendingInput: live,

    /** Ends an input that waited `INPUT_MS`, as if cancelled; whether there was one. */
    async expire() {
      if (waiting() === undefined || live()) return false;
      cancelInput();
      await mark();
      return true;
    },

    /**
     * Gives the owner's text `m` to the screen waiting for it: deleted first when secret (recorded as fulfilling a
     * secret, so a re-delivery is dropped), applied, then the screen's message shows the outcome.
     */
    async input(m: Incoming) {
      const nav = waiting();
      const input = nav?.pending();
      if (nav === undefined || input === undefined) return;
      const where = at ?? { chat: m.chat, messageId: undefined };
      let outcome: string;
      try {
        if (input.secret) {
          const notice = () => adapter.send(m.chat, { markdown: UNDELETED }).catch(() => {});
          await adapter.delete(m.chat, m.messageId).catch(notice);
          await messaging.recordSecretMessage(`${adapter.name}:${m.id}`);
        }
        outcome = outcomeLine(await input.apply(m.text!));
      } catch (error) {
        outcome = `✗ ${message(error)}`;
      }
      nav.cancel(input);
      if (waiting() === undefined) at = undefined;
      const shown = fit(await nav.show(input.then, outcome).catch(failed));
      await mark();
      if (where.messageId === undefined) {
        const messageId = await adapter.send(where.chat, shown);
        if (waiting() !== undefined) at = { chat: where.chat, messageId };
      } else {
        await adapter.edit(where.chat, where.messageId, shown);
        if (waiting() !== undefined) at = { chat: where.chat, messageId: where.messageId };
      }
    },

  };
}
