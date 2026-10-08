import { expect, test } from "vitest";
import { FilterableSelectList, prefilledInput } from "../src/cli/prompt.ts";

test("a prefilled input edits from the end of its value", () => {
  const input = prefilledInput("memory: ", "4g");

  input.handleInput("\x7f"); // Backspace
  input.handleInput("\x7f");
  input.handleInput("8");
  input.handleInput("g");

  expect(input.getValue()).toBe("8g");
});

test("typing into a prefilled input appends", () => {
  const input = prefilledInput("cpus: ", "2");

  input.handleInput("4");

  expect(input.getValue()).toBe("24");
});

test("typing under the Kitty keyboard protocol (CSI-u) still filters", () => {
  const list = new FilterableSelectList("pick one", [
    { value: "apple", label: "apple" },
    { value: "banana", label: "banana" },
    { value: "avocado", label: "avocado" },
  ]);

  // Kitty's CSI-u encoding for plain "a" (codepoint 97) -- what a Kitty-protocol terminal
  // (kitty, WezTerm, Ghostty, foot, ...) sends for every keystroke once the protocol is active,
  // instead of the literal "a" a non-Kitty terminal would send.
  list.handleInput("\x1b[97u");

  expect(list.render(80)).toEqual(expect.arrayContaining([expect.stringContaining("(filter: a)")]));
  // "banana" contains "a" but doesn't start with it -- confirms the filter actually narrowed
  // the underlying SelectList, not just recorded a character nobody read.
  expect(list.render(80).join("\n")).not.toContain("banana");
});

test("a non-printable CSI-u sequence (e.g. Kitty-encoded Ctrl+A) is not treated as filter text", () => {
  const list = new FilterableSelectList("pick one", [{ value: "apple", label: "apple" }]);

  // Kitty CSI-u for Ctrl+A: codepoint 97, modifier 5 (1 + ctrl bit 4) -- decodeKittyPrintable
  // rejects Ctrl/Alt modifiers, so this must not fall through to the plain-character branch either.
  list.handleInput("\x1b[97;5u");

  expect(list.render(80).join("\n")).not.toContain("filter:");
});
