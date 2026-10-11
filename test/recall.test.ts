import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import type { EntryId, EntryRecord } from "@earendil-works/pi-durable";
import { expect, test, vi } from "vitest";
import type { Job } from "../src/kernel/jobs/state.ts";
import { corpus, createHistory } from "../src/kernel/memory/history.ts";
import { renderRecall } from "../src/kernel/memory/recall.ts";
import type { Scratchpad } from "../src/kernel/memory/scratchpad.ts";
import type { Doc } from "../src/kernel/memory/search.ts";
import type { Memory } from "../src/kernel/memory/state.ts";
import type { HistoryMessage } from "../src/kernel/memory/transcript.ts";
import { bootTest, waitFor } from "./helpers.ts";
import { ask, say, script } from "./jobs-helpers.ts";

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const NOW = Date.UTC(2026, 9, 11, 12, 0);
const HEADER = "[From earlier: found by search; may be incomplete]";

const id = (n: number) => n as EntryId;
const message = (n: number, kind: HistoryMessage["kind"], text: string, at = NOW - HOUR): HistoryMessage => ({
  id: id(n),
  kind,
  text,
  at,
});
const msgDoc = (n: number, text: string, at = NOW - HOUR, kind: Doc["kind"] = "you"): Doc => ({
  key: String(n),
  kind,
  text,
  at,
  id: id(n),
});

// Everyday chat sharing the query's common words ("do", "about", "my", "remember", "what", "the", …), never its rare one.
const FILLER = [
  "what do you think about the weather this week",
  "do you remember my dentist is on friday",
  "remember to water the plants tomorrow",
  "what about dinner near the office",
  "do I need to book the table for my mum",
  "can you remind me what the router password is",
  "tell me about the parcel, is it delivered",
  "what did the accountant say about my invoice",
  "do the laptop battery thing again",
  "I don't remember where my keys are",
];

