import type { HistoryMessage } from "./transcript.ts";

/** A pause longer than this between the user's messages ends a conversation. */
export const PAUSE_MS = 1_800_000;
/** The window's budget, header included. */
export const WINDOW_TOKENS = 8000;
/** The newest exchange's share of the budget; also the whole budget of a run with no user input. */
export const NEWEST_TOKENS = 2000;

const CHARS_PER_TOKEN = 4;
const HEADER = "[Conversation so far]";
const HEADLINE = 200;
const CUT = "[…]";
const LABEL = 60;
const PREFIX = /^\[[^\]\n]*\]/;
/** A job report's prefix, `[job <n> "<title>" <status>]`; the title may hold `]` or `"`. */
const JOB_PREFIX = /^\[job \d+ "[\s\S]*?" [a-z_]+\]/;
/** Room kept beside the newest exchange for the header and the dropped-messages pointer line. */
const FRAME = 100;

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** `text` shortened by `over` characters, its middle replaced by `[…]`. */
export function cut(text: string, over: number): string {
  const keep = text.length - over - CUT.length;
  if (keep <= 0) return CUT;
  const head = Math.ceil(keep / 2);
  return text.slice(0, head) + CUT + text.slice(text.length - (keep - head));
}

/** How long before `now` the time `at` was: "just now", "N min ago", "N h ago", "N d ago", else "YYYY-MM-DD". */
export function ago(at: number, now: number): string {
  const d = now - at;
  if (d < MIN) return "just now";
  if (d < HOUR) return `${Math.floor(d / MIN)} min ago`;
  if (d < DAY) return `${Math.floor(d / HOUR)} h ago`;
  if (d < 7 * DAY) return `${Math.floor(d / DAY)} d ago`;
  return new Date(at).toISOString().slice(0, 10);
}

/** The last exchange of `messages`: its last inputs and the reply after them, which may be missing. */
function lastExchange(messages: readonly HistoryMessage[]): HistoryMessage[] {
  let i = messages.length;
  while (i > 0 && messages[i - 1]!.kind === "japa") i--;
  while (i > 0 && messages[i - 1]!.kind !== "japa") i--;
  return messages.slice(i);
}

/**
 * The current conversation in `before` (every message before the run that starts at `now`, oldest first). Only the
 * user's messages set it, so automated arrivals neither extend nor displace it:
 * - It runs from the earliest `you` message that is chained to the run by gaps of at most 30 minutes between the
 *   user's messages, with every message after it.
 * - After such a pause (the last `you` message is more than 30 minutes old), it is the exchange holding that message
 *   (from the first input before its reply) with every message after it.
 * - With no `you` message at all, it is the last exchange.
 */
export function conversation(before: readonly HistoryMessage[], now: number): HistoryMessage[] {
  const yours = before.flatMap((m, i) => (m.kind === "you" ? [i] : []));
  const last = yours.at(-1);
  if (last === undefined) return lastExchange(before);
  if (now - before[last]!.at > PAUSE_MS) {
    let i = last;
    while (i > 0 && before[i - 1]!.kind !== "japa") i--;
    return before.slice(i);
  }
  let k = yours.length - 1;
  while (k > 0 && before[yours[k]!]!.at - before[yours[k - 1]!]!.at <= PAUSE_MS) k--;
  return before.slice(yours[k]!);
}

/** The first line of `text`, at most 200 characters. */
function headline(text: string): string {
  const first = text.trim().split("\n")[0]!.trim();
  return first.length <= HEADLINE ? first : `${first.slice(0, HEADLINE - 1)}…`;
}

type Item = { message: HistoryMessage; text: string };

/** `label` at most 60 characters, its end replaced by `…]` when longer. */
function capLabel(label: string): string {
  return label.length <= LABEL ? label : `${label.slice(0, LABEL - 2)}…]`;
}

/** `item` as its line group: `you`, `japa` and its `did:` line, or an automated arrival's headline and pointer. */
function show(item: Item, now: number): string {
  const { message: m } = item;
  const when = ago(m.at, now);
  if (m.kind === "you") return `you · ${when} · #${m.id}: ${item.text}`;
  if (m.kind === "japa") {
    const did = m.did === undefined ? "" : `\n  ${m.did.replace(/\s+/g, " ")}`;
    return `japa · ${when}: ${item.text}${did}`;
  }
  const { label, body } = arrival(m);
  const pointer = m.job !== undefined ? `job_transcript ${m.job}` : `history_read ${m.id}`;
  return `${label} · ${when} · #${m.id}: ${headline(body)} (full: ${pointer})`;
}

/**
 * How an automated arrival (`text`, with `job` for a job report) is labelled wherever it's shown, and its text after
 * the label: `job <n> report` and the text after `[job <n> "<title>" <status>]`, else its bracketed prefix (at most 60
 * characters) or `[auto]`, and the text after the prefix. A whole-bracket arrival such as `[secret X provided]` is its
 * own body.
 */
export function arrival(message: { text: string; job?: string }): { label: string; body: string } {
  const { text, job } = message;
  const prefix = ((job !== undefined && JOB_PREFIX.exec(text)) || PREFIX.exec(text))?.[0];
  const rest = (prefix === undefined ? text : text.slice(prefix.length)).trim();
  const label = job !== undefined ? `job ${job} report` : capLabel(prefix ?? "[auto]");
  return { label, body: rest || (prefix?.slice(1, -1).trim() ?? "") };
}

