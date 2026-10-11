import { expect, test } from "vitest";
import {
  applyFactOps,
  expireLegacy,
  hasEvidence,
  MAX_WORDS,
  MemoryDoc,
  offScope,
  overCap,
  renderFacts,
  truncateToCap,
  type Fact,
  type Memory,
  words,
} from "../src/kernel/memory/state.ts";

function memory(...texts: string[]): Memory {
  const m: Memory = { nextId: 1, facts: [] };
  applyFactOps(m, texts.map((text) => ({ op: "add", text })), 0);
  return m;
}

const fact = (id: number, text: string, updatedAt = id): Fact => ({ id: String(id), text, updatedAt });

test("a fresh memory is empty and already sorted", () => {
  expect(MemoryDoc.definition.initial()).toEqual({ nextId: 1, facts: [], sorted: true });
});

test("add assigns ids and skips near-duplicates", () => {
  const m = memory("Dan prefers short replies.", "Dan lives in Berlin.");
  applyFactOps(m, [{ op: "add", text: "dan prefers SHORT replies" }], 5);
  expect(m.facts).toEqual([fact(1, "Dan prefers short replies.", 0), fact(2, "Dan lives in Berlin.", 0)]);
  expect(m.nextId).toBe(3);
  expect(renderFacts(m.facts)).toBe("- Dan prefers short replies.\n- Dan lives in Berlin.");
  expect(renderFacts([])).toBeUndefined();
});

test("words split on punctuation", () => {
  expect(words("dshi-home-server, v2.1!")).toEqual(["dshi", "home", "server", "v2", "1"]);
  expect(words("Dan's  CAFÉ")).toEqual(["dans", "café"]);
  // Apostrophes join, straight or curly.
  expect(words("don't, I’m sure")).toEqual(["dont", "im", "sure"]);
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

test("a 31-word add is returned in tooLong, 30 words fit; delete removes", () => {
  expect(MAX_WORDS).toBe(30);
  const m = memory("a fact", "b fact");
  const long = { op: "add" as const, text: Array(31).fill("w").join(" ") };
  const fits = { op: "add" as const, text: Array(30).fill("v").join(" ") };
  expect(applyFactOps(m, [long, fits, { op: "delete", id: "1" }], 1)).toEqual({ tooLong: [long], rejected: [] });
  expect(m.facts.map((f) => f.text)).toEqual(["b fact", fits.text]);
});

test("a path, URL, IP, hash or job reference is rejected with its reason", () => {
  const cases: [string, string][] = [
    ["Keeps notes in ~/notes", "a file path"],
    ["Repo lives at /srv/japa", "a file path"],
    ["/home/dan is the home", "a file path"],
    ["Reads https://example.com daily", "a URL"],
    ["Home server at 192.168.0.32", "an IP address"],
    ["Merged commit 1688bbf yesterday", "a commit or hash"],
    ["Waiting on job 68 to finish", "a job reference"],
    ["Asked about Job 7", "a job reference"],
  ];
  for (const [text, reason] of cases) expect(offScope(text), text).toBe(reason);
  expect(offScope("Prefers RMB/SGD prices")).toBeUndefined();
  expect(offScope("Uses boat.dev")).toBeUndefined();
  expect(offScope("Was deadbeefed by accident")).toBeUndefined(); // hex letters only, no digit
  expect(offScope("Started a new job 2 weeks ago")).toBeUndefined(); // a span of time, not a job
  expect(offScope("Budget is 1000000 SGD")).toBeUndefined(); // digits only, no hex letter
  expect(offScope("Pinned to commit 8cad62a")).toBe("a commit or hash");
  expect(offScope("Waiting on job #68")).toBe("a job reference");

  const m = memory("Dan lives in Berlin.");
  const add = { op: "add" as const, text: "Server at 192.168.0.32" };
  const update = { op: "update" as const, id: "1", text: "Dan works in ~/work" };
  const long = { op: "add" as const, text: `${Array(40).fill("w").join(" ")} job 9` }; // the filter runs first
  expect(applyFactOps(m, [add, update, long, { op: "add", text: "Prefers RMB/SGD prices" }], 3)).toEqual({
    tooLong: [],
    rejected: [
      { op: add, reason: "an IP address" },
      { op: update, reason: "a file path" },
      { op: long, reason: "a job reference" },
    ],
  });
  expect(m.facts.map((f) => f.text)).toEqual(["Dan lives in Berlin.", "Prefers RMB/SGD prices"]);
});

test("evidence must be a quote of 3+ words", () => {
  const lines = ["user: I'm Ada,   I prefer SHORT answers", "user: tea please"];
  expect(hasEvidence("i prefer short answers", lines)).toBe(true);
  expect(hasEvidence("I  prefer\nshort", lines)).toBe(true); // whitespace collapsed
  expect(hasEvidence("tea please", lines)).toBe(false); // two words
  expect(hasEvidence("I prefer long answers", lines)).toBe(false); // not a quote
  expect(hasEvidence("short answers user: tea", lines)).toBe(false); // spans two lines
  expect(hasEvidence("I prefer short", [])).toBe(false);
});

const migrate = (value: object, from: number) => MemoryDoc.definition.migrate!(value as never, from);

test("v2 migrates episodes to legacy and is unsorted", () => {
  const fact = { id: "1", text: "Ada likes tea", updatedAt: 5 };
  const episodes = [{ id: "2", at: 9, text: "Talked about tea" }];
  const migrated = migrate({ nextId: 3, facts: [fact], episodes, reflectedThrough: 40, reflecting: 7 }, 2);
  expect(migrated).toEqual({ nextId: 3, facts: [fact], legacyEpisodes: episodes, reflectedThrough: 40, reflecting: 7 });
  expect(migrated.sorted).toBeUndefined();
  expect(migrate({ nextId: 3, facts: [], episodes: [], upgraded: { loops: ["call"] } }, 2)).toEqual({
    nextId: 3,
    facts: [],
    legacyEpisodes: [],
    upgraded: { loops: ["call"] },
  });
});

test("v1 still migrates", () => {
  const fact = { id: "1", text: "Ada likes tea", updatedAt: 5 };
  const episodes = [{ id: "2", at: 9, text: "Talked about tea" }];
  expect(
    migrate(
      {
        nextId: 4,
        facts: [fact],
        loops: [{ id: "3", text: "call the bank", createdAt: 1 }],
        episodes,
        lastResetAt: 7,
        previousResetAt: 2,
        consolidating: 9,
      },
      1,
    ),
  ).toEqual({ nextId: 4, facts: [fact], legacyEpisodes: episodes, upgraded: { loops: ["call the bank"] } });
});

test("legacy episodes expire", () => {
  const episodes = [{ id: "2", at: 9, text: "Talked about tea" }];
  const m: Memory = { nextId: 3, facts: [], legacyEpisodes: episodes, legacyUntil: 100 };
  expireLegacy(m, 100);
  expect(m.legacyEpisodes).toEqual(episodes);
  expireLegacy(m, 101);
  expect(m).toEqual({ nextId: 3, facts: [] });

  const unsorted: Memory = { nextId: 3, facts: [], legacyEpisodes: episodes }; // Sort hasn't set legacyUntil yet
  expireLegacy(unsorted, Number.MAX_SAFE_INTEGER);
  expect(unsorted.legacyEpisodes).toEqual(episodes);
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
