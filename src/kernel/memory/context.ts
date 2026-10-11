import type { EntryId } from "@earendil-works/pi-durable";
import type { Job } from "../jobs/state.ts";
import { corpus } from "./history.ts";
import { renderRecall } from "./recall.ts";
import type { Scratchpad } from "./scratchpad.ts";
import type { Memory } from "./state.ts";
import type { HistoryMessage } from "./transcript.ts";
import { conversation, renderWindow } from "./window.ts";

/** The run's inputs: the `you` and `auto` messages after the newest reset, every one when there is none. */
const runInputs = (messages: readonly HistoryMessage[], lastReset?: EntryId) =>
  messages.filter((m) => m.kind !== "japa" && (lastReset === undefined || m.id > lastReset));

/**
 * Which run `messages` and `lastReset` are at: the newest reset and the newest input after it. A steer stays in the
 * same pi-durable run (it joins the live run's inputs), but a new input id still changes the key on purpose: the
 * context is rebuilt so recall covers the steer too.
 */
export function runKey(messages: readonly HistoryMessage[], lastReset?: EntryId): string {
  return `${lastReset ?? "-"}:${runInputs(messages, lastReset).at(-1)?.id ?? "-"}`;
}

/**
 * The context injected ahead of a run (spec §2): the "[Conversation so far]" window over the messages before the
 * newest reset, and "[From earlier]" recall for the run's inputs (the `you` and `auto` messages after it), joined by a
 * blank line; undefined when both are empty. With no reset yet, every input is the run's and the window is empty.
 */
export function buildContext(input: {
  messages: readonly HistoryMessage[];
  lastReset?: EntryId;
  memory: Memory;
  pad: Scratchpad;
  jobs: Record<string, Job>;
  now: number;
}): string | undefined {
  const { messages, lastReset, memory, pad, jobs, now } = input;
  const inputs = runInputs(messages, lastReset);
  const before = lastReset === undefined ? [] : messages.filter((m) => m.id < lastReset);
  const shown = conversation(before, now);

  const window = renderWindow(before, now);
  const query = [...inputs.map((m) => m.text), ...shown.filter((m) => m.kind === "you").map((m) => m.text)].join("\n");
  // What's already in view: the window's and the run's messages, and each reported job's own result.
  const exclude = new Set([
    ...[...shown, ...inputs].map((m) => String(m.id)),
    ...inputs.flatMap((m) => (m.job === undefined ? [] : [`job:${m.job}`])),
  ]);
  const job = inputs.find((m) => m.kind === "auto" && m.job !== undefined)?.job;
  const originId = job === undefined ? undefined : jobs[job]?.origin;
  // An origin the window already shows isn't repeated.
  const origin =
    originId === undefined || shown.some((m) => m.id === originId)
      ? undefined
      : messages.find((m) => m.id === originId);
  const recall = renderRecall({
    query,
    docs: corpus(messages, memory, pad, jobs),
    exclude,
    ...(origin === undefined ? {} : { origin }),
    now,
  });

  const blocks = [window, recall].filter((b) => b !== undefined);
  return blocks.length > 0 ? blocks.join("\n\n") : undefined;
}
