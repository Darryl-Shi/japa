import { defineTool } from "@earendil-works/pi-durable";
import { Type } from "@earendil-works/pi-ai";
import { expect, test } from "vitest";
import { validateExtension } from "../src/kernel/extension.ts";
import { schemaProblems } from "../src/kernel/tool-schema.ts";
import { bootTest } from "./helpers.ts";

test("a tuple anywhere in a tool's parameters is reported with its path", () => {
  const schema = Type.Object({
    region: Type.Optional(Type.Tuple([Type.Integer(), Type.Integer()])),
    path: Type.Array(Type.Tuple([Type.Integer(), Type.Integer()])),
    nested: Type.Object({ either: Type.Union([Type.String(), Type.Tuple([Type.Number()])]) }),
  });
  const problems = schemaProblems(schema);
  expect(problems.map((p) => p.split(":")[0])).toEqual([
    "parameters.properties.region",
    "parameters.properties.region",
    "parameters.properties.path.items",
    "parameters.properties.path.items",
    "parameters.properties.nested.properties.either.anyOf[1]",
    "parameters.properties.nested.properties.either.anyOf[1]",
  ]);
  expect(problems[0]).toMatch(/use an array with minItems\/maxItems/);
  expect(schemaProblems({ type: "array", prefixItems: [{ type: "string" }] })).toHaveLength(1);
});

test("arrays, unions, enums, records and optional fields are portable", () => {
  const schema = Type.Object({
    region: Type.Array(Type.Integer(), { minItems: 4, maxItems: 4 }),
    path: Type.Array(Type.Array(Type.Integer(), { minItems: 2, maxItems: 2 })),
    kind: Type.Union([Type.Literal("a"), Type.Literal("b")]),
    tags: Type.Record(Type.String(), Type.Number()),
    note: Type.Optional(Type.String()),
  });
  expect(schemaProblems(schema)).toEqual([]);
});

test("an extension whose tool has a tuple doesn't load", () => {
  const tool = defineTool({
    name: "t",
    description: "d",
    parameters: Type.Object({ at: Type.Tuple([Type.Integer(), Type.Integer()]) }),
    execute: async () => ({ content: [] }),
  });
  const errors = validateExtension({ name: "x", summary: "s", examples: ["x"], docs: "d", provides: { tool: [tool] } });
  expect(errors).toHaveLength(1);
  expect(errors[0]).toMatch(/^tool\[0\]: parameters\.properties\.at: "items" is a list \(a tuple\)/);
});

test("every tool japa ships -- kernel and packaged extensions -- has a portable schema", async () => {
  const { daemon } = await bootTest();
  try {
    const tools = daemon.registry.snapshot().tools().map((t) => t.tool);
    expect(tools.map((t) => t.name)).toContain("computer"); // the packaged extensions' tools are in there
    const problems = tools.flatMap((t) => schemaProblems(t.parameters).map((p) => `${t.name}: ${p}`));
    expect(problems).toEqual([]);
  } finally {
    await daemon.close();
  }
});
