# japa — a self-extensible "dot" on Pi Durable

> Status: **historical design draft**. This predates the agreed eight-adapter design and the first implementation. See [README.md](../../README.md), [the implemented architecture](../../ARCHITECTURE.md), and [the contracts](../../src/core/contracts.ts) for the current design, behavior, and limitations. The original proposal below is retained for reference; it is not an implementation guarantee.

## 1. Goal

japa is a personal, always-on agent in the spirit of OpenAI's *dots*. It has a persistent identity, it carries context across channels, it works in the background, it asks for approval when it should, and it has its own computer.

It differs from dots in one way: **japa can rewrite itself**. It can write new tools and behaviours as code extensions, hot-install them while running, and change its own configuration. Every one of these changes is durable and versioned, and it can be rolled back.

Design rules:

1. **Thin core, fat extensions.** The core defines a small set of contracts and the plumbing that makes them durable. Every user-visible behaviour is an extension, including Telegram, memory, scheduling, approvals, the persona, and even the self-modification tools.
2. **One extension model for humans and for the agent.** A built-in extension, a user extension, and an extension the agent wrote are the same kind of thing. They are loaded the same way.
3. **Durable by construction.** All state that matters lives in Pi Durable storage: transcripts, config, extension install records, channel offsets, approvals, and timers. If you kill the process at any point, the next boot continues where it left off.
4. **The agent can always repair itself.** A protected kernel (the core, the loader, and the `self` extension) cannot be modified by the agent. Bad extensions get quarantined automatically, and a safe-mode boot always works.

## 2. What we get from Pi Durable

These parts of `@earendil-works/pi-durable` 1.0.4 are the foundation. We don't reimplement any of them.

| Pi Durable gives us | japa uses it for |
|---|---|
| `Harness.open(storage, { models, registry, settings, env, conversationCreated })` | The process-wide runtime, on SQLite storage |
| `Registry.install/uninstall`: replaces an extension by name and publishes at once. New work uses the new code; running work finishes on the old code | **Hot reload of self-written extensions** |
| `Extension = { name, tools, sections, hooks, wraps, tasks }` | The compile target of every japa extension |
| Per-conversation `pi.agent` (model, thinking, extensions, tools, instructions, cwd) via `configure()` | Per-conversation specialisation (subagents, "specialist dots") |
| `HarnessSettings` is read on every use and getters make it live | Config edits take effect without a restart |
| Documents (`defineDoc`, session or conversation scope, `history: "rewindable"`) | Config, extension records, channel cursors, memory index |
| Durable tasks (`defineTask`, checkpoints, `runtime.sleep(until)`, child tasks, background tasks) | Schedules and timers, reply delivery, background research |
| `submit({ requestId })` is idempotent; inbox steer/follow-up | Exactly-once channel ingress, steering from chat |
| Hooks (`beforeTool`/`afterTool`/`onYield`/`beforeRequest`…), `api.memo()` | Policy and approvals that survive restarts |
| Ownership tree, subagent conversations, forks | Background workers, thread forks |
| `env(target)` → `ExecutionEnv` | The dot's "computer" (local or containerised) |
| `viewState()` / `watchEvents()` | Typing indicators, progress, future UIs |

What Pi Durable deliberately does **not** do, and japa's core therefore adds: process lifecycle, extension discovery/building/hot-reload, a config system, channel ingress and egress, approvals routing, and the service contracts in §4. (The Pi Durable spec lists "work scheduling" as a non-goal. Timers are ordinary tasks, so scheduling is an extension.)

## 3. Big picture

