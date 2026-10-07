import { defineTool } from "@earendil-works/pi-durable";
import { Type } from "@earendil-works/pi-ai";
import { expect, test } from "vitest";
import { CORE_CONTRACTS } from "../src/kernel/contracts.ts";
import { defineJapaExtension, type JapaExtension, validateExtension } from "../src/kernel/extension.ts";

const contracts = new Map(CORE_CONTRACTS.map((c) => [c.name, c]));
const tool = defineTool({ name: "t", description: "d", parameters: Type.Object({}), execute: async () => ({}) });

test("a minimal extension is valid", () => {
  expect(validateExtension({ name: "x", summary: "Does x" }, contracts)).toEqual([]);
});

test("summary is required", () => {
  expect(validateExtension({ name: "x", summary: "" }, contracts)).toContain("summary is required");
});

test("tools require examples and docs", () => {
  const errors = validateExtension({ name: "x", summary: "s", provides: { tool: [tool] } }, contracts);
  expect(errors).toEqual(
    expect.arrayContaining(["examples are required when providing tools", "docs are required when providing tools"]),
  );
});

test("unknown contract is rejected", () => {
  expect(validateExtension({ name: "x", summary: "s", provides: { nope: [{}] } }, contracts)).toContain(
    'unknown contract "nope"',
  );
});

test("invalid contribution reports contract and index", () => {
  expect(validateExtension({ name: "x", summary: "s", provides: { surface: [{}] } }, contracts)[0]).toMatch(
    /^surface\[0\]: /,
  );
  const noParameters = { ...tool, parameters: undefined };
  expect(validateExtension({ name: "x", summary: "s", provides: { tool: [noParameters] } }, contracts)).toContain(
    "tool[0]: parameters must be an object",
  );
});

test("all seven core contracts exist", () => {
  expect([...contracts.keys()].sort()).toEqual([
    "environment",
    "provider",
    "secrets",
    "storage",
    "surface",
    "tool",
    "trigger",
  ]);
});

test("name must be kebab-case", () => {
  expect(validateExtension({ name: "Bad_Name", summary: "s" }, contracts)).toContain("name must be kebab-case");
});

test("name is required", () => {
  const e = { summary: "s" } as unknown as JapaExtension;
  expect(validateExtension(e, contracts)).toContain("name must be kebab-case");
});

test("a non-array provides entry is rejected", () => {
  const e = { name: "x", summary: "s", provides: { surface: {} } } as unknown as JapaExtension;
  expect(validateExtension(e, contracts)).toContain("surface: must be an array");
});

test("defineJapaExtension returns its argument unchanged", () => {
  const e = { name: "x", summary: "s" };
  expect(defineJapaExtension(e)).toBe(e);
});
