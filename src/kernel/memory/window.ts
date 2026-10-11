import type { HistoryMessage } from "./transcript.ts";

/** A pause longer than this ends a conversation. */
export const PAUSE_MS = 1_800_000;
/** The window's budget, header included. */
export const WINDOW_TOKENS = 8000;
/** The newest exchange's share of the budget. */
export const NEWEST_TOKENS = 2000;

const CHARS_PER_TOKEN = 4;
const HEADER = "[Conversation so far]";
const HEADLINE = 200;
const CUT = "[…]";
const PREFIX = /^\[[^\]\n]*\]/;

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
 * The current conversation in `before` (every message before the run that starts at `now`, oldest first): it runs
 * back to the first gap of more than 30 minutes. When it's empty, because the run starts after such a pause, it is
 * the previous conversation's last exchange instead.
 */
export function conversation(before: readonly HistoryMessage[], now: number): HistoryMessage[] {
  const last = before.at(-1);
  if (last === undefined) return [];
  if (now - last.at > PAUSE_MS) return lastExchange(before);
  let i = before.length - 1;
  while (i > 0 && before[i]!.at - before[i - 1]!.at <= PAUSE_MS) i--;
  return before.slice(i);
}

/** The first line of `text`, at most 200 characters. */
function headline(text: string): string {
  const first = text.trim().split("\n")[0]!.trim();
  return first.length <= HEADLINE ? first : `${first.slice(0, HEADLINE - 1)}…`;
}

type Item = { message: HistoryMessage; text: string };

/** `item` as its line group: `you`, `japa` and its `did:` line, or an automated arrival's headline and pointer. */
function show(item: Item, now: number): string {
  const { message: m } = item;
  const when = ago(m.at, now);
  if (m.kind === "you") return `you · ${when} · #${m.id}: ${item.text}`;
  if (m.kind === "japa") {
    const did = m.did === undefined ? "" : `\n  ${m.did.replace(/\s+/g, " ")}`;
    return `japa · ${when}: ${item.text}${did}`;
  }
  const prefix = PREFIX.exec(m.text)?.[0];
  const rest = prefix === undefined ? m.text : m.text.slice(prefix.length);
  const label = m.job !== undefined ? `job ${m.job} report` : (prefix ?? "[auto]");
  const pointer = m.job !== undefined ? `job_transcript ${m.job}` : `history_read ${m.id}`;
  return `${label} · ${when} · #${m.id}: ${headline(rest)} (full: ${pointer})`;
}

/**
 * The "[Conversation so far]" block for a run that starts at `now`, from `before` (every message before the run,
 * oldest first); undefined when there are no messages. It holds the current conversation (see `conversation`) within
 * 8,000 tokens: the newest exchange is cut to 2,000 tokens in the middle of its longest part, then older messages are
 * shortened to their headline, oldest first, then the oldest are dropped behind one `history_read` pointer line.
 */
export function renderWindow(before: readonly HistoryMessage[], now: number): string | undefined {
  const messages = conversation(before, now);
  if (messages.length === 0) return undefined;
  const items: Item[] = messages.map((message) => ({ message, text: message.text }));
  const newest = items.slice(items.length - lastExchange(messages).length);
  const older = items.slice(0, items.length - newest.length);

  // 1. The newest exchange, up to 2,000 tokens.
  const newestCap = NEWEST_TOKENS * CHARS_PER_TOKEN;
  const cuttable = newest.filter((i) => i.message.kind !== "auto");
  let length = newest.map((i) => show(i, now)).join("\n").length;
  while (length > newestCap && cuttable.length > 0) {
    const longest = cuttable.reduce((a, b) => (b.text.length > a.text.length ? b : a));
    if (longest.text.length <= CUT.length) break; // every part is cut to the bone
    longest.text = cut(longest.text, length - newestCap);
    length = newest.map((i) => show(i, now)).join("\n").length;
  }

  // 2. Older messages, shortened oldest first; 3. then dropped oldest first.
  const cap = WINDOW_TOKENS * CHARS_PER_TOKEN;
  const shown = items.map((i) => show(i, now));
  let total = HEADER.length + shown.reduce((sum, s) => sum + 1 + s.length, 0);
  for (let i = 0; i < older.length && total > cap; i++) {
    const item = older[i]!;
    if (item.message.kind === "auto") continue;
    item.text = headline(item.text);
    const next = show(item, now);
    total += next.length - shown[i]!.length;
    shown[i] = next;
  }
  let dropped = 0;
  const pointer = (n: number) => `[${n} earlier messages in this conversation: history_read ${messages[0]!.id}]`;
  while (dropped < older.length && total > cap) {
    total -= 1 + shown[dropped]!.length;
    dropped++;
    total += (dropped === 1 ? 1 + pointer(1).length : pointer(dropped).length - pointer(dropped - 1).length);
  }
  return [HEADER, ...(dropped > 0 ? [pointer(dropped)] : []), ...shown.slice(dropped)].join("\n");
}