/**
 * `message` as its window line group, but with its full text: for `history_read`. An automated arrival shows all of
 * it after its label, with no pointer; a job report keeps its `[job <n> "<title>" <status>]` prefix.
 */
export function fullLine(message: HistoryMessage, now: number): string {
  if (message.kind !== "auto") return show({ message, text: message.text }, now);
  const when = ago(message.at, now);
  if (message.job !== undefined) return `job ${message.job} report · ${when} · #${message.id}: ${message.text}`;
  const prefix = PREFIX.exec(message.text)?.[0];
  const rest = prefix === undefined ? message.text : message.text.slice(prefix.length).trim();
  return `${prefix ?? "[auto]"} · ${when} · #${message.id}: ${rest || (prefix?.slice(1, -1) ?? "")}`;
}

/** The rendered length of `items` joined by newlines. */
const size = (lengths: readonly number[]) => lengths.reduce((sum, n) => sum + 1 + n, -1);

/**
 * Cuts the `you` and `japa` texts of `items` in the middle, longest first, until they render within `cap`
 * characters or every text is down to `floor` characters (or `[…]`).
 */
function fit(items: readonly Item[], cap: number, floor: number, now: number): void {
  const lengths = items.map((i) => show(i, now).length);
  let length = size(lengths);
  const cuttable = items.flatMap((i, k) => (i.message.kind === "auto" ? [] : [k]));
  while (length > cap && cuttable.length > 0) {
    const k = cuttable.reduce((a, b) => (items[b]!.text.length > items[a]!.text.length ? b : a));
    const item = items[k]!;
    const room = item.text.length - Math.max(floor, CUT.length);
    if (room <= 0) return; // every text is down to the floor
    item.text = cut(item.text, Math.min(length - cap, room));
    const next = show(item, now).length;
    length += next - lengths[k]!;
    lengths[k] = next;
  }
}

/**
 * The "[Conversation so far]" block for a run that starts at `now`, from `before` (every message before the run,
 * oldest first); undefined when there are no messages. It holds the current conversation (see `conversation`) within
 * `budget` tokens (8,000 by default, and at most), always:
 * 1. The newest exchange is cut to 2,000 tokens (less room for the header, on a smaller budget) in the middle of its
 *    longest parts. If that's not enough (a long run of inputs with no reply between them), its oldest inputs are
 *    dropped, keeping the last input and the reply; everything before them is dropped too, so the dropped messages
 *    are always the oldest.
 * 2. Older messages are shortened to their headline, oldest first, while over budget.
 * 3. Then the oldest are dropped. Dropped messages are counted in one `history_read` pointer line after the header.
 * 4. Whatever still doesn't fit is cut in the middle.
 */
export function renderWindow(
  before: readonly HistoryMessage[],
  now: number,
  options: { budget?: number } = {},
): string | undefined {
  const messages = conversation(before, now);
  if (messages.length === 0) return undefined;
  const cap = Math.min(options.budget ?? WINDOW_TOKENS, WINDOW_TOKENS) * CHARS_PER_TOKEN;
  const items: Item[] = messages.map((message) => ({ message, text: message.text }));
  const newest = items.slice(items.length - lastExchange(messages).length);
  const olderCount = items.length - newest.length;

  // 1. The newest exchange, up to 2,000 tokens: cut its texts, but not below a headline's length, ...
  const newestCap = Math.min(NEWEST_TOKENS * CHARS_PER_TOKEN, cap - FRAME);
  fit(newest, newestCap, HEADLINE, now);
  // ... then drop its oldest inputs, keeping the last one, ...
  const inputs = newest.filter((i) => i.message.kind !== "japa").length;
  const lengths = newest.map((i) => show(i, now).length);
  let length = size(lengths);
  let newestDropped = 0;
  while (length > newestCap && newestDropped < inputs - 1) length -= 1 + lengths[newestDropped++]!;
  // ... and cut what's left afresh, down to `[…]` if it must.
  const kept = newest.slice(newestDropped);
  for (const item of kept) item.text = item.message.text;
  fit(kept, newestCap, HEADLINE, now);
  fit(kept, newestCap, 0, now);

  // 2. Older messages, shortened oldest first; 3. then dropped oldest first.
  const shown = items.map((i) => show(i, now));
  const pointer = (n: number) => `[${n} earlier messages in this conversation: history_read ${messages[0]!.id}]`;
  const pointerLength = (n: number) => (n === 0 ? 0 : 1 + pointer(n).length);
  let dropped = newestDropped > 0 ? olderCount + newestDropped : 0;
  let total = HEADER.length + pointerLength(dropped);
  for (let i = dropped; i < items.length; i++) total += 1 + shown[i]!.length;
  for (let i = dropped; i < olderCount && total > cap; i++) {
    const item = items[i]!;
    if (item.message.kind === "auto") continue;
    item.text = headline(item.text);
    const next = show(item, now);
    total += next.length - shown[i]!.length;
    shown[i] = next;
  }
  while (dropped < olderCount && total > cap) {
    total -= 1 + shown[dropped]!.length;
    dropped++;
    total += pointerLength(dropped) - pointerLength(dropped - 1);
  }

  // 4. The hard guarantee.
  const out = [HEADER, ...(dropped > 0 ? [pointer(dropped)] : []), ...shown.slice(dropped)].join("\n");
  return out.length <= cap ? out : cut(out, out.length - cap);
}
