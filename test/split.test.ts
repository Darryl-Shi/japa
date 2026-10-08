import { expect, test } from "vitest";
import { splitMessage } from "../src/kernel/messaging/split.ts";

test("a short message is one part", () => expect(splitMessage("hi", 4096)).toEqual(["hi"]));

test("parts break at paragraphs first, then lines", () => {
  const a = "a".repeat(3000), b = "b".repeat(3000);
  expect(splitMessage(`${a}\n\n${b}`, 4096)).toEqual([a, b]);
  expect(splitMessage(`${a}\n${b}`, 4096)).toEqual([a, b]);
});

test("then at words, and a word over the limit is cut", () => {
  const parts = splitMessage("word ".repeat(2000).trim(), 4096);
  expect(parts.every((p) => p.length <= 4096 && !p.startsWith(" ") && !p.endsWith(" "))).toBe(true);
  expect(splitMessage("x".repeat(5000), 4096)).toEqual(["x".repeat(4096), "x".repeat(904)]);
});

test("a code block split across parts is closed and reopened", () => {
  const code = Array.from({ length: 300 }, (_, i) => `line ${i} ${"x".repeat(20)}`).join("\n");
  const parts = splitMessage(`Here:\n\n\`\`\`ts\n${code}\n\`\`\``, 4096);
  expect(parts.length).toBeGreaterThan(1);
  expect(parts.every((p) => p.length <= 4096 && (p.match(/```/g) ?? []).length % 2 === 0)).toBe(true);
  expect(parts[1]!.startsWith("```ts\n")).toBe(true);
  expect(parts[2]!.startsWith("```ts\n")).toBe(true); // reopened after a cut inside the block
});

test("a code block with a line too long for a part still splits", { timeout: 2000 }, () => {
  for (const code of ["x".repeat(5000), "word ".repeat(1200)]) {
    const parts = splitMessage("```\n" + code + "\n```", 4096);
    expect(parts.every((p) => p.length <= 4096 && (p.match(/```/g) ?? []).length % 2 === 0)).toBe(true);
  }
});
