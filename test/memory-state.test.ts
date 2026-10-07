import type { ConversationId } from "@earendil-works/pi-durable";
import { expect, test } from "vitest";
import type { Job } from "../src/kernel/jobs/state.ts";
import {
  applyFactOps,
  applyLoopOps,
  overCap,
  renderFacts,
  search,
  truncateToCap,
  type Fact,
  type Memory,
} from "../src/kernel/memory/state.ts";

function memory(...texts: string[]): Memory {
  const m: Memory = { nextId: 1, facts: [], loops: [], episodes: [] };
  applyFactOps(m, texts.map((text) => ({ op: "add", text })), 0);
  return m;
}

const fact = (id: number, text: string, updatedAt = id): Fact => ({ id: String(id), text, updatedAt });

test("add assigns ids and skips near-duplicates", () => {
  const m = memory("Dan prefers short replies.", "Dan lives in Berlin.");
  applyFactOps(m, [{ op: "add", text: "dan prefers SHORT replies" }], 5);
  expect(m.facts).toEqual([fact(1, "Dan prefers short replies.", 0), fact(2, "Dan lives in Berlin.", 0)]);
  expect(m.nextId).toBe(3);
  expect(renderFacts(m.facts)).toBe("- Dan prefers short replies.\n- Dan lives in Berlin.");
  expect(renderFacts([])).toBeUndefined();
});

test("update replaces text unless it duplicates another fact or the id is unknown", () => {
  const m = memory("Dan prefers short replies.", "Dan lives in Berlin.");
  applyFactOps(m, [
    { op: "update", id: "2", text: "Dan prefers short replies" },
    { op: "update", id: "9", text: "ghost" },
    { op: "update", id: "1", text: "Dan prefers short replies, always." },
  ], 7);
  expect(m.facts).toEqual([fact(1, "Dan prefers short replies, always.", 7), fact(2, "Dan lives in Berlin.", 0)]);
});

test("a 51-word add is returned in tooLong; delete removes", () => {
  const m = memory("a fact", "b fact");
  const long = { op: "add" as const, text: Array(51).fill("w").join(" ") };
  expect(applyFactOps(m, [long, { op: "delete", id: "1" }], 1)).toEqual({ tooLong: [long] });
  expect(m.facts.map((f) => f.text)).toEqual(["b fact"]);
});

test("overCap and truncateToCap by count", () => {
  const facts = [fact(1, "a", 3), fact(2, "b", 1), fact(3, "c", 2)];
  const limits = { maxFacts: 2, maxTokens: 100 };
  expect(overCap(facts, limits)).toBe(true);
  const kept = truncateToCap(facts, limits);
  expect(kept.map((f) => f.id)).toEqual(["1", "3"]);
  expect(overCap(kept, limits)).toBe(false);
});

test("overCap and truncateToCap by tokens", () => {
  const facts = [fact(1, "x".repeat(40), 1), fact(2, "y".repeat(40), 2)]; // 10 tokens each
  const limits = { maxFacts: 30, maxTokens: 15 };
  expect(overCap(facts, limits)).toBe(true);
  expect(truncateToCap(facts, limits).map((f) => f.id)).toEqual(["2"]);
});

test("loops add and close", () => {
  const m = memory();
  applyLoopOps(m, [{ op: "add", text: "call the bank" }, { op: "add", text: "book dentist" }], 4);
  applyLoopOps(m, [{ op: "close", id: "1" }], 5);
  expect(m.loops).toEqual([{ id: "2", text: "book dentist", createdAt: 4 }]);
});

test("search ranks by distinct matches, newest first on ties, skips non-matches", () => {
  const m = memory();
  m.episodes = [
    { id: "1", at: 1000, text: "Talked about the Berlin trip" },
    { id: "2", at: 3000, text: "Booked the Berlin hotel for the trip" },
    { id: "3", at: 4000, text: "Nothing relevant" },
  ];
  const job = { id: "7", title: "Hotels", result: "berlin hotel shortlist", updatedAt: 2000, conversationId: 1 as ConversationId } as Job;
  const lines = search(m, { "7": job }, "Berlin hotel trip");
  expect(lines).toEqual([
    `${new Date(3000).toISOString()} episode: Booked the Berlin hotel for the trip`,
    `${new Date(2000).toISOString()} job 7 "Hotels": berlin hotel shortlist`,
    `${new Date(1000).toISOString()} episode: Talked about the Berlin trip`,
  ]);
});
