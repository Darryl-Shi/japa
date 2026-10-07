# Extensions and adapters

[Architecture](../ARCHITECTURE.md) explains the boundaries. This guide explains how to use them. The public surface is [`src/index.ts`](../src/index.ts); exact contracts live in [`src/core/contracts.ts`](../src/core/contracts.ts).

## One extension shape

```ts
interface Extension {
  name: string;
  adapters?: AdapterFactories;
  register?(host: Host): DurableExtension;
  start?(host: Host): Promise<Dispose | void>;
}
```

- `adapters` supplies lazy factories for any of the eight core slots. Factories must not access storage before it opens. Circular adapter resolution is rejected.
- `register` synchronously returns native Pi Durable contributions. Keep it side-effect-free: capture the host for later execution, but do not start work or access live storage here. The contribution's name must match the extension name.
- `start` runs after storage opens, in composition order. Return cleanup for sockets, readers, subscriptions, or other resources. Host shutdown runs cleanup in reverse order before closing the harness.

Use Pi Durable tools, sections, hooks, tasks, documents, and checkpoints directly. Do not build another task engine or registration framework around them. A packaged extension can declare native tasks; the generated-code installation path has stricter limits described below.

## Add a worker capability

A complete single-file extension:

```ts
import type { Extension } from "japa";
import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-durable";

export default {
  name: "hello",
  register() {
    return {
      name: "hello",
      tools: [
        defineTool({
          name: "hello",
          description: "Return a greeting.",
          parameters: Type.Object({ name: Type.String() }),
          replay: "safe",
          async execute({ name }) {
            return { content: [{ type: "text", text: `Hello, ${name}.` }] };
          },
        }),
      ],
    };
  },
} satisfies Extension;
```

A developer can add this extension to `Host.open({ extensions: [...] })`. A worker can pass its source to `extension_install`. The root does not gain this tool: its extension and tool selections are explicit. Default workers pick up installed capabilities on subsequent requests.

[`examples/weather.ts`](../examples/weather.ts) shows cancellation, a request timeout, error handling, and an optional exported `selfTest()`. The example is not loaded by default; it is not a bundled weather integration.

### Replay is a promise

Declare `replay: "safe"` only if executing again after a crash is acceptable. Read-only requests may be safe while returning newer data. Writes to external systems need their own stable idempotency keys or reconciliation; the tool task alone cannot make them exactly-once.

Use the supplied `Context` for cancellation. Keep registration pure. Put work in tool execution or appropriate native task phases. Return concise evidence and artifact paths rather than large unbounded output.

## Replace an adapter

The host requires one provider per slot, or an explicit binding when several exist. A provider is chosen by extension name, not install order.

For example, given `home`, `models`, `channel`, and a `customMemory` implementing `MemoryProvider`, remove the default memory lifecycle and bind the replacement:

```ts
import { Host, defaultExtensions } from "japa";
import type { Extension } from "japa";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";

const memory: Extension = {
  name: "my-memory",
  adapters: { memory: () => customMemory },
};

const host = await Host.open({
  storage: await openNodeSqliteStorage(`${home}/japa.sqlite`),
  extensions: [
    memory,
    ...defaultExtensions({ home, models, channel }).filter(
      (extension) => extension.name !== "japa.memory",
    ),
  ],
  bindings: { memory: "my-memory" },
});
```

This is a composition fragment, not a complete launcher: the caller must create directories, hold a single-owner home lock, arrange shutdown, and prepare model authentication. [`src/cli.ts`](../src/cli.ts) is the complete packaged launcher.

**A binding changes adapter selection; it does not disable an extension's `register` or `start` hooks.** If replacing an extension with lifecycle side effects, remove that default extension from the composition too. For example, remove `japa.memory` when you do not want its file initialization, rather than only binding a different memory provider. Keep assistant ingress last.

The memory contract is intentionally small:

```ts
interface MemoryProvider {
  read(context: Context): Promise<{ text: string; revision: string }>;
  rewrite(
    text: string,
    revision: string,
    context: Context,
  ): Promise<{
    text: string;
    revision: string;
  }>;
}
```

The default returns a content hash as the revision and rejects stale rewrites. Preserve this conflict behavior in replacements. Keep the note small enough for the configured context budget. Operational history belongs in job records, not in an ever-growing memory note.

## Implement a channel and settings UI

A channel implements three parts:

| Member                                 | Requirement                                                                         |
| -------------------------------------- | ----------------------------------------------------------------------------------- |
| `settings`                             | A `SettingsUI` with `prompt` and `notify`                                           |
| `start(receive)`                       | Begin ingress and return async-compatible cleanup                                   |
| `send(address, message, key, context)` | Deliver text; use the stable delivery key when the transport supports deduplication |

An incoming message has `{ id, address: { channel, recipient }, text }`. Reuse the same ID when retrying the same transport event; don't generate a new ID on every retry. The default ingress deduplicates the combination of channel, recipient, and ID. It rejects text over 8,000 characters.

Addresses are routing identifiers, **not a multi-user authorization system**. The default product has one relationship/root and shared personal memory. A public channel must implement authentication and appropriate deployment isolation; it must not mix unrelated users into this root.

