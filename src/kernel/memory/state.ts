import { defineDoc, type TaskId } from "@earendil-works/pi-durable";
import type { Job } from "../jobs/state.ts";

export type Fact = { id: string; text: string; updatedAt: number };
export type Loop = { id: string; text: string; createdAt: number };
export type Episode = { id: string; at: number; text: string };
export type Memory = {
  nextId: number;
  facts: Fact[];
  loops: Loop[];
  episodes: Episode[];
  lastResetAt?: number;
  previousResetAt?: number; // the board lists jobs finished since then: their reports left the window at the last reset
  consolidating?: TaskId; // the latest `Consolidate` task, live unless terminal
};
export type Limits = { maxFacts: number; maxTokens: number };

export type FactOp = { op: "add"; text: string } | { op: "update"; id: string; text: string } | { op: "delete"; id: string };
export type LoopOp = { op: "add"; text: string } | { op: "close"; id: string };

// On the root conversation.
export const MemoryDoc = defineDoc<Memory>({
  kind: "japa.memory",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({ nextId: 1, facts: [], loops: [], episodes: [] }),
});

const MAX_WORDS = 50;

function words(text: string): string[] {
  return text.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, "").split(/\s+/).filter(Boolean);
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

/** Applies ops to `memory` in place; adds and updates over 50 words are returned instead. */
export function applyFactOps(memory: Memory, ops: FactOp[], now: number): { tooLong: FactOp[] } {
  const tooLong: FactOp[] = [];
  for (const op of ops) {
    if (op.op === "delete") {
      memory.facts = memory.facts.filter((f) => f.id !== op.id);
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
  return { tooLong };
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

export function applyLoopOps(memory: Memory, ops: LoopOp[], now: number): void {
  for (const op of ops) {
    if (op.op === "add") memory.loops.push({ id: String(memory.nextId++), text: op.text, createdAt: now });
    else memory.loops = memory.loops.filter((l) => l.id !== op.id);
  }
}

function render(items: { text: string }[]): string | undefined {
  return items.length ? items.map((i) => `- ${i.text}`).join("\n") : undefined;
}

export const renderFacts = (facts: Fact[]) => render(facts);
export const renderLoops = (loops: Loop[]) => render(loops);

/** Episodes and job results ranked by distinct query words matched, newest first on ties. */
export function search(memory: Memory, jobs: Record<string, Job>, query: string, limit = 5): string[] {
  const terms = new Set(words(query));
  const items = [
    ...memory.episodes.map((e) => ({ at: e.at, text: e.text, line: `${new Date(e.at).toISOString()} episode: ${e.text}` })),
    ...Object.values(jobs)
      .filter((j) => j.result)
      .map((j) => ({ at: j.updatedAt, text: j.result!, line: `${new Date(j.updatedAt).toISOString()} job ${j.id} "${j.title}": ${j.result}` })),
  ];
  return items
    .map((i) => {
      const w = new Set(words(i.text));
      return { ...i, score: [...terms].filter((t) => w.has(t)).length };
    })
    .filter((i) => i.score > 0)
    .sort((a, b) => b.score - a.score || b.at - a.at)
    .slice(0, limit)
    .map((i) => i.line);
}
