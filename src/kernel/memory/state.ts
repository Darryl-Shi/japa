import { defineDoc, type EntryId, type TaskId } from "@earendil-works/pi-durable";

export type Fact = { id: string; text: string; updatedAt: number };
export type Episode = { id: string; at: number; text: string };
export type Memory = {
  nextId: number;
  facts: Fact[]; // the profile: items strictly about the user
  legacyEpisodes?: Episode[]; // version 2 episodes, searchable until `legacyUntil`
  legacyUntil?: number; // set by Sort: when the legacy episodes are dropped
  reflectedThrough?: EntryId;
  reflecting?: TaskId; // the latest `Reflect` task, live unless terminal
  sorting?: TaskId; // the one-time Sort task, live unless terminal
  sorted?: true; // the profile and legacy episodes were sorted into profile items and scratchpad pages
  upgraded?: { loops: string[] }; // dropped version 1 loops, delivered to the CoS as a one-time notice
};
export type Limits = { maxFacts: number; maxTokens: number };

export type FactOp = { op: "add"; text: string } | { op: "update"; id: string; text: string } | { op: "delete"; id: string };

type MemoryV1 = { nextId: number; facts: Fact[]; loops: { text: string }[]; episodes: Episode[] };
type MemoryV2 = Omit<Memory, "legacyEpisodes" | "legacyUntil" | "sorting" | "sorted"> & { episodes: Episode[] };

// On the root conversation.
export const MemoryDoc = defineDoc<Memory>({
  kind: "japa.memory",
  version: 3,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({ nextId: 1, facts: [], sorted: true }), // a fresh install has nothing to sort
  migrate: (value, fromVersion) => {
    if (fromVersion === 1) {
      const v1 = value as unknown as MemoryV1;
      return { nextId: v1.nextId, facts: v1.facts, legacyEpisodes: v1.episodes, upgraded: { loops: v1.loops.map((l) => l.text) } };
    }
    const { episodes, ...rest } = value as unknown as MemoryV2;
    return { ...rest, legacyEpisodes: episodes }; // `sorted` unset: Sort runs at the next boot
  },
});

export const MAX_WORDS = 30;

/** The lowercased words of `text`, split on whitespace and punctuation ("dshi-home-server" is three words). */
export function words(text: string): string[] {
  return text.toLowerCase().replace(/[^\p{L}\p{N}]/gu, " ").split(/\s+/).filter(Boolean);
}

export function wordCount(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

/** Jaccard similarity of normalized word sets is at least 0.8. */
export function nearDuplicate(a: string, b: string): boolean {
  const x = new Set(words(a));
  const y = new Set(words(b));
  const shared = [...x].filter((w) => y.has(w)).length;
  return shared / (x.size + y.size - shared) >= 0.8;
}

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** Operational detail that belongs on a scratchpad page, not in the profile, checked in order. */
const OFF_SCOPE: [RegExp, string][] = [
  [/(^|\s)(~\/|\/[\w.-]+\/[\w.-]+)/, "a file path"],
  [/https?:\/\//, "a URL"],
  [/\b\d{1,3}(\.\d{1,3}){3}\b/, "an IP address"],
  [/\b(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{7,}\b/i, "a commit or hash"], // a digit and a hex letter
  [/\bjob #?\d+\b(?!\s*(day|week|month|year)s?\b)/i, "a job reference"], // not "a new job 2 weeks ago"
];

/** Why `text` is not about the user (a path, URL, IP, hash or job reference), or undefined when it's fine. */
export function offScope(text: string): string | undefined {
  return OFF_SCOPE.find(([pattern]) => pattern.test(text))?.[1];
}

const normalize = (text: string) => text.toLowerCase().replace(/\s+/g, " ").trim();

/** `evidence` has at least 3 words and, lowercased with whitespace collapsed, is a substring of one of `userLines`. */
export function hasEvidence(evidence: string, userLines: readonly string[]): boolean {
  if (wordCount(evidence) < 3) return false;
  const quote = normalize(evidence);
  return userLines.some((l) => normalize(l).includes(quote));
}

/**
 * Applies ops to `memory` in place. Adds and updates that are off scope are returned in `rejected` with the reason;
 * the rest over `MAX_WORDS` words in `tooLong`.
 */
export function applyFactOps(
  memory: Memory,
  ops: FactOp[],
  now: number,
): { tooLong: FactOp[]; rejected: { op: FactOp; reason: string }[] } {
  const tooLong: FactOp[] = [];
  const rejected: { op: FactOp; reason: string }[] = [];
  for (const op of ops) {
    if (op.op === "delete") {
      memory.facts = memory.facts.filter((f) => f.id !== op.id);
      continue;
    }
    const reason = offScope(op.text);
    if (reason !== undefined) {
      rejected.push({ op, reason });
    } else if (wordCount(op.text) > MAX_WORDS) {
      tooLong.push(op);
    } else if (op.op === "add") {
      if (memory.facts.some((f) => nearDuplicate(f.text, op.text))) continue;
      memory.facts.push({ id: String(memory.nextId++), text: op.text, updatedAt: now });
    } else {
      const fact = memory.facts.find((f) => f.id === op.id);
      if (!fact || memory.facts.some((f) => f !== fact && nearDuplicate(f.text, op.text))) continue;
      fact.text = op.text;
      fact.updatedAt = now;
    }
  }
  return { tooLong, rejected };
}

/** Drops the legacy episodes once `legacyUntil` has passed. */
export function expireLegacy(memory: Memory, now: number): void {
  if (memory.legacyUntil === undefined || now <= memory.legacyUntil) return;
  delete memory.legacyEpisodes;
  delete memory.legacyUntil;
}

export function overCap(facts: Fact[], limits: Limits): boolean {
  const tokens = facts.reduce((sum, f) => sum + estimateTokens(f.text), 0);
  return facts.length > limits.maxFacts || tokens > limits.maxTokens;
}

/** Drops the least recently updated facts until the list fits. */
export function truncateToCap(facts: Fact[], limits: Limits): Fact[] {
  const kept = [...facts];
  while (overCap(kept, limits)) {
    const oldest = kept.reduce((a, b) => (b.updatedAt < a.updatedAt ? b : a));
    kept.splice(kept.indexOf(oldest), 1);
  }
  return kept;
}

export function renderFacts(facts: Fact[]): string | undefined {
  return facts.length ? facts.map((f) => `- ${f.text}`).join("\n") : undefined;
}