```
                ┌──────────┐            ┌──────────────┐           ┌───────────────┐
                │  Owner   │            │  LLM APIs    │           │  The web /    │
                │(Telegram)│            │ OpenAI, etc. │           │  other apps   │
                └────┬─────┘            └──────▲───────┘           └───────▲───────┘
                     │ msgs / approvals         │                           │
═════════════════════╪══════════════════════════╪═══════════════════════════╪═══════════════════
 EXTENSIONS          │  (behaviour: built-in · user · agent-written — all the same shape)
                     ▼                          │                           │
   ┌────────────┐ ┌────────────┐ ┌──────────────┴─┐ ┌───────────────┐ ┌─────┴──────────┐
   │ telegram   │ │ router     │ │ models-*       │ │ policy-rules  │ │ computer-local │
   │ «Channel»  │ │ «Router»   │ │«ModelProvider» │ │ «Policy»      │ │ «EnvProvider»  │
   └────────────┘ └────────────┘ └────────────────┘ │ approvals-chat│ │ + coding tools │
   ┌────────────┐ ┌────────────┐ ┌────────────────┐ │ «Approver»    │ └────────────────┘
   │ persona    │ │ memory     │ │ scheduler      │ └───────────────┘ ┌────────────────┐
   │ (section)  │ │ «Memory»   │ │ workers        │ ┌───────────────┐ │ agent-written  │
   └────────────┘ └────────────┘ │ proactive      │ │ self  🔒      │ │ ext. (hot)     │
                                 └────────────────┘ │ extension_*   │ └───────▲────────┘
                                                    │ config_*      │         │
                                                    └──────┬────────┘         │
═══════════════════════════════════════════════════════════╪══════════════════╪═════════════════
 CORE  (contracts + plumbing)                              │ write / set      │ install
   ┌─────────────────────┐   ┌─────────────────────────────▼──────────────────┴─────────────┐
   │ @japa/sdk contracts │   │ Loader                                                       │
   │  JapaExtension      │   │  typecheck → bundle → probe(child) → install → health → good │
   │  SetupApi / HostApi │   │  ↳ fail: diagnostics  ↳ crash/errors: quarantine + rollback  │
   │  Service tokens     │   └──────────────────────────────────────────────────────────────┘
   └─────────────────────┘   ┌────────────────┐ ┌────────────────┐ ┌──────────────────────┐
   ┌─────────────────────┐   │ Config store   │ │ Service        │ │ Ingress / Delivery   │
   │ Host (lifecycle,    │   │ schema-checked │ │ registry       │ │ exactly-once in,     │
   │ events, --safe)     │   │ live, revert   │ │ one / many     │ │ durable reply tasks  │
   └─────────────────────┘   └────────────────┘ └────────────────┘ └──────────────────────┘
                             ┌──────────────────────────────────────────────────────────────┐
                             │ Policy gate (beforeTool hook): deny / ask→Approver / allow   │
                             └──────────────────────────────────────────────────────────────┘
══════════════════════════════════════════════╤═════════════════════════════════════════════════
 PI DURABLE  (runtime)                        │ compiled extensions → registry.install()
   ┌──────────────────────────────────────────▼───────────────────────────────────────────┐
   │ Harness · Registry (hot-swap) · Hooks · Settings (live getters)                      │
   │                                                                                      │
   │   ┌──────────────────┐   owns    ┌─────────────────┐    ┌─────────────────────────┐  │
   │   │ root conversation│──────────▶│ worker / special│    │ durable tasks           │  │
   │   │ = "the dot"      │◀─reports──│ conversations   │    │ generation · tool ·     │  │
   │   │ (one mind across │           │ (subagents)     │    │ reply · deliver · timers│  │
   │   │  all channels)   │           └─────────────────┘    └─────────────────────────┘  │
   │   └──────────────────┘   documents: japa.config · japa.extensions · cursors · routes │
   └──────────────────────────────────────────┬───────────────────────────────────────────┘
══════════════════════════════════════════════╪═════════════════════════════════════════════════
 $JAPA_HOME                                   ▼
   ┌──────────────┐  ┌──────────────────────────┐  ┌─────────────────┐  ┌──────────────────┐
   │ japa.sqlite  │  │ extensions/  (git repo)  │  │ workspace/      │  │ memory/  logs/   │
   │ all durable  │  │ one commit per install,  │  │ the dot's       │  │                  │
   │ state        │  │ good/<name> tags         │  │ "computer"      │  │                  │
   └──────────────┘  └──────────────────────────┘  └─────────────────┘  └──────────────────┘
```

