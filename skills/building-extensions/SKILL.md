---
name: building-extensions
description: Use when writing or changing a japa extension (code in extensions/<name>/index.ts that implements contracts such as tool, surface or trigger).
---

# Building extensions

Write `~/.japa/extensions/<name>/index.ts`. Import only from `"japa/sdk"` and Node built-ins
(`node:fs`, ...). Its default export is the manifest. The packaged extensions, good examples, are in
`~/.japa/node_modules/japa/extensions/`; they import `../../src/sdk.ts` where yours imports
`japa/sdk`.

Your `~/.japa` is a private copy for this job. When you finish, your changes under
`~/.japa/extensions/<name>` go live if `japa check` passes (below); changes elsewhere in `~/.japa`
are dropped. You don't install anything yourself.

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
- `durable`: `{ sections, hooks, wraps, tasks }`, Pi Durable parts (the escape hatch, below).
- `secrets`: the secret names it may read, such as `"bank.apiKey"`, or `{ name, description }` to describe
  one to the user. Add `generated: true` when the extension makes its own value if none is set (a
  password, say): `japa setup` then never asks for it.
- `settings`: a `Type.Object(...)` schema for `settings.extensions.<name>`; give its properties
  `description`s too. Make every setting optional with a sensible default where you can: `japa setup`
  asks only for secrets and required settings, so an extension with defaults works with no setup.
- `setup(ctx)`: called with your `KernelContext` before your tools are installed (below).
- `status`: optional `() => string | undefined`, a short line shown under the extension in `japa status`.
- `authorize`: optional `{ run(ctx, io), connected(ctx) }`, for an extension that signs in to the user's
  account (below).

## Core contracts

- **tool**: a `defineTool({ name, description, parameters, execute })`. `parameters` is a `Type`
  schema; `execute(args, api, context)` returns `{ content: [{ type: "text", text }] }`. Keep the
  description under 1024 characters; prefix tool names with the extension name. Don't use
  `Type.Tuple` (or `prefixItems`/`additionalItems`): some model providers reject the whole request
  when any tool has a tuple, so the extension won't load. Use `Type.Array(item, { minItems, maxItems })`.
- **trigger**: `{ name, start(ctx) }` returning a dispose function. `ctx` is `{ home, emit }`;
  `emit({ key, text })` posts `[<extension>] <text>` to the chief of staff. The same `key` is delivered
  once, so make it unique per event.
- **surface**: `{ name, start(ctx) }` returning a dispose function. `ctx` has `home`;
  `root.submit(input, mode?, origin?)` (text, or text and image parts; pass `{ surface: <name>, chat?, id? }`
  so replies route back, and an `id` makes a resubmission a no-op); `root.abort()`; `root.events(listener)`;
  `root.replies(listener, after?)` (each finished reply's `text` with its `origin`, `"proactive"` or
  `{ surface, chat? }`, and a `cursor` to persist and pass as `after` after a restart); `jobs(listener)`;
  `secrets.pending(listener)` and `secrets.fulfil(requestId, value)`; and `status()`.
- **messaging**: a chat platform adapter, transport only (see Messaging adapters below).
- **environment**: `{ name, create({ conversationId, cwd }) }` returning a Pi Durable `ExecutionEnv`.
  The chief of staff's read-only tools run in the one named `local`; jobs always run in japa's sandbox.
- **provider**: a pi-ai model provider object with an `id`; its models become selectable.
- **storage**: `{ name, open(config, { home }) }` resolving to a Pi Durable `Storage`; chosen by
  settings `storage.adapter`.
- **secrets**: `{ name, open(config, { home }) }` resolving to `{ get, set, delete, list }`; chosen by
  settings `secrets.adapter`.

Storage and secrets are opened at boot, so they apply after a restart; the others apply when the change goes live.

## Messaging adapters

The types, all exported by `japa/sdk`:

