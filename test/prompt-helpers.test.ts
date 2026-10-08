import { expect, test } from "vitest";
import { Cancelled, type Choice } from "../src/cli/prompt.ts";
import { scripted } from "./prompt-helpers.ts";

test("scripted answers select, text, secret and confirm in order", async () => {
  const p = scripted([
    ["pick one", "b"],
    ["your name", "  Bob  "],
    ["API key", "  s3cret\n"],
    ["are you sure", true],
  ]);
  const choices: Choice<string>[] = [
    { label: "A", value: "a" },
    { label: "B", value: "b" },
  ];
  expect(await p.select("pick one?", choices)).toBe("b");
  expect(await p.text("your name")).toBe("Bob"); // trimmed
  expect(await p.secret("API key")).toBe("s3cret"); // trimmed
  expect(await p.confirm("are you sure", false)).toBe(true);
  expect(p.asked).toEqual(["pick one?", "your name", "API key", "are you sure"]);
  p.done();
});

test("a function answer picks from the offered choices", async () => {
  const p = scripted([["pick", (choices: Choice<unknown>[]) => choices[1]!.value]]);
  const choices: Choice<string>[] = [
    { label: "A", value: "a" },
    { label: "B", value: "b" },
  ];
  expect(await p.select("pick one", choices)).toBe("b");
  p.done();
});

test("rejects a question that does not match the next step", async () => {
  const p = scripted([["expected text", "x"]]);
  await expect(p.text("a different question")).rejects.toThrow('expected "expected text", got "a different question"');
});

test('an answer of "cancel" throws Cancelled', async () => {
  const p = scripted([["pick", "cancel"]]);
  await expect(p.select("pick one", [{ label: "A", value: "a" }])).rejects.toThrow(Cancelled);
});

test("done() throws when steps remain", () => {
  const p = scripted([["unused", "x"]]);
  expect(() => p.done()).toThrow();
});

test("note records messages without consuming a step", () => {
  const p = scripted([]);
  p.note("hello");
  p.note("world");
  expect(p.notes).toEqual(["hello", "world"]);
});