Key flows:

- **Message in, reply out:** telegram → `host.inbound` → Router → `root.submit(requestId)` + `japa.reply` task → generation/tools (through the policy gate) → `Channel.send`.
- **Self-extension:** the model calls `extension_write` → Loader pipeline → `registry.install()` → the next request sees the new tools. On failure: diagnostics go back to the model, or the extension is quarantined and rolled back.
- **Self-configuration:** `config_set` → schema check + policy → `japa.config` revision → live settings / `configure()` on the next request.
- **Proactive:** scheduler timer task → submit to the root or a worker → `message_user` → `japa.deliver` task → Telegram.

## 4. Core contracts

The core exports exactly these concepts. Everything else is built on them.

### 4.1 `JapaExtension`: the only plug point

```ts
// @japa/sdk
export interface JapaExtension<C = unknown> {
  name: string;                 // stable id; also the Pi Durable extension name
  description: string;          // shown to the model in the extension catalog
  version?: string;
  requires?: string[];          // service ids or extension names that must be present
  config?: { schema: TSchema; defaults: C };  // TypeBox; validated, namespaced under config.extensions[name]
  setup(api: SetupApi<C>): void | Promise<void>;
}

export function defineExtension<C>(ext: JapaExtension<C>): JapaExtension<C>;
```

`setup` runs on every (re)load. It only *registers* things. The host records each contribution under the extension's name, so an uninstall or reload removes exactly what was registered, with nothing left behind.

```ts
export interface SetupApi<C> {
  readonly name: string;
  readonly log: Logger;
  config(): Live<C>;                          // validated, live; .get(), .subscribe()

  // → compiled into one Pi Durable Extension named `name`
  tool(t: ToolRegistration): void;
  section(s: PromptSection): void;
  hook(h: HookRegistration): void;
  wrap(w: Wrap): void;
  task(t: AnyTask): void;
  doc(d: DocDefinition): void;                // declared so conversationCreated can seed it

  // host contracts (§4.2)
  provide<T>(service: ServiceToken<T>, impl: T): void;
  service<T>(service: ServiceToken<T>): T;           // throws if missing (use `requires`)
  services<T>(service: ServiceToken<T>): readonly T[]; // for "many" services

  // lifecycle: long-running loops (pollers, servers). Cancelled on reload/stop.
  onStart(fn: (host: HostApi, context: Context) => Promise<void> | void): void;
  on<E extends HostEvent>(event: E, fn: HostEventHandler<E>): void;
}
```

`HostApi` is the narrow, stable façade that extensions get at runtime. They never touch internals.

```ts
export interface HostApi {
  harness: Harness;                              // escape hatch: full Pi Durable power
  root(context: Context): Promise<Conversation>; // "the dot"
  inbound(msg: Inbound, context: Context): Promise<void>;          // §6
  deliver(to: Address, msg: Outbound, key: string, context: Context): Promise<void>; // durable, idempotent by key
  config: ConfigStore;                           // §7
  extensions: ExtensionManager;                  // §8 (only the `self` extension gets write access)
}
```

### 4.2 Services: swappable contracts

A service is a typed token plus a cardinality. The core defines six. Extensions can define their own (memory, for example) with the same mechanism, which is how third parties make their behaviour swappable.

```ts
export const service = <T>(id: string, cardinality: "one" | "many") => ({ id, cardinality }) as ServiceToken<T>;
```

