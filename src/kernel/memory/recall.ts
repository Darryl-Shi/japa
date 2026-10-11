import { type Doc, rank, snippet } from "./search.ts";
import type { HistoryMessage } from "./transcript.ts";
import { ago, arrival } from "./window.ts";

/** At most this many hits, the origin included. */
export const RECALL_HITS = 5;
/** The block's budget, header included. */
export const RECALL_TOKENS = 1500;

const CHARS_PER_TOKEN = 4;
const HEADER = "[From earlier: found by search; may be incomplete]";
const MESSAGE_SNIPPET = 400;
const PAGE_SNIPPET = 600;

/** `text` on one line. */
const flat = (text: string) => text.replace(/\s+/g, " ").trim();

/** At most `max` characters from the start of `text`, "…" marking a cut. */
const head = (text: string, max: number) =>
  text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;

/** `text` without its leading `prefix`, when it has it. */
const strip = (text: string, prefix: string) => (text.startsWith(prefix) ? text.slice(prefix.length) : text);

/** `doc` as its recall line. */
function line(doc: Doc, query: string, now: number): string {
  const when = ago(doc.at, now);
  const title = doc.title ?? "";
  switch (doc.kind) {
    case "page": {
      const body = flat(strip(doc.text, `${title}\n`));
      return `page "${title}" · updated ${when}: ${head(body, PAGE_SNIPPET)} (page_read "${title}")`;
    }
    case "job": {
      const id = doc.key.slice("job:".length);
      const body = snippet(flat(strip(doc.text, `"${title}": `)), query, MESSAGE_SNIPPET);
      return `job ${id} "${title}" · ${when}: ${body} (job_transcript ${id})`;
    }
    case "episode":
      return `note · ${when}: ${snippet(flat(doc.text), query, MESSAGE_SNIPPET)}`;
    case "auto": {
      const { label, body } = arrival(doc);
      return `${label} · ${when} · #${doc.id ?? doc.key}: ${snippet(flat(body), query, MESSAGE_SNIPPET)}`;
    }
    default:
      return `${doc.kind} · ${when} · #${doc.id ?? doc.key}: ${snippet(flat(doc.text), query, MESSAGE_SNIPPET)}`;
  }
}

/**
 * The "[From earlier]" block: `origin` (the input that started a job this run hears about) first, as `you asked` when
 * the user wrote it or `started by` when it was automated (a schedule firing, a job's report), then the best matches
 * for `query` among `docs` that aren't in `exclude` (already in view): at most 5 hits within 6,000 characters, a hit
 * too big for what's left being skipped. Undefined when there are none.
 */
export function renderRecall(input: {
  query: string;
  docs: readonly Doc[];
  exclude: ReadonlySet<string>; // keys already in view
  origin?: HistoryMessage;
  now: number;
}): string | undefined {
  const { query, docs, exclude, origin, now } = input;
  const cap = RECALL_TOKENS * CHARS_PER_TOKEN;
  const lines: string[] = [];
  let total = HEADER.length;
  const add = (text: string): boolean => {
    if (lines.length >= RECALL_HITS || total + 1 + text.length > cap) return false;
    lines.push(text);
    total += 1 + text.length;
    return true;
  };

  if (origin !== undefined) {
    const label = origin.kind === "you" ? "you asked" : "started by";
    add(`${label} · ${ago(origin.at, now)} · #${origin.id}: ${snippet(flat(origin.text), query, MESSAGE_SNIPPET)}`);
  }
  const shown = origin === undefined ? undefined : String(origin.id);
  const candidates = docs.filter((d) => !exclude.has(d.key) && d.key !== shown);
  for (const doc of rank(candidates, query, now, RECALL_HITS)) {
    if (lines.length >= RECALL_HITS) break;
    add(line(doc, query, now));
  }
  return lines.length > 0 ? [HEADER, ...lines].join("\n") : undefined;
}