`SettingsUI` is defined in [`src/core/settings.ts`](../src/core/settings.ts):

- Choice prompts have stable option values, labels, and an optional default.
- Text prompts can request hidden secret input and an optional default.
- Return `undefined` to cancel; respect the context's abort signal.
- `notify` displays login progress, links, and device-code instructions.
- Setup responses must never be admitted as ordinary chat input or stored in transcripts.

Call `configureModels(home, channel.settings, context)` before opening the host and while holding its home lock. It returns a `ModelProvider`, or `undefined` for an explicitly saved disconnected state. With no usable configuration, cancelled initial setup throws. With a usable prior configuration, cancelled edits preserve it.

The built-in flow supports native OpenAI/Anthropic OAuth and API-key entry, refresh persistence, model choices, and local logout. Its first run chooses role defaults; detailed model selection is available in forced settings. To reopen setup, stop the host first, call with `{ force: true }`, and reopen it if a provider is returned. Other channels render these same primitives as their own forms or prompts; terminal commands are not a required UI design.

CLI command routing for `/approve <id>` and `/deny <id>` bypasses a model turn. A richer UI can use the approval adapter directly, preserving the originating address.

## Jobs and history

`JobRunner` supports:

- `start(brief, stableKey, context)` → durable job record.
- `list(context)` and `search(query, limit, context)` → detached records.
- `steer(id, message, stableKey, context)` → input to an active worker.
- `cancel(id, context)` → explicit cancellation of its owned work.

A brief contains `title`, `instructions`, `address`, and optional `commitmentId`. Provide the outcome, constraints, and success criteria explicitly: workers do not inherit the root transcript. The default workers share a workspace, not isolated computers.

Reuse stable keys after uncertainty or restart. A completed/failed/cancelled job needs a new attempt; steering it is rejected. Keyword search covers stored titles, briefs, and results, returning at most 20 records. Root tools request smaller summaries and retrieve individual records as needed.

## Wake hooks

Use the exported hook to notify the chief of staff about an extension event:

```ts
import { wakeChiefOfStaff } from "japa";

// Inside execution, with a trusted destination and a stable upstream event ID:
await wakeChiefOfStaff(
  host,
  {
    address,
    reason: "A watched item changed; review whether action is needed.",
    notify: false,
  },
  `watched-item:${eventId}`,
  context,
);
```

For a future one-shot wake:

```ts
import { scheduleWake, listWakes, cancelWake } from "japa";

const wake = await scheduleWake(
  host,
  {
    address,
    reason: "Review the outstanding decision.",
    at: Date.now() + 60_000,
  },
  "decision-follow-up-1",
  context,
);
const pending = (await listWakes(host, context)).filter(
  (item) => item.status === "scheduled",
);
await cancelWake(host, wake.id, context);
```

These fragments assume an open host using the default assistant/wakes composition, a Chord `Context`, and an originating `Address`. Do not call them during registration. In real integrations derive the key from a durable event or operation ID; the literal example key would intentionally suppress all later attempts using it.

- `at` is an absolute epoch timestamp in milliseconds; overdue wakes fire on resume.
- Keys are at most 200 characters; reasons are at most 2,000 characters.
- Up to 32 wakes may be scheduled at once.
- `notify` defaults to false. The root can still choose to use its `notify` tool.
- Cancellation only prevents a wake that has not been admitted yet.
- The process must be running. Choose another wake explicitly if repetition is needed.

Keep event reasons concise and treat external content as data. The event hook is not permission to bypass user intent or to route information to a different recipient. An integration still needs a real event source; calling this hook does not install a webhook server or monitoring daemon.

## Trusted hot installation

Workers have `extension_guide`, `extension_catalog`, and `extension_install`. The source must default-export a Japa extension. Current limits:

| Item          | Limit / rule                                                                             |
| ------------- | ---------------------------------------------------------------------------------------- |
| Name          | Lowercase slug, 1–64 characters; cannot replace packaged names                           |
| Source        | One TypeScript file, at most 100,000 characters                                          |
| Imports       | Node built-ins, `japa`, `japa/core`, and supported installed `@earendil-works/*` modules |
| Dependencies  | No npm installation or relative-file imports                                             |
| Contributions | Tools, sections, hooks, wrappers; no generated durable task definitions                  |
| Lifecycle     | No hot adapter or `start` replacements; use normal composition and restart               |
| Catalog       | 32 extensions, 16 revisions per extension; limits fail explicitly                        |

The loader typechecks, bundles, and probes code in a child process, optionally running exported `selfTest()`, before recording and activating it. Sources and bundles are content-addressed. Repeating an already accepted name/source is a receipt, not a rollback command.

New calls use new code; in-flight calls can retain old code. Interrupted activation is handled on restart, restoring a previous known-good revision when available. There is no automatic rollback for ordinary runtime errors, no state-migration rollback, and no undo of external effects.

**All installed code is trusted.** The child probe, protected registration names, root allowlist, and tool policy are not isolation from arbitrary code. Run the entire assistant in an appropriately restricted environment. See [operations and recovery](OPERATIONS.md).