| Token | Card. | Contract | Default provider (extension) |
|---|---|---|---|
| `Channel` | many | `id`, `start(sink, ctx)`, `send(addr, msg, ctx) → {messageId}`, `capabilities` | `telegram` |
| `Router` | one | `route(inbound) → { conversationId, whenBusy: "steer"\|"followUp" }` | `router-single-mind` |
| `EnvProvider` | one | `(target: EnvTarget, ctx) → ExecutionEnv` (the dot's computer) | `computer-local` |
| `ModelProvider` | many | `register(models: Models)` (pi-ai providers and keys) | `models-openai`, `models-anthropic` |
| `Policy` | many | `decide(call, facts) → "allow" \| "ask" \| { deny: reason } \| undefined` | `policy-rules` |
| `Approver` | one | `request(approval, ctx) → "approved" \| "denied"` (delivery plus waiting) | `approvals-chat` |

For a `one` service, the provider from the extension loaded *last* wins, so a user or agent extension can override a built-in just by providing the same token. Overrides are logged and visible to the model in the extension catalog.

Message shapes shared by channels:

```ts
type Address  = { channel: string; chat: string; thread?: string };
type Inbound  = { address: Address; id: string /* channel-unique, idempotency */; sender: { id: string; name?: string };
                  text: string; attachments?: Attachment[]; replyTo?: string;
                  action?: { kind: "approval"; approvalId: string; choice: "approve" | "deny" } };
type Outbound = { text: string; format?: "markdown" | "plain"; replyTo?: string;
                  buttons?: { id: string; label: string }[]; attachments?: Attachment[] };
```

### 4.3 Host events

The core emits `started`, `stopping`, `extension:installed | failed | quarantined | removed`, `config:changed`, `inbound`, `delivered`, and `approval:requested | resolved`. Events are observation-only and process-local. Anything that must survive a restart goes through tasks or documents instead.

## 5. Conversation topology ("one mind")

- **Root conversation = the dot.** By default, every channel routes into the root, so the dot has the same context everywhere. That matches the dots product. Each user entry is prefixed with a compact provenance line (`[telegram:chat 123 · Alice]`), so the model knows where a message came from.
- **Replies go back where the input came from.** Ingress records `submissionId → Address` in the `japa.routes` session document. The reply task (§6) uses it.
- **Workers.** Long or background jobs run in task-owned or background conversations, using the Pi Durable subagent pattern (README examples 22 and 23). A worker can use a cheaper model, a narrower tool set, and its own `cwd`. Results come back to the root as follow-up input.
- **Specialists.** A specialist dot is a named conversation with its own `pi.agent` (model, extension subset, instructions). It is created by config, and its address is exposed through the router.
- The `Router` service is the one place that decides this mapping. A thread-forks-per-chat router, or a conversation per chat, is a ~30-line replacement extension.

## 6. Ingress and delivery (exactly-once plumbing in core)

**Ingress.** `host.inbound(msg)` does the following:

1. `Router.route(msg)` picks the conversation.
2. It calls `conversation.submit({ type: "input", content, requestId: \`${channel}:${msg.id}\`, whenBusy })`. Thanks to `requestId`, a redelivered message returns the existing submission.
3. In one commit, it records the route (`japa.routes`) and creates a background `japa.reply` task for that submission (if it doesn't already exist), and it advances the channel's cursor document (for example the Telegram update offset).

A crash anywhere in this sequence re-runs it idempotently.

**Reply.** `japa.reply` is a durable task with the phases `wait → send → done`.

- In `wait`, it waits for the submission to settle.
- In `send`, it calls `Channel.send`. A `sent` memo prevents double sends after a restart. There is a tiny at-least-once window between the network send and the memo commit; Telegram has no idempotency key, so we accept it.

**Proactive messages** (`message_user` tool, scheduler, approvals) use `host.deliver(to, msg, key)`. This creates the same kind of `japa.deliver` task, deduplicated by `key`. If a `to` isn't given, it falls back to `config.owner.primaryAddress`, which is the last address the owner wrote from.

**Approvals** (§9) are delivered with buttons. The button press comes back as an `Inbound.action`, and core resolves the waiting approval instead of routing it to the model.

## 7. Configuration (agent-editable, durable, live)

- The store is a session-scoped Pi Durable document, `japa.config`, shaped as `{ rev, value }`. Each write also appends `{ rev, patch, inverse, actor, reason, at }` to a session document `japa.config.log` in the same commit. That gives history and revert. Pi Durable's `history: "rewindable"` only exists for conversation-scoped documents, and config is session-wide.
- On first boot the document is seeded from `$JAPA_HOME/config.json`. After that, the file is only an *import/export* mirror. The core writes the file on change, and if a human edits it, the edit is re-imported as a new revision.
- **Shape:**

  ```jsonc
  {
    "identity": { "name": "Japa", "persona": "…" },
    "owner": { "telegramUserIds": ["…"], "primaryAddress": { … } },
    "model": { "provider": "openai", "modelId": "…", "thinkingLevel": "medium" },
    "harness": { "compaction": { … }, "retry": { … }, "toolExecution": "parallel" },
    "extensions": {
      "enabled": ["persona", "telegram", "memory", "scheduler", "…"],  // order = Pi Durable selection order
      "<name>": { /* validated against that extension's config.schema */ }
    },
    "kernel": { "protected": ["self", "policy-rules"], "healthWindowSec": 300 }
  }
  ```

- **Validation.** Every write goes through the composed schema: the core schema plus each extension's schema under its name. An invalid write is rejected with schema errors returned to the caller (often the model, which can then fix its input).
- **Liveness.** `HarnessSettings` is passed as getters over the config document. Extensions read `api.config().get()` or subscribe to it. The default `model` and `instructions` are applied to the root through `configure()` when they change.
- **Agent access** goes through the `self` extension's tools (§8.3). Changes are subject to policy. For example, `owner.*` and `kernel.*` default to `deny` for the agent.

## 8. Self-extension

### 8.1 Where extensions live and their precedence

```
<repo>/extensions/<name>/           built-ins (shipped, read-only to the agent)
$JAPA_HOME/extensions/<name>/       user + agent extensions (a git repo, one commit per install)
```

If two extensions have the same name, the **home directory shadows the built-in**. This is how the agent "edits" a built-in: it copies the built-in into home, modifies the copy, and installs it. The built-in stays on disk as the ultimate fallback. Removing the shadow restores the built-in. Names listed in `kernel.protected` cannot be shadowed by the agent.

An extension is a directory with an `index.ts` whose default export is `defineExtension(...)`. It may also contain more `.ts` files and a `README.md`, which feeds the catalog.

### 8.2 Install pipeline (auto-install with automatic rollback)

```
write files ─▶ 1 typecheck ─▶ 2 bundle ─▶ 3 probe (child process) ─▶ 4 record pending ─▶ 5 install ─▶ 6 health window ─▶ 7 mark good
                  │ fail          │ fail        │ fail                                        │ fail / crash            │
                  └───────────────┴─────────────┴──────▶ return diagnostics, nothing changes  └──▶ quarantine + restore last-good
```

1. **Typecheck.** `tsc --noEmit` against a generated tsconfig that maps `@japa/sdk` to the host's type declarations. The errors are returned verbatim to the model, so it can fix them and retry.
2. **Bundle.** esbuild produces a single ESM file, `$JAPA_HOME/build/<name>-<sha>.mjs`. `@japa/sdk`, `@earendil-works/*`, and `typebox` are marked external and rewritten to absolute URLs of the *host's* copies. This matters because hook targets such as `ToolTask` are compared by identity, so the extension must import the host's instances. Bundling also sidesteps Node's ESM cache: each version gets a fresh URL and transitive imports are inlined.
3. **Probe.** A short-lived child Node process imports the bundle, checks the export shape, runs `setup()` against a recording `SetupApi`, and runs the optional `selfTest()` export. If top-level code throws, hangs (timeout), or crashes, only the probe process dies.
4. **Record pending.** The `japa.extensions` session document gets `{ name, sha, status: "pending", previous: lastGoodSha }`, and the files are committed to the home git repo.
5. **Install.** The main process imports the bundle and runs `setup()` with the real `SetupApi`, compiles the contributions into a Pi Durable `Extension`, swaps the services and lifecycles, and calls `registry.install()`. Pi Durable guarantees that in-flight calls finish on the old code and the next request sees the new tools and sections.
6. **Health window** (`kernel.healthWindowSec`). The host counts the extension's tool throws, hook throws (via `onReport`), and lifecycle crashes. If it crosses a threshold, it rolls back automatically. **Crash-loop protection:** if the process dies while a record is `pending`, the next boot loads that extension's `previous` sha instead (or skips it), marks it `quarantined`, and tells the owner.
7. Once the window passes, the record is marked `good` and git is tagged `good/<name>`.

Boot order: core, then built-ins, then home extensions in `config.extensions.enabled` order, each at its last `good` sha (or at `pending`, under the crash-loop rule). `japa --safe` loads only the kernel, `self`, and a channel, so the dot can still talk and fix itself.

### 8.3 The `self` extension (protected)

| Tool | Purpose |
|---|---|
| `extension_catalog` | Installed extensions, status, sha, tools, services provided or overridden, and recent errors |
| `extension_read(name)` | Source files of an extension (built-in or home) |
| `extension_write(name, files, message)` | Write and run the §8.2 pipeline. Returns diagnostics or an install report. It is `replay: "safe"` because it is keyed by content hash. |
| `extension_remove(name)` / `extension_rollback(name, sha?)` / `extension_enable(name, on)` | Lifecycle operations |
| `extension_guide()` | Returns the SDK guide plus 2–3 worked examples on demand, to keep the system prompt small |
| `config_get(path?)` / `config_schema(ext?)` / `config_set(path, value, reason)` / `config_history` / `config_revert(rev)` | Self-configuration |

Its system-prompt section is short. It says: *"You can extend yourself. Use `extension_guide` before writing an extension. Prefer config changes over code."* It also includes a one-line-per-extension catalog.

### 8.4 What agent-written code can and cannot do

- It runs **in-process with full privileges** (the auto-install choice). The guard rails are therefore operational, not a sandbox: protected kernel, probe, health window, rollback, safe mode, and git history. **Recommendation:** run the daemon in a container or VM, with `$JAPA_HOME` on a volume, and give the "computer" env its own workspace directory.
- v1 supports no new npm dependencies (see open question Q4). Extensions can use Node built-ins, `fetch`, the SDK, pi-ai, and Pi Durable.

## 9. Policy and approvals

- Core installs one Pi Durable `beforeTool` hook, the **policy gate**, at the front of every conversation's selection.
- The gate asks every `Policy` service in order. The first `deny` blocks the call. Any `ask` means an approval is needed. If no policy decides, the call is allowed.
- `ask` → `Approver.request(...)`. The decision is stored with `api.memo("approval:<callId>")`, so a restart never asks twice (the pattern from the Pi Durable post). The approval is delivered to the owner's primary address with Approve/Deny buttons and has a timeout. On timeout the call is denied.
- `policy-rules` (the default) reads `config.extensions["policy-rules"].rules`, for example `{ match: { tool: "bash", args: { command: "rm *" } }, action: "ask" }`. It also has a built-in *read-only mode* used by background/proactive work, mirroring dots' "proactive research is read-only". Workers get `policy-rules` with `mode: "readOnly"` through their `pi.agent` instructions/extension config.

## 10. Reference extensions (first pass)

| Extension | Kind | What it does |
|---|---|---|
| `self` | kernel | §8.3 |
| `persona` | section | Name, persona, and owner facts from config. Today's date is rendered at day granularity to keep the prompt cache warm. |
| `router-single-mind` | Router | All inbound messages go to root. A busy root gets `steer` from the owner and `followUp` from others. |
| `telegram` | Channel | `getUpdates` long-polling (no public URL needed). The offset lives in the `japa.channel.telegram` doc. Owner allowlist. Inline-keyboard approvals. A "typing…" indicator follows `viewState` busy. Markdown is converted to Telegram HTML, and long messages are chunked. |
| `models-openai` / `models-anthropic` | ModelProvider | Register pi-ai providers from env keys |
| `computer-local` | EnvProvider + tools | `NodeExecutionEnv` rooted at `$JAPA_HOME/workspace`, plus `CodingTools` (read/write/edit/bash) |
| `policy-rules` | Policy | Config-driven allow/ask/deny rules, plus read-only mode |
| `approvals-chat` | Approver | Sends button prompts through `host.deliver` and resolves them on `Inbound.action` |
| `memory` | defines the `Memory` service + tools + section | Markdown notes in `$JAPA_HOME/memory/`, `remember`/`recall`/`forget` tools, and a section with pinned facts. This is the "learns your preferences" behaviour. It's swappable for a vector store. |
| `scheduler` | tasks + tools | `schedule_create` (cron, at, every), `schedule_list`, `schedule_cancel`. Each schedule is a background durable task that loops `runtime.sleep(next)` and then submits to its target conversation with `requestId = schedule:<id>:<fireTime>`. |
| `messaging` | tool | `message_user(text, to?)` → `host.deliver`. Lets the dot reach out on its own. |
| `workers` | tools | Spawn, steer, list, and stop background worker conversations (the Pi Durable example 23 pattern), with results reported back to the root |
| `proactive` | uses scheduler | A heartbeat that runs a read-only worker on "anything worth surfacing?" and messages the owner only if the answer is non-empty |

Each one is a normal extension, and the agent may shadow any of them except `self` and `policy-rules`.

## 11. Repo layout and milestones

```
japa/
  package.json                 # npm workspaces, "type": "module", engines node >=24
  packages/
    sdk/                       # @japa/sdk: types + defineExtension + service tokens (what extensions import)
    core/                      # @japa/core: Host, Loader (tsc/esbuild/probe), Config, Services, Ingress/Delivery, policy gate
    cli/                       # `japa start | --safe | ext ls | ext rollback | config get/set | chat` (dev stdin channel)
  extensions/                  # built-ins listed in §10
  docs/sdk-guide.md            # served by extension_guide()
  test/                        # vitest; MemoryStorage + pi-ai faux provider; crash/restart tests
$JAPA_HOME (default ~/.japa)/
  japa.sqlite  config.json  extensions/(git)  build/  workspace/  memory/  logs/
```

| Milestone | Delivers | Exit test |
|---|---|---|
| **M0** Skeleton | Workspace, SDK types, Host opens Harness on SQLite, `models-*`, dev `chat` channel | A prompt is answered, the process is killed mid-run, and the run resumes |
| **M1** Extensions & config | Loader for built-ins, `SetupApi` → Pi Durable compile, services, `japa.config` doc with schemas and live settings | Changing the model in config takes effect on the next request without a restart |
| **M2** Self-extension | Home dir, typecheck/bundle/probe, install/health/rollback, crash-loop quarantine, `self` tools, `--safe` | The agent writes a `weather` tool and uses it in the same conversation. A deliberately broken extension is rejected. A crashing one is quarantined after reboot. |
| **M3** Telegram | Channel contract, ingress/reply/deliver tasks, router, owner allowlist | `kill -9` between receive and reply produces exactly one answer |
| **M4** Control | Policy gate, `policy-rules`, `approvals-chat` (buttons), `messaging` | `bash rm` asks on Telegram. An approval survives a restart. |
| **M5** Always-on | `scheduler`, `memory`, `workers`, `proactive`, `persona` | "Remind me tomorrow 9am" fires after a restart. Preferences recalled across days. |

## 12. Open questions

1. **Name.** Is "japa" both the product name and the npm scope (`@japa/*`), or is japa just the repo name?
2. **Default model and provider** for the root and for workers (and which API keys are available)?
3. **Single owner vs. multi-user.** Should the first pass be single-owner (a Telegram allowlist), with other people's messages ignored? Or should others be able to talk to the dot with reduced permissions?
4. **npm dependencies for agent-written extensions.** Allow `extension_write` to declare deps and run `npm install` into `$JAPA_HOME/extensions/node_modules` (behind policy)? Or keep v1 dependency-free?
5. **Where the computer lives.** Should the first pass use the host filesystem under `$JAPA_HOME/workspace`, or a Docker container per dot from day one? The auto-install choice argues for running the *whole daemon* in a container.
6. **Telegram streaming UX.** Should the dot send only final answers, or progressively edit a message with partial output and tool status?
7. **Voice and media.** Should Telegram voice notes go through transcription, and images through vision, in v1 or later?
