import { expect, test } from "vitest";
import { parseFrontmatter } from "../src/kernel/frontmatter.ts";

test("parses scalars, lists, maps, comments and the body", () => {
  const text = [
    "---",
    "name: general # a comment",
    "",
    "tools: [read, grep]",
    "skills: []",
    "model: { provider: p, modelId: m }",
    "---",
    "",
    "Do the work.",
    "",
  ].join("\n");
  expect(parseFrontmatter(text)).toEqual({
    data: { name: "general", tools: ["read", "grep"], skills: [], model: { provider: "p", modelId: "m" } },
    body: "Do the work.",
  });
});

test("malformed frontmatter throws", () => {
  expect(() => parseFrontmatter("no frontmatter")).toThrow("missing frontmatter");
  expect(() => parseFrontmatter("---\nname: x\nbody")).toThrow("missing frontmatter");
  expect(() => parseFrontmatter("---\nname: x\njunk\n---\n")).toThrow('line 3: expected "key: value"');
});
