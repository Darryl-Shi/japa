import { expect, test } from "vitest";
import { rank, snippet, type Doc } from "../src/kernel/memory/search.ts";

const DAY = 86_400_000;
const NOW = 1_000 * DAY;

function doc(key: string, text: string, extra: Partial<Doc> = {}): Doc {
  return { key, kind: "you", text, at: NOW, ...extra };
}

test("a rare term outranks a common one", () => {
  const docs = [
    doc("a", "apple pie recipe"),
    doc("b", "apple tart"),
    doc("c", "apple juice"),
    doc("d", "banana bread recipe"),
    doc("e", "zebra crossing"),
  ];
  // "apple" is in 3 docs, "zebra" in 1: the zebra doc should rank first.
  const out = rank(docs, "apple zebra", NOW, 10);
  expect(out[0]!.key).toBe("e");
  expect(out.map((d) => d.key).sort()).toEqual(["a", "b", "c", "e"]);
});

test("recency halves the score every 14 days", () => {
  const docs = [doc("old", "dentist appointment", { at: NOW - 15 * DAY }), doc("new", "dentist appointment", { at: NOW - DAY }), doc("x", "other")];
  const out = rank(docs, "dentist", NOW, 10);
  expect(out.map((d) => d.key)).toEqual(["new", "old"]);
});

test("pages get a 1.5x bonus", () => {
  const docs = [doc("you1", "garden plans"), doc("page:1", "garden plans", { kind: "page", title: "Garden" }), doc("x", "other")];
  expect(rank(docs, "garden", NOW, 10).map((d) => d.key)).toEqual(["page:1", "you1"]);
  // The bonus beats less than 14 days of age difference (1.5 > 2 ** (ageDays/14) for ageDays < ~8.2).
  const aged = [doc("you1", "garden plans"), doc("page:1", "garden plans", { kind: "page", at: NOW - 7 * DAY }), doc("x", "other")];
  expect(rank(aged, "garden", NOW, 10).map((d) => d.key)).toEqual(["page:1", "you1"]);
});

test("no match returns nothing", () => {
  expect(rank([doc("a", "hello world")], "zebra", NOW, 10)).toEqual([]);
  expect(rank([doc("a", "hello world")], "", NOW, 10)).toEqual([]);
  expect(rank([], "hello", NOW, 10)).toEqual([]);
});

test("limit is honoured", () => {
  const docs = Array.from({ length: 8 }, (_, i) => doc(`d${i}`, `meeting notes ${i}`, { at: NOW - i * DAY }));
  const out = rank(docs, "meeting", NOW, 3);
  expect(out.map((d) => d.key)).toEqual(["d0", "d1", "d2"]);
});

test("matching ignores case and punctuation", () => {
  const out = rank([doc("a", "Call the DENTIST, please."), doc("b", "other")], "dentist?", NOW, 10);
  expect(out.map((d) => d.key)).toEqual(["a"]);
});

test("snippet centres on the match and is at most max characters", () => {
  const text = `${"lorem ipsum ".repeat(40)}the Dentist appointment is on Friday ${"dolor sit ".repeat(40)}`;
  const s = snippet(text, "dentist", 60);
  expect(s.length).toBeLessThanOrEqual(60);
  expect(s).toContain("Dentist");
  expect(s.startsWith("…")).toBe(true);
  expect(s.endsWith("…")).toBe(true);
  const at = s.indexOf("Dentist");
  // Roughly centred: the match starts in the middle third.
  expect(at).toBeGreaterThan(15);
  expect(at).toBeLessThan(45);
});

test("snippet of short text is the text; no match takes the start", () => {
  expect(snippet("short dentist note", "dentist", 60)).toBe("short dentist note");
  const text = "a".repeat(10) + " " + "b".repeat(100);
  const s = snippet(text, "zebra", 20);
  expect(s.length).toBeLessThanOrEqual(20);
  expect(s.startsWith("aaaa")).toBe(true);
  expect(s.endsWith("…")).toBe(true);
});

test("snippet at the very start or end has a cut only on the other side", () => {
  const text = `dentist ${"x ".repeat(100)}`;
  const s = snippet(text, "dentist", 30);
  expect(s.startsWith("dentist")).toBe(true);
  expect(s.endsWith("…")).toBe(true);
  expect(s.length).toBeLessThanOrEqual(30);
  const t = `${"x ".repeat(100)}dentist`;
  const e = snippet(t, "dentist", 30);
  expect(e.startsWith("…")).toBe(true);
  expect(e.endsWith("dentist")).toBe(true);
  expect(e.length).toBeLessThanOrEqual(30);
});