```ts
interface MessagingAdapter {
  name: string; // the extension's name; also the surface name in origins
  maxMessageChars: number; // outgoing limit per message
  start(ctx: { receive(m: Incoming): Promise<void> }): Promise<Dispose>;
  send(chat: string, m: OutgoingMessage): Promise<string>; // returns the message id
  edit(chat: string, messageId: string, m: OutgoingMessage): Promise<void>;
  delete(chat: string, messageId: string): Promise<void>;
  typing(chat: string): Promise<void>;
  commands(list: { name: string; description: string }[]): Promise<void>;
}
type Incoming = {
  chat: string; user: string; messageId: string; id: string;
  text?: string; images?: { data: Uint8Array; mimeType: string }[];
  command?: string; // "jobs" for "/jobs"
  action?: string; // a pressed button's action
};
type OutgoingMessage = { markdown: string; buttons?: { label: string; action: string }[][] };
```

japa runs one messaging surface per adapter and provides: the owner check (anyone but
`settings.extensions.<name>.owner`, which japa adds to your settings schema, is told their user id),
the `/jobs`, `/status` and `/settings` commands and menus, secret requests, routing replies, merging
messages sent close together, saving images, splitting replies at `maxMessageChars`, and "typing…".

Your adapter does transport only. Convert `markdown` to the platform's format; register the
`commands(list)` it is given. In `start`, call `receive` for each message or button press and
confirm it upstream only after `receive` resolves. `Incoming.id` must be
unique on the platform (it deduplicates redeliveries). Handle only private chats. A proactive reply's
`chat` is the owner's user id. Reject button actions over 64 bytes.

Test it without japa: call `setup` with a stub `KernelContext` if it reads secrets, replace `fetch`
with `vi.stubGlobal`, call `adapter.start({ receive })` with a `receive` that records what it gets,
and assert the recorded messages and the requests made. The packaged `telegram` extension is the
example.

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

When a secret is missing, reply telling the chief of staff to ask for it with
`secret_request({ name, why })`. Code that can't work without a key can wait for it:
`secretProvided(name)` resolves with the value the next time a request for it is fulfilled, and
`requestSecret(name, why)` asks the user itself, then resolves the same way.
`setSecret(name, value)` stores a secret named in your manifest (for one you generate yourself).

An extension that signs in to the user's account (OAuth) declares `authorize: { run, connected }`.
`run(ctx, io)` signs in through `io` (pi-ai's `AuthInteraction`: `io.notify({ type: "auth_url", url,
instructions })` shows a link, `await io.prompt({ type: "manual_code", message, signal })` asks the user
to paste something; honour `io.signal`), stores what it gets with `ctx.setSecret` (declare that
secret `generated: true`), and returns a line such as "Connected as you@example.com"; it throws with a
user-facing message on failure. `connected(ctx)` says whether it's signed in now. You never call them:
`japa setup` runs `run` after the extension's secrets (offering "Sign in again?" when `connected`), and
the kernel tool `connect({ extension })` runs it from chat, passing the link to the user and turning a
prompt into a masked secret request. When a token is missing or refused, reply telling the chief of
staff to call `connect({ extension: "<name>" })`. The packaged `google` extension is the example.

## The escape hatch: `durable`

When the core contracts aren't enough, use Pi Durable through `japa/sdk`'s `defineDoc`, `defineTask`,
`section`, `hook` (with `ToolTask` or `GenerationTask`) and `wrapTool`:
- `sections`: text added to the system prompt (`section("name", async ({ read }, context) => ...)`).
- `hooks`: run code around tool calls and generations.
- `wraps`: decorate a tool by name.
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

From `~/.japa`, run

```
japa check extension <name>
```

It stops at the first failure of: a valid manifest (core contracts, valid contributions); tool
descriptions of at most 1024 characters; a typecheck (tests excluded); its `*.test.ts` files; and a
smoke load (loads without errors, appears in the capabilities, no tool name shared with another
extension or the kernel). It prints `ok` when all pass; fix each problem and rerun. The same check
runs when you finish: if it fails, nothing goes live.