test("the superpowers replay", () => {
  const complaint =
    "yeah it's basically that because too much ceremony. spec and discovery and planning before every change, " +
    "every small fix turns into a design review and a plan with checkboxes and then a subagent review of the plan, " +
    "and by the time anything is written I have forgotten what I wanted. superpowers makes the agent ask five " +
    "questions before touching a file, and that's the bit I can't stand anymore on small personal projects";
  const docs = [
    msgDoc(9846, complaint, Date.UTC(2026, 9, 10, 11, 42)),
    ...Array.from({ length: 50 }, (_, i) => msgDoc(10_000 + i, FILLER[i % FILLER.length]!, NOW - (i + 1) * HOUR)),
  ];
  const query = "do u not remember my complaint about superpowers";
  const out = renderRecall({ query, docs, exclude: new Set(), now: NOW })!;
  const lines = out.split("\n");
  expect(lines[0]).toBe(HEADER);
  expect(lines[1]).toMatch(/^you · 1 d ago · #9846: …/);
  // The snippet is centred on the rare term, not on an early "the" or "what".
  const body = lines[1]!.slice(lines[1]!.indexOf(": ") + 2);
  expect(body.length).toBeLessThanOrEqual(400);
  const at = body.indexOf("superpowers");
  expect(at).toBeGreaterThan(100);
  expect(at).toBeLessThan(300);
});

test("excluded keys never appear", () => {
  const docs = [msgDoc(1, "the boiler is broken again"), msgDoc(2, "boiler repair booked"), msgDoc(3, "other")];
  const out = renderRecall({ query: "boiler", docs, exclude: new Set(["1"]), now: NOW })!;
  expect(out).toContain("#2:");
  expect(out).not.toContain("#1:");
  expect(renderRecall({ query: "boiler", docs, exclude: new Set(["1", "2"]), now: NOW })).toBeUndefined();
});

test("at most 5 hits within 6,000 characters", () => {
  const many = Array.from({ length: 9 }, (_, i) => msgDoc(i + 1, `garden ${"word ".repeat(150)}${i}`));
  const out = renderRecall({ query: "garden", docs: [...many, msgDoc(99, "other")], exclude: new Set(), now: NOW })!;
  const hits = out.split("\n").slice(1);
  expect(hits).toHaveLength(5);
  for (const hit of hits) expect(hit).toMatch(/^you · 1 h ago · #\d+: garden word/);
  expect(hits.every((h) => h.length < 450)).toBe(true); // snippets of 400

  // Pages with very long titles: each line is ~2,650 characters, so only two fit in 6,000.
  const title = (i: number) => `Garden ${i} ${"x".repeat(990)}`;
  const pages: Doc[] = Array.from({ length: 4 }, (_, i) => ({
    key: `page:${i + 1}`,
    kind: "page",
    text: `${title(i)}\n${"plan ".repeat(200)}`,
    at: NOW - HOUR,
    title: title(i),
  }));
  const big = renderRecall({ query: "garden", docs: [...pages, msgDoc(99, "other")], exclude: new Set(), now: NOW })!;
  expect(big.length).toBeLessThanOrEqual(6000);
  expect(big.split("\n").slice(1)).toHaveLength(2);
});

test("each kind of hit has its own line", () => {
  const page: Doc = {
    key: "page:3",
    kind: "page",
    text: `Home servers\n${"two boxes: dshi-home-server and a nas.\n".repeat(30)}`,
    at: NOW - 2 * HOUR,
    title: "Home servers",
  };
  const job: Doc = {
    key: "job:68",
    kind: "job",
    text: '"Server cleanup": disk use on the server went from 74 GB to 45 GB',
    at: NOW - 3 * HOUR,
    title: "Server cleanup",
  };
  const episode: Doc = { key: "episode:4", kind: "episode", text: "Talked about the server move", at: NOW - 3 * DAY };
  const docs = [page, job, episode, msgDoc(7, "japa moved the server", NOW - 5 * MIN, "japa"), msgDoc(99, "other")];
  const lines = renderRecall({ query: "server", docs, exclude: new Set(), now: NOW })!.split("\n").slice(1);
  const body = "two boxes: dshi-home-server and a nas. ".repeat(30).trim();
  expect(lines).toEqual(
    expect.arrayContaining([
      `page "Home servers" · updated 2 h ago: ${body.slice(0, 599)}… (page_read "Home servers")`,
      'job 68 "Server cleanup" · 3 h ago: disk use on the server went from 74 GB to 45 GB (job_transcript 68)',
      "note · 3 d ago: Talked about the server move",
      "japa · 5 min ago · #7: japa moved the server",
    ]),
  );
  expect(lines).toHaveLength(4);
});

test("automated messages are labelled as the window labels them", () => {
  const report: Doc = { ...msgDoc(5, '[job 68 "Cleanup" done] the server cleanup freed 29 GB', NOW - HOUR, "auto"), job: "68" };
  const event = msgDoc(6, "[whatsapp] the server link dropped", NOW - 2 * HOUR, "auto");
  const secret = msgDoc(7, "[secret server-key provided]", NOW - 3 * HOUR, "auto");
  const lines = renderRecall({ query: "server", docs: [report, event, secret, msgDoc(99, "other")], exclude: new Set(), now: NOW })!
    .split("\n")
    .slice(1);
  expect(lines).toHaveLength(3);
  expect(lines).toEqual(
    expect.arrayContaining([
      "job 68 report \u00b7 1 h ago \u00b7 #5: the server cleanup freed 29 GB",
      "[whatsapp] \u00b7 2 h ago \u00b7 #6: the server link dropped",
      "[secret server-key provided] \u00b7 3 h ago \u00b7 #7: secret server-key provided",
    ]),
  );
});

test("an origin hit comes first and is labelled you asked", () => {
  const origin = message(11765, "you", "clean up the server: jellyfin and maria can go", NOW - 2 * HOUR);
  const docs = [msgDoc(11765, origin.text, origin.at), msgDoc(12000, "the server is slow today"), msgDoc(99, "other")];
  const out = renderRecall({ query: "server report", docs, exclude: new Set(), origin, now: NOW })!;
  expect(out.split("\n")).toEqual([
    HEADER,
    "you asked · 2 h ago · #11765: clean up the server: jellyfin and maria can go",
    "you · 1 h ago · #12000: the server is slow today",
  ]);
  // The origin alone, even with no other hit.
  expect(renderRecall({ query: "zzz", docs, exclude: new Set(), origin, now: NOW })!.split("\n")).toHaveLength(2);
});

test("an automated origin is labelled started by", () => {
  const origin = message(11770, "auto", '[schedule 3 "Weekly"] tidy the server', NOW - 2 * HOUR);
  const docs = [msgDoc(11770, origin.text, origin.at, "auto"), msgDoc(99, "other")];
  expect(renderRecall({ query: "server", docs, exclude: new Set(), origin, now: NOW })!.split("\n")).toEqual([
    HEADER,
    'started by · 2 h ago · #11770: [schedule 3 "Weekly"] tidy the server',
  ]);
});

test("a hit too big to fit is skipped, and smaller later ones still fit", () => {
  // Pages with very long titles (~2,650 characters a line): two fit in 6,000, the third doesn't.
  const title = (i: number) => `Garden ${i} ${"x".repeat(990)}`;
  const pages: Doc[] = Array.from({ length: 3 }, (_, i) => ({
    key: `page:${i + 1}`,
    kind: "page",
    text: `${title(i)}\n${"plan ".repeat(200)}`,
    at: NOW - HOUR - i * MIN,
    title: title(i),
  }));
  // A month old: it ranks after the pages.
  const small = msgDoc(7, "the garden gate", NOW - 30 * DAY);
  const out = renderRecall({ query: "garden", docs: [...pages, small, msgDoc(99, "other")], exclude: new Set(), now: NOW })!;
  const hits = out.split("\n").slice(1);
  expect(hits).toHaveLength(3);
  expect(hits[2]).toBe("you · 2026-09-11 · #7: the garden gate");
  expect(out.length).toBeLessThanOrEqual(6000);
});

test("no hits renders nothing", () => {
  expect(renderRecall({ query: "zebra", docs: [msgDoc(1, "hello")], exclude: new Set(), now: NOW })).toBeUndefined();
  expect(renderRecall({ query: "", docs: [msgDoc(1, "hello")], exclude: new Set(), now: NOW })).toBeUndefined();
  expect(renderRecall({ query: "hello", docs: [], exclude: new Set(), now: NOW })).toBeUndefined();
});

test("corpus includes archived pages, job results and legacy episodes", () => {
  const messages = [message(1, "you", "hi", 10), { ...message(2, "japa", "hello", 20), did: "did: x" }];
  const memory: Memory = { nextId: 1, facts: [], legacyEpisodes: [{ id: "4", at: 5, text: "an old episode" }] };
  const pad: Scratchpad = {
    nextId: 3,
    pages: [
      { id: "1", title: "Active", text: "now", updatedAt: 30 },
      { id: "2", title: "Old", text: "then", updatedAt: 3, archivedAt: 40 },
    ],
  };
  const job = (n: string, result?: string): Job => ({
    id: n,
    title: `Job ${n}`,
    brief: "b",
    status: result === undefined ? "running" : "done",
    conversationId: 9 as Job["conversationId"],
    createdAt: 1,
    updatedAt: 50,
    seq: 0,
    reported: [],
    ...(result === undefined ? {} : { result }),
  });
  const docs = corpus(messages, memory, pad, { "1": job("1", "all clean"), "2": job("2") });
  expect(docs).toEqual(
    expect.arrayContaining([
      { key: "1", kind: "you", text: "hi", at: 10, id: 1 },
      { key: "2", kind: "japa", text: "hello", at: 20, id: 2 },
      { key: "job:1", kind: "job", text: '"Job 1": all clean', at: 50, title: "Job 1" },
      { key: "page:1", kind: "page", text: "Active\nnow", at: 30, title: "Active" },
      { key: "page:2", kind: "page", text: "Old\nthen", at: 3, title: "Old" },
      { key: "episode:4", kind: "episode", text: "an old episode", at: 5 },
    ]),
  );
  expect(docs).toHaveLength(6);
  expect(corpus([], { nextId: 1, facts: [] }, { nextId: 1, pages: [] }, {})).toEqual([]);
});

test("a job report's doc carries its job", () => {
  const report = { ...message(3, "auto", '[job 1 "Job 1" done] all clean'), job: "1" };
  expect(corpus([report], { nextId: 1, facts: [] }, { nextId: 1, pages: [] }, {})).toEqual([
    { key: "3", kind: "auto", text: report.text, at: report.at, id: 3, job: "1" },
  ]);
});

test("the mirror catches up incrementally", async () => {
  const { daemon, faux } = await bootTest();
  script(faux, (role, text) => {
    if (role === "user" && text === "first question") return say("first answer");
    if (role === "user" && text === "second question") return say("second answer");
  });
  const history = createHistory();
  history.attach(daemon.root);
  const entries = vi.spyOn(daemon.root, "entries");

  // A run's reset follows its settle; wait for it, so `lastReset` is deterministic.
  const settled = async () => (await daemon.root.entries({}, 1, undefined, ctx)).items[0]?.kind === "pi.reset";
  await ask(daemon, "first question");
  await waitFor(settled);
  const first = await history.refresh(ctx);
  expect(first.messages.map((m) => [m.kind, m.text])).toEqual([
    ["you", "first question"],
    ["japa", "first answer"],
  ]);

  await ask(daemon, "second question");
  await waitFor(settled);
  const calls = entries.mock.calls.length;
  const second = await history.refresh(ctx);
  expect(second.messages.map((m) => [m.kind, m.text])).toEqual([
    ["you", "first question"],
    ["japa", "first answer"],
    ["you", "second question"],
    ["japa", "second answer"],
  ]);
  // Only the new entries were read.
  const query = entries.mock.calls[calls]![0];
  expect(query.minEntryId).toBeGreaterThan(first.messages[1]!.id);

  // `lastReset` is the newest reset: here, the newest entry.
  const newest: EntryRecord = (await daemon.root.entries({}, 1, undefined, ctx)).items[0]!;
  expect(newest.kind).toBe("pi.reset");
  expect(first.lastReset).toBeLessThan(newest.id);
  expect(second.lastReset).toBe(newest.id);
  await daemon.close();
});
