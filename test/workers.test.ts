import { mkdtempSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { parseFrontmatter } from "../src/kernel/frontmatter.ts";
import { loadWorkers } from "../src/kernel/workers.ts";

function dirWith(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "japa-workers-"));
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
  return dir;
}

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

test("later dirs override earlier ones by name", () => {
  const a = dirWith({ "g.md": "---\nname: g\ndescription: first\n---\nA" });
  const b = dirWith({ "other.md": "---\nname: g\ndescription: second\n---\nB" });
  const { profiles, errors } = loadWorkers([a, b, join(a, "missing")], "/h");
  expect(errors).toEqual([]);
  expect(profiles.get("g")?.description).toBe("second");
  expect(profiles.get("g")?.instructions).toBe("B");
});

test("applies defaults", () => {
  const dir = dirWith({ "g.md": "---\nname: g\ndescription: d\n---\nbody" });
  expect(loadWorkers([dir], "/h").profiles.get("g")).toEqual({
    name: "g",
    description: "d",
    environment: "local",
    tools: [],
    instructions: "body",
  });
});

test("a bad profile is reported and skipped while its sibling loads", () => {
  const dir = dirWith({
    "bad.md": "---\nname: bad\n---\n",
    "good.md": "---\nname: good\ndescription: d\n---\n",
  });
  const { profiles, errors } = loadWorkers([dir], "/h");
  expect([...profiles.keys()]).toEqual(["good"]);
  expect(errors).toEqual([{ name: "worker:bad.md", error: expect.stringContaining("description") }]);
});

test("cwd expands a leading ~", () => {
  const dir = dirWith({ "g.md": "---\nname: g\ndescription: d\ncwd: ~/x\n---\n" });
  expect(loadWorkers([dir], "/h").profiles.get("g")?.cwd).toBe(join(homedir(), "x"));
});

test("cwd expands a leading $JAPA_HOME", () => {
  const dir = dirWith({ "g.md": "---\nname: g\ndescription: d\ncwd: $JAPA_HOME/.staging\n---\n" });
  expect(loadWorkers([dir], "/h").profiles.get("g")?.cwd).toBe("/h/.staging");
});

test("the shipped general and builder profiles load", () => {
  const { profiles, errors } = loadWorkers([join(import.meta.dirname, "..", "workers")], "/h");
  expect(errors).toEqual([]);
  expect(profiles.get("general")?.tools).toEqual(["read"]);
  expect(profiles.get("builder")).toMatchObject({
    tools: ["read", "write", "edit", "bash"],
    extensions: [],
    cwd: "/h/.staging",
  });
});
