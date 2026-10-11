import type { EntryId } from "@earendil-works/pi-durable";
import { words } from "./state.ts";

export type Doc = {
  key: string; // unique: entry id, "job:<id>", "page:<id>", "episode:<id>"
  kind: "you" | "japa" | "auto" | "job" | "page" | "episode";
  text: string;
  at: number;
  id?: EntryId; // transcript docs
  title?: string; // pages and jobs
  job?: string; // a job report's job id
};

const K1 = 1.2;
const B = 0.75;
const HALF_LIFE_DAYS = 14;
const PAGE_BONUS = 1.5;
const DAY_MS = 86_400_000;
/** With at least this many docs, a query term in more than `COMMON_SHARE` of them is too common to search on. */
const COMMON_MIN_DOCS = 10;
const COMMON_SHARE = 0.2;

/** Words too common in chat to search on: articles, pronouns, auxiliaries, small connectives and asking verbs. */
const STOPWORDS = new Set(
  (
    "the an and or but if so as than then that this these those there here " +
    "me my mine you your yours ur we us our ours he him his she her hers it its they them their theirs " +
    "im ive youre dont didnt doesnt cant wont isnt arent wasnt thats whats " +
    "am is are was were be been being have has had having do does did doing done " +
    "will would shall should can could may might must " +
    "of in on at to for with from by about into onto over under after before up down out off again " +
    "not no yes " +
    "what which who whom whose how when where why " +
    "remember please just like know think tell said say any some all"
  ).split(" "),
);

/** `w` is a stopword, or a single letter. */
const isStopword = (w: string) => STOPWORDS.has(w) || /^\p{L}$/u.test(w);

/** The distinct words of `query` worth searching on. */
const queryTerms = (query: string) => [...new Set(words(query))].filter((w) => !isStopword(w));

/**
 * Okapi BM25 over `words(text)`, with IDF and average length taken from `docs`, multiplied by
 * `0.5 ** (ageDays / 14)` and by 1.5 for pages. Stopwords in the query are ignored, and so, among 10 docs or more, is
 * a term found in more than 20% of them (unless every term is). Returns up to `limit` docs with a positive score, best
 * first.
 */
export function rank(docs: readonly Doc[], query: string, now: number, limit: number): Doc[] {
  let terms = queryTerms(query);
  if (terms.length === 0 || docs.length === 0 || limit <= 0) return [];

  const tfs = docs.map((d) => {
    const tf = new Map<string, number>();
    for (const w of words(d.text)) tf.set(w, (tf.get(w) ?? 0) + 1);
    let length = 0;
    for (const n of tf.values()) length += n;
    return { tf, length };
  });
  const N = docs.length;
  const avgdl = tfs.reduce((sum, t) => sum + t.length, 0) / N || 1;
  const df = new Map(terms.map((term) => [term, tfs.filter((t) => t.tf.has(term)).length]));
  if (N >= COMMON_MIN_DOCS) {
    const rare = terms.filter((term) => df.get(term)! <= COMMON_SHARE * N);
    if (rare.length > 0) terms = rare;
  }
  const idf = new Map<string, number>();
  for (const term of terms) {
    const n = df.get(term)!;
    idf.set(term, Math.log(1 + (N - n + 0.5) / (n + 0.5)));
  }

  const scored: { doc: Doc; score: number }[] = [];
  docs.forEach((doc, i) => {
    const { tf, length } = tfs[i]!;
    let score = 0;
    for (const term of terms) {
      const f = tf.get(term);
      if (!f) continue;
      score += idf.get(term)! * ((f * (K1 + 1)) / (f + K1 * (1 - B + (B * length) / avgdl)));
    }
    if (score <= 0) return;
    const ageDays = Math.max(0, now - doc.at) / DAY_MS;
    score *= 0.5 ** (ageDays / HALF_LIFE_DAYS);
    if (doc.kind === "page") score *= PAGE_BONUS;
    if (score > 0) scored.push({ doc, score });
  });
  scored.sort((a, b) => b.score - a.score || b.doc.at - a.doc.at);
  return scored.slice(0, limit).map((s) => s.doc);
}

/**
 * At most `max` characters of `text` centred on the first word matching a non-stopword of `query` (the start if none);
 * "…" marks cuts.
 */
export function snippet(text: string, query: string, max: number): string {
  if (text.length <= max) return text;
  if (max <= 1) return text.slice(0, Math.max(0, max));
  const terms = new Set(queryTerms(query));
  let matchStart = 0;
  let matchEnd = 0;
  for (const m of text.matchAll(/\S+/g)) {
    if (words(m[0]).some((w) => terms.has(w))) {
      matchStart = m.index;
      matchEnd = m.index + m[0].length;
      break;
    }
  }
  const centre = (matchStart + matchEnd) / 2;
  let inner = max;
  let start = 0;
  let end = 0;
  for (let pass = 0; pass < 3; pass++) {
    start = Math.max(0, Math.round(centre - inner / 2));
    end = Math.min(text.length, start + inner);
    start = Math.max(0, end - inner);
    const next = max - (start > 0 ? 1 : 0) - (end < text.length ? 1 : 0);
    if (next === inner) break;
    inner = next;
  }
  const body = text.slice(start, end);
  return `${start > 0 ? "…" : ""}${start > 0 ? body.trimStart() : body}${end < text.length ? "…" : ""}`.replace(
    /\s+…$/,
    "…",
  );
}
