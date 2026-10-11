import type { EntryId } from "@earendil-works/pi-durable";
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

/** What `cut` keeps of a text `length` long: its first `head` characters and those from `tail` on. */
function cutBounds(length: number, over: number): { head: number; tail: number } {
  const keep = Math.max(length - over - CUT.length, 0);
  const head = Math.ceil(keep / 2);
  return { head, tail: length - (keep - head) };
}

/** `text` shortened by `over` characters, its middle replaced by `[…]`. */
export function cut(text: string, over: number): string {
  const { head, tail } = cutBounds(text.length, over);
  return text.slice(0, head) + CUT + text.slice(tail);
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

/** A rendered window: its text, and the messages on screen in it, shortened ones included and dropped ones not. */
export type WindowView = { text: string; shown: EntryId[] };

/** The "[Conversation so far]" block's text; see `windowView`. */
export function renderWindow(
  before: readonly HistoryMessage[],
  now: number,
  options: { budget?: number } = {},
): string | undefined {
  return windowView(before, now, options)?.text;
}

/**
 * The "[Conversation so far]" block for a run that starts at `now`, from `before` (every message before the run,
 * oldest first), with the ids of the messages it shows; undefined when there are no messages. It holds the current
 * conversation (see `conversation`) within `budget` tokens (8,000 by default, and at most). The user's first message
 * in it, the anchor, is dropped last: while it stays and messages after it are dropped, it's shown above the pointer
 * line, as its headline if it had to be shortened. Always:
 * 1. The newest exchange is cut to 2,000 tokens (less room for the header, the pointer and the anchor, on a smaller
 *    budget) in the middle of its longest parts. If that's not enough (a long run of inputs with no reply between
 *    them), its oldest inputs are dropped, keeping the last input and the reply (and the anchor, as its headline);
 *    everything before them is dropped too, but the anchor.
 * 2. Older messages are shortened to their headline, oldest first, while over budget.
 * 3. Then the oldest are dropped, the anchor last. Dropped messages are counted in one pointer line,
 *    `[N messages not shown: history_read <first dropped id>]`, after the anchor or else after the header.
 * 4. Whatever still doesn't fit is cut in the middle; a message whose line starts in the cut isn't shown.
 */
export function windowView(
  before: readonly HistoryMessage[],
  now: number,
  options: { budget?: number } = {},
): WindowView | undefined {
  const messages = conversation(before, now);
  if (messages.length === 0) return undefined;
  const cap = Math.min(options.budget ?? WINDOW_TOKENS, WINDOW_TOKENS) * CHARS_PER_TOKEN;
  const items: Item[] = messages.map((message) => ({ message, text: message.text }));
  const start = items.length - lastExchange(messages).length; // the newest exchange's first item
  const newest = items.slice(start);
  const anchor = items.findIndex((i) => i.message.kind === "you"); // -1 when the user wrote none
  const pinned = (k: number) => ({ message: items[k]!.message, text: headline(items[k]!.message.text) });
  // Room for the anchor's headline when it's older than the newest exchange, so dropping never has to take it.
  const reserve = anchor >= 0 && anchor < start ? 1 + show(pinned(anchor), now).length : 0;
  const dropped = items.map(() => false);

  // 1. The newest exchange, up to 2,000 tokens: cut its texts, but not below a headline's length, ...
  const newestCap = Math.min(NEWEST_TOKENS * CHARS_PER_TOKEN, cap - FRAME - reserve);
  fit(newest, newestCap, HEADLINE, now);
  // ... then drop its oldest inputs, keeping the last one, the anchor shortened to its headline instead, ...
  const inputs = newest.filter((i) => i.message.kind !== "japa").length;
  const lengths = newest.map((i) => show(i, now).length);
  let length = size(lengths);
  const local = anchor - start;
  const order = Array.from({ length: Math.max(inputs - 1, 0) }, (_, k) => k).filter((k) => k !== local);
  if (local >= 0 && local < inputs - 1) order.push(local);
  let pin = false;
  for (const k of order) {
    if (length <= newestCap) break;
    if (k === local) {
      pin = true;
      length += show(pinned(anchor), now).length - lengths[k]!;
    } else {
      dropped[start + k] = true;
      length -= 1 + lengths[k]!;
    }
  }
  // ... and cut what's left afresh, down to `[…]` if it must.
  const kept = newest.filter((_, k) => !dropped[start + k]);
  for (const item of kept) item.text = item.message.text;
  if (pin) items[anchor]!.text = pinned(anchor).text;
  fit(kept, newestCap, HEADLINE, now);
  fit(kept, newestCap, 0, now);
  if (dropped.some((d) => d)) {
    for (let i = 0; i < start; i++) {
      if (i === anchor) items[i]!.text = pinned(i).text;
      else dropped[i] = true;
    }
  }

  // 2. Older messages, shortened oldest first; 3. then dropped oldest first, the anchor last.
  const lines = items.map((i) => show(i, now));
  let count = dropped.filter((d) => d).length;
  let first = dropped.indexOf(true);
  const pointer = () => `[${count} messages not shown: history_read ${items[first]!.message.id}]`;
  const pointerLength = () => (count === 0 ? 0 : 1 + pointer().length);
  let total = HEADER.length + pointerLength();
  items.forEach((_, i) => {
    if (!dropped[i]) total += 1 + lines[i]!.length;
  });
  for (let i = 0; i < start && total > cap; i++) {
    const item = items[i]!;
    if (dropped[i] || item.message.kind === "auto") continue;
    item.text = headline(item.text);
    const next = show(item, now);
    total += next.length - lines[i]!.length;
    lines[i] = next;
  }
  const older = Array.from({ length: start }, (_, i) => i).filter((i) => i !== anchor && !dropped[i]);
  if (anchor >= 0 && anchor < start) older.push(anchor);
  for (const i of older) {
    if (total <= cap) break;
    const was = pointerLength();
    total -= 1 + lines[i]!.length;
    dropped[i] = true;
    count++;
    if (first < 0 || i < first) first = i;
    total += pointerLength() - was;
  }

  // The pointer goes after the anchor when it hides messages after it, else after the header.
  const after = anchor >= 0 && !dropped[anchor] && dropped.some((d, i) => d && i > anchor) ? anchor : -1;
  const rows: { line: string; id?: EntryId }[] = [{ line: HEADER }];
  if (count > 0 && after < 0) rows.push({ line: pointer() });
  items.forEach((item, i) => {
    if (dropped[i]) return;
    rows.push({ line: lines[i]!, id: item.message.id });
    if (i === after) rows.push({ line: pointer() });
  });

  // 4. The hard guarantee.
  const out = rows.map((r) => r.line).join("\n");
  const over = Math.max(out.length - cap, 0);
  const { head, tail } = over > 0 ? cutBounds(out.length, over) : { head: out.length, tail: out.length };
  const shown: EntryId[] = [];
  let at = 0;
  for (const row of rows) {
    if (row.id !== undefined && (at < head || at >= tail)) shown.push(row.id);
    at += row.line.length + 1;
  }
  return { text: over > 0 ? cut(out, over) : out, shown };
}
