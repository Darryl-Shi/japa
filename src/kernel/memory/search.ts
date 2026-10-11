import type { EntryId } from "@earendil-works/pi-durable";
import { words } from "./state.ts";

export type Doc = {
  key: string; // unique: entry id, "job:<id>", "page:<id>", "episode:<id>"
  kind: "you" | "japa" | "auto" | "job" | "page" | "episode";
  text: string;
  at: number;
  id?: EntryId; // transcript docs
  title?: string; // pages and jobs
};

const K1 = 1.2;
const B = 0.75;
const HALF_LIFE_DAYS = 14;
const PAGE_BONUS = 1.5;
const DAY_MS = 86_400_000;

/**
 * Okapi BM25 over `words(text)`, with IDF and average length taken from `docs`, multiplied by
 * `0.5 ** (ageDays / 14)` and by 1.5 for pages. Returns up to `limit` docs with a positive score, best first.
 */
export function rank(docs: readonly Doc[], query: string, now: number, limit: number): Doc[] {
  const terms = [...new Set(words(query))];
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
  const idf = new Map<string, number>();
  for (const term of terms) {
    const n = tfs.filter((t) => t.tf.has(term)).length;
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

/** At most `max` characters of `text` centred on the first word matching `query` (the start if none); "…" marks cuts. */
export function snippet(text: string, query: string, max: number): string {
  if (text.length <= max) return text;
  if (max <= 1) return text.slice(0, Math.max(0, max));
  const terms = new Set(words(query));
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
