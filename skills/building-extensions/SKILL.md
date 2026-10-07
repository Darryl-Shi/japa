---
name: building-extensions
description: Use when writing or changing a japa extension (code in extensions/<name>/index.ts that implements contracts such as tool, surface or trigger).
---

# Building extensions

Write `extensions/<name>/index.ts` in the current directory (the staging copy of `~/.japa`). Import
only from `"japa/sdk"` and Node built-ins (`node:fs`, ...). Its default export is the manifest. The
packaged extensions, good examples, are in `../node_modules/japa/extensions/`.

## Minimal example

```ts
import { defineJapaExtension, defineTool, Type } from "japa/sdk";

export const roll = defineTool({
  name: "dice_roll",
  description: "Roll a die with the given number of sides (default 6).",
  parameters: Type.Object({ sides: Type.Optional(Type.Integer({ minimum: 1 })) }),
  execute: async ({ sides = 6 }) => ({
    content: [{ type: "text", text: `Rolled ${1 + Math.floor(Math.random() * sides)}` }],
  }),
});

export default defineJapaExtension({
  name: "dice",
  summary: "Rolls dice",
  examples: ["roll a d20 for me"],
  docs: "dice_roll({ sides? = 6 }) replies `Rolled <n>`.",
  provides: { tool: [roll] },
});
```

## The manifest (`defineJapaExtension`)

- `name`: kebab-case; equals the directory name.
- `summary`: one line, shown in the chief of staff's capabilities. Required.
- `examples` (user requests it serves) and `docs` (its tools and their arguments): required when it
  provides tools.
- `provides`: contributions as lists keyed by contract name: `{ tool: [...], trigger: [...] }`.
- `contracts`: contracts this extension defines.
- `durable`: `{ sections, hooks, wraps, tasks }`, Pi Durable parts (the escape hatch, below).
- `secrets`: the secret names it may read, such as `"bank.apiKey"`.
- `settings`: a `Type.Object(...)` schema for `settings.extensions.<name>`.
- `setup(ctx)`: called with your `KernelContext` before your tools are installed (below).

## Core contracts

- **tool**: a `defineTool({ name, description, parameters, execute })`. `parameters` is a `Type`
  schema; `execute(args, api, context)` returns `{ content: [{ type: "text", text }] }`. Keep the
  description under 1024 characters; prefix tool names with the extension name.
- **trigger**: `{ name, start(ctx) }` returning a dispose function. `ctx` is `{ home, emit }`;
  `emit({ key, text })` posts `[<extension>] <text>` to the chief of staff. The same `key` is delivered
  once, so make it unique per event.
- **surface**: `{ name, start(ctx) }` returning a dispose function. `ctx` has `home`;
  `root.submit(text, mode?)`, `root.abort()` and `root.events(listener)`; `jobs(listener)`;
  `secrets.pending(listener)` and `secrets.fulfil(requestId, value)`; and `status()`.
- **environment**: `{ name, create({ conversationId, cwd }) }` returning a Pi Durable `ExecutionEnv`;
  worker profiles select it with `environment: <name>`.
- **provider**: a pi-ai model provider object with an `id`; its models become selectable.
- **storage**: `{ name, open(config, { home }) }` resolving to a Pi Durable `Storage`; chosen by
  settings `storage.adapter`.
- **secrets**: `{ name, open(config, { home }) }` resolving to `{ get, set, delete, list }`; chosen by
  settings `secrets.adapter`.

Storage and secrets are opened at boot, so they apply after a restart; the others apply on install.

## Settings and secrets: `KernelContext`

A `KernelContext` has `settings()` (the live `settings.extensions.<name>`; call it each time) and
`secret(name)` (throws for a name not in your manifest `secrets`). Tools get it through the manifest's
`setup(ctx)`, which runs before they are installed: keep `ctx` in a module variable and use it in
`execute`. `setup` may return a dispose function; if it throws, your tools are not installed.

```ts
let ctx: KernelContext; // import type { KernelContext } from "japa/sdk"
// in execute: const key = await ctx.secret("bank.apiKey");
export default defineJapaExtension({ /* ... */ secrets: ["bank.apiKey"], setup: (c) => { ctx = c; } });
```

A contract's `activate(contribution, ctx)` receives one too. When a secret is missing, reply telling
the chief of staff to ask for it with `secret_request({ name, why })`.

## Defining a contract

Put a `Contract` (a type from `japa/sdk`) in `contracts`: `{ name, docs, phase: "runtime",
cardinality: "many", validate, activate }`. `docs` is one agent-facing paragraph; `validate(c)`
returns an error message or `undefined`; `activate(c, ctx)` sets the contribution up and returns a
dispose function. Extensions then contribute with
`provides: { "<contract>": [...] }`. Extension-defined contracts activate after tools and before
triggers and surfaces. `web/index.ts` defines `search-engine` this way.

## The escape hatch: `durable`

When contracts aren't enough, use Pi Durable through `japa/sdk`'s `defineDoc`, `defineTask`,
`section`, `hook` and `wrapTool`:
- `sections`: text added to the system prompt (`section("name", async ({ read }, context) => ...)`).
- `hooks`: run code around tool calls and generations.
- `wraps`: decorate a tool or section by name.
- `tasks`: durable background work that survives restarts.

`schedule/index.ts` is the example: a `ScheduleDoc` on the root conversation holds the schedules;
each is a `ScheduleTask` that sleeps until its time, then submits a message to the root with a
`requestId`, so a re-run after a crash doesn't post twice; a section lists them. Its tools log
changes with `logChange(tx, { title, howToUse, undo })` inside `api.commit`.

## Testing

Put `*.test.ts` files next to the code and call tools directly:

```ts
import { expect, test } from "vitest";
import { roll } from "./index.ts";

test("a one-sided die rolls 1", async () => {
  const result = await roll.execute({ sides: 1 }, {} as never, {} as never);
  expect(result.content).toEqual([{ type: "text", text: "Rolled 1" }]);
});
```

Never call real services in tests; replace `fetch` with `vi.stubGlobal("fetch", ...)`. The check
below also boots your extension in a throwaway daemon with a faux model and in-memory storage.

## Check

From the staging directory, run

```
../node_modules/japa/src/cli/main.ts check extension <name>
```

(the same as `japa check extension <name>` run there). It stops at the first failure of: a valid
manifest (known contracts, valid contributions); tool descriptions of at most 1024 characters; a
typecheck (tests excluded); its `*.test.ts` files; and a smoke load (loads without errors, appears in
the capabilities, no tool name shared with another extension or the kernel). It prints `ok` when
all pass; fix each problem and rerun.
