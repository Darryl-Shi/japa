# japa — a self-extensible chief of staff on Pi Durable

Date: 2026-10-07
Status: Draft for review

## 1. Purpose

japa is a personal, always-on agent in the spirit of OpenAI dots. The user talks
to exactly one agent — the **chief of staff (CoS)** — in **one continuous
thread**. The CoS does quick things itself, delegates real work to background
**jobs**, remembers the user, reacts to triggers, and **extends itself** (new
skills, worker profiles, and extensions) when asked to do something it can't
yet do.

### Goals

- **One thread, one counterpart.** The user never manages threads, agents, or
  workers. They talk to the CoS; the CoS reports back.
- **Minimal core, contracts at the seams.** The kernel is small. Everything
  where japa meets the outside world — models, UIs, events, capabilities,
  execution, storage, credentials — is a contract with replaceable
  implementations.
- **Self-extension.** The CoS builds what it needs, picks the smallest
  mechanism that meets the requirement, installs automatically, and rolls back
  on failure.
- **Seamless.** The user never needs to know how the backend works. A request
  like "brief me every morning" ends with "Done — here's how it works", not
  with implementation questions.
- **Lean, cheap context.** The CoS's model context is short and reset often,
  while memory persists.
- **General purpose.** Coding and knowledge/personal work are both just
  extensions and content; the core is domain-agnostic.

### Code principles

- **Simple, minimal, readable** over clever or general. The kernel should be
  small enough to read in one sitting.
- Small files with one purpose each; plain functions and data over class
  hierarchies and frameworks.
- No abstraction without a second real use; no speculative options.
- Lean on Pi Durable instead of re-implementing what it already does.
- Names and short comments explain *why*; code explains *what*.
- Few dependencies: Pi Durable, pi-ai, pi-tui, TypeBox, vitest.

### Non-goals (v1)

Messaging surfaces (Slack/Telegram/iMessage), multiple users, out-of-process
extensions, embedding search, approval gates for side-effecting actions,
nested jobs, built-in OAuth flows (possible later through the `provider` and
`tool` contracts), storage migration between backends, a hosted deployment.

## 2. Foundation: Pi Durable

japa is built on `@earendil-works/pi-durable` (1.0.x, Node ≥ 22.19; we target
Node 24) and `@earendil-works/pi-ai`. Concepts we rely on:

- **Harness** over a **Storage** backend. Every transcript entry, task step,
  and document change is an atomic commit; crashes resume from the last
  checkpoint.
- **Conversations** (transcripts), **documents** (typed JSON committed with
  entries), **tasks** (durable state machines with timers and child tasks).
- **Extensions** (tools, sections, hooks, wraps, tasks) in a **registry** that
  can be hot-replaced; conversations store extension/tool names, not code.
- **`ExecutionEnv`**, built per tool call by the harness's `env` function.
- **`reset(note)`** starts a fresh model context while keeping all entries in
  storage.
- **Background tasks** own child conversations that survive aborts and do not
  keep the parent busy (pattern from Pi Durable example 23).
- **`watch()` / `viewState()` / `watchTaskGraph()`** for UIs; multiple clients
  can attach to one conversation.
- **`requestId`** for exactly-once submissions.

One process owns the storage. japa therefore runs as one daemon.

## 3. Architecture and layers

```
                ┌──────────────── japad (one Node process) ────────────────┐
  surface ──────┼─▶ Kernel: CoS · jobs · context & memory · skills ·       │
  trigger ──────┼─▶   self-extension · safety · changes · settings         │
                │                                                          │
  provider ─────┼─▶ models          Pi Durable Harness                     │
  tool ─────────┼─▶ capabilities      root conversation = CoS thread       │
  environment ──┼─▶ where work runs   job conversations (background)       │
  storage ──────┼─▶ state (boot)                                           │
  secrets ──────┼─▶ credentials (boot)                                     │
                └──────────────────────────────────────────────────────────┘
  ~/.japa/ (git): extensions/ skills/ workers/ memory/ settings.json
```

Four layers:

1. **Kernel** (`src/kernel`) — the CoS, jobs, context and memory, skills
   and worker-profile loading, self-extension, safety, changes log, settings.
   The only code the CoS cannot modify.
2. **Contracts** — the seven seams in §4.
3. **Extensions** — TypeScript modules that implement contracts (§5).
4. **Content** — data, no code: skills, worker profiles, memory, settings,
   schedules.

Defaults for every layer ship in this repo; the workspace `~/.japa/` (a git
repo) holds user- and CoS-authored extensions and content, overriding
defaults by name.

## 4. Contracts

### 4.1 What a contract is

A contract is a named seam with a TypeScript contribution type, agent-facing
docs (advertised through skills, §9.2), a validator used by `japa check`, and
an activation lifecycle:

```ts
interface Contract<C> {
  name: string;
  docs: string;
  phase: "boot" | "runtime";      // boot: chosen before the harness opens
  cardinality: "one" | "many";
  validate(c: unknown): C;
  activate(c: C, ctx: KernelContext): Promise<Dispose>;
}
```

### 4.2 The seven core contracts

| Contract | Phase | Cardinality | Swaps | Default |
|---|---|---|---|---|
| `provider` | runtime | many | model access | pi-ai built-ins |
| `surface` | runtime | many | where the user talks | `gateway` + TUI |
| `trigger` | runtime | many | what wakes the CoS | `schedule` |
| `tool` | runtime | many | what agents can do | `web` |
| `environment` | runtime | many | where work runs | `local` |
| `storage` | boot | one | where state lives | SQLite |
| `secrets` | boot | one | where credentials live | file store |

#### `provider`

```ts
interface Provider {
  name: string;                         // e.g. "openai", "ollama-local"
  register(models: ModelRegistry, ctx: ProviderContext): Promise<Dispose>;
  secrets?: string[];                   // e.g. ["openai.apiKey"]
}
```

Registers models (and, for non-standard APIs, a pi-ai API implementation)
into the harness's model registry. `ProviderContext` gives `secret(name)`
and the provider's settings. Model choices in settings
(`models.cos`, `models.consolidation`, `models.worker`, worker profiles) name
`{ provider, modelId }`. The default provider extension exposes pi-ai's
built-in providers, reading API keys from the secrets store.

#### `surface`

```ts
interface Surface {
  name: string;
  start(ctx: SurfaceContext): Promise<Dispose>;
}
interface SurfaceContext {
  root: { submit(text, mode), abort(), events(listener) };   // pi-durable agent events
  job(id: string): { events(listener) };                      // read-only job view
  taskGraph(): ChordState;
  secrets: { pending(), fulfil(requestId, value) };
}
```

A surface may be interactive (chat) or outbound-only (notifications). Every
interactive surface must render pending secret requests as masked prompts.

#### `trigger`

```ts
interface Trigger {
  name: string;
  start(ctx: TriggerContext): Promise<Dispose>;
}
interface TriggerContext {
  emit(event: { key: string; text: string }): Promise<void>;
  docs: DocAccess; settings: unknown; secret(name: string): Promise<string>;
}
```

`emit` submits a short input to the root conversation with
`requestId = trigger:<extension>:<key>`, so each event is delivered exactly
once. Triggers needing durable timers use the escape hatch (§4.4).

#### `tool`

Plain Pi Durable tools (`defineTool`, TypeBox parameters, `replay`
semantics). The extension's `summary`, `examples`, and `docs` (§5.1) describe
them for routing. Tools never declare who may use them or how risky they
are; the kernel decides (§5.3).

The kernel also owns four built-in tools from Pi Durable — `read`, `write`,
`edit`, `bash` — which worker profiles select by name and which the CoS gets
only `read` of.

#### `environment`

```ts
interface Environment {
  name: string;                         // e.g. "local", "docker", "ssh:devbox"
  create(input: { conversationId: string; cwd?: string }): ExecutionEnv;
}
```

The kernel's harness `env` function dispatches each call: the root
conversation gets a **read-only wrapper** of the default environment; a job
gets the environment its worker profile names (default `local`,
`NodeExecutionEnv`). Implementations can be checked with Pi Durable's
`registerEnvConformance()`.

#### `storage` (boot)

```ts
interface StorageAdapter {
  name: string;
  open(config: unknown, ctx: BootContext): Promise<Storage>;
}
```

Selected by `settings.storage` (default `{ adapter: "sqlite", file:
"~/.japa/state.db" }`). A change takes effect on restart; there is no
migration in v1, so switching adapters starts empty unless the user moves the
data. Implementations can be checked with `registerStorageConformance()`.

#### `secrets` (boot)

```ts
interface SecretsAdapter {
  name: string;
  open(config: unknown, ctx: BootContext): Promise<{
    get(name: string): Promise<string | undefined>;
    set(name: string, value: string): Promise<void>;
    delete(name: string): Promise<void>;
    list(): Promise<string[]>;
  }>;
}
```

Selected by `settings.secrets` (default: files in `~/.japa/secrets/`, mode
600, outside git). Extensions read only the secret names their manifest
lists.

### 4.4 Escape hatch: raw Pi Durable

An extension may also include raw Pi Durable `sections`, `hooks`, `wraps`, and
`tasks` (`durable` field, §5.1) — for guards, prompt additions, or durable
tasks such as timers. This is not a contract and is not advertised in the
capabilities section; it is documented in the `building-extensions` skill.

## 5. Extensions

### 5.1 Manifest

An extension is one TypeScript module whose default export is:

```ts
defineJapaExtension({
  name: "gcal",
  summary: "Lets me read and manage your Google Calendar",   // user-facing
  examples: ["what's on my calendar tomorrow?", "move my 3pm to 4"],
  docs: "./skills/using-gcal/SKILL.md",                       // agent-facing
  provides: {                         // keyed by contract name
    tool: [gcalList, gcalUpdate],
    // surface: [...], trigger: [...], provider: [...], environment: [...],
    // storage: adapter, secrets: adapter
  },
  durable: { sections, hooks, wraps, tasks },   // escape hatch, optional
  secrets: ["gcal.token"],            // secret names it may read
  settings: Type.Object({ ... }),     // TypeBox schema for its settings
  // skills/ next to index.ts are bundled automatically
});
```

Rules:

- `summary` is required. `examples` and `docs` are required when the
  extension provides tools.
- Descriptive fields only affect routing. A poor description causes poor
  routing, which `japa check` catches (§10.3) — never a safety or role
  violation.
- The kernel converts `provides.tool` plus `durable` into one Pi Durable
  `Extension` named after the japa extension.

### 5.2 Loader and boot sequence

Sources, later overriding earlier by name: packaged `extensions/*`, then
`~/.japa/extensions/*`. TypeScript loads with Node 24 native type stripping.

Boot:

1. Read `settings.json`.
2. Import all extension modules (no activation yet).
3. Open the selected `secrets` adapter, then the selected `storage` adapter.
4. Open the harness with the storage, model registry, settings getters, and
   the kernel's `env` dispatcher.
5. Activate `provider`, then `environment`, then `tool` (registry install),
   then `trigger` and `surface`.
6. Ensure the root conversation (§5.4) and call `harness.resume()`, so pending
   tasks continue.

Reload of a runtime extension: `import(file?v=<commit>)`, dispose its old
contributions, activate the new ones, `registry.install()` (same-name
replace), recompute tool lists (§5.3). Old module copies stay in memory until
restart. Boot-phase adapters reload only on restart.

### 5.3 Tool selection and the CoS's limits

The kernel computes each conversation's tool list:

- **Root (CoS):** core CoS tools (§6.3, §7.5, §8, §9.3–§9.5, §10), built-in
  `read`, and **every extension tool**. The CoS does quick things itself.
- **Jobs:** core worker tools (§6.4) plus what the worker profile selects:
  built-in tools by name, extension tools by extension name (default: all
  extensions).

On every install, reload, or rollback the kernel recomputes these lists and
applies them with `configure({ tools })` to the root and every active job
conversation, in one commit.

Limits on the CoS are structural:

- **Read-only environment.** File writes and `exec` are rejected, so any tool
  that changes files or runs processes fails in the CoS; that work happens in
  jobs.
- **Result cap.** A tool result entering the CoS context is capped at
  `settings.context.toolResultTokens` (default 2k). The full output stays in
  storage; the CoS sees a truncation note suggesting a job if it needs it all.
- **Delegation guidance** (§9.1): one or two calls → do it yourself;
  multi-step, long-running, or heavy work → start a job.

Safety is the same for the CoS and workers. v1 has no approval gates;
in-process extension failures are handled by §10.4. A future guard for
destructive actions would be a kernel-owned policy applied to both.

### 5.4 Root conversation

Created on first boot (`harness.root()`) and configured as the CoS: CoS
model, core sections (§7.2), tool list (§5.3).

## 6. Jobs and worker profiles (core)

### 6.1 Jobs

A job is a **background child conversation**, owned by a background anchor
task so it survives the CoS's aborts and restarts and never keeps the CoS
thread busy. Jobs are tracked in the root document `japa.jobs`:

```ts
{ id, title, brief, worker, status, conversationId,
  progress?: string, result?: string, createdAt, updatedAt }
status: "queued" | "running" | "needs_input" | "done" | "failed" | "cancelled"
```

Concurrency is capped by `settings.jobs.maxConcurrent` (default 4); extra jobs
are `queued` and start in creation order.

### 6.2 Worker profiles (content)

A worker profile is a Markdown file with frontmatter; the body is the
worker's instructions:

```markdown
---
name: coder
description: Writes and changes code in a repository, runs tests.
model: { provider: openai, modelId: gpt-6-sol }   # optional; default models.worker
thinking: high                                    # optional
environment: local                                # optional; default local
tools: [read, write, edit, bash]                  # built-in tools by name
extensions: []                                    # extension tools by extension name; omitted = all
skills: []                                        # omitted = all
cwd: ~/projects                                   # optional
---
You are a careful software engineer. ...
```

Locations, later overriding earlier by name: packaged `workers/`, then
`~/.japa/workers/`. Kernel-packaged profiles: `general` (all extension tools,
built-in `read`) and `builder` (§10.2). Names and descriptions are advertised
to the CoS (§9.2).

### 6.3 CoS job tools

- `job_start({ title, brief, worker? })` → returns the job id immediately.
- `job_message({ id, text, mode: "steer" | "followup" })`
- `job_stop({ id })`
- `job_list()`
- `job_transcript({ id, tail? })` — inspect a job only when needed.

### 6.4 Worker job tools

- `job_progress({ note })` — updates `progress` for live status.
- `job_complete({ summary })` — sets `done`, stores `result`, ends the run.
- A run that ends without `job_complete` sets `needs_input`; its last message
  becomes the question.
- A run that fails (error after retries) sets `failed`.

Workers cannot start jobs in v1.

### 6.5 Reporting

A background reporter task posts each state change that needs CoS attention
(`done`, `needs_input`, `failed`) into the root conversation as a short input,
e.g. `[job 7 "Fix CI" done] <summary>`, with
`requestId = report:<jobId>:<seq>`, so a restart never double-posts. The CoS
decides what to tell the user, what to answer itself, and what to start next.

## 7. CoS context and memory (core)

### 7.1 Two views of one thread

Storage keeps every entry and surfaces render the full history, so the user
sees one continuous chat. The model sees only the **current context** since
the last `reset()`.

### 7.2 What the CoS sees on each request

Rendered as sections, in this order (static first, for prompt caching):

1. **Identity** — role, how japa works, mechanism ladder, UX rules (§9.1).
2. **Capabilities** — generated from manifests and content (§9.2).
3. **About you** — the user fact list (§7.4).
4. **Jobs** — one line per active job, plus jobs finished in the last 24 h.
5. **Schedules** — the user's active schedules (`schedule` extension).
6. **Waiting on you** — one line per pending secret request (§9.5).
7. **Last exchange** — the settled run's inputs and the CoS's final answer,
   carried over by the reset (§7.3).

### 7.3 Context lifecycle

- **Reset:** when a run on the root conversation settles, the kernel commits
  a reset at once — no model call. The commit re-checks that the root is
  still idle, that no input is queued, and that nothing new arrived since the
  settle it saw; if any check fails, it does nothing and the next settle
  resets instead. The reset carries over only the **last exchange** — the
  settled run's inputs and the CoS's final answer — capped at 2,000 tokens
  (the middle of the longest part is cut when over). Proactive turns
  (triggers, job reports, secret confirmations, rollback and safe-mode
  notices) reset the same way.
- **Reflection** (§7.4) runs separately, in the background, and never blocks
  or triggers a reset.
- Pi Durable's automatic compaction stays enabled on the root with its
  model-relative threshold, as a fallback for a single long turn with many
  tool calls.

### 7.4 User facts ("About you") — reflection

Like ChatGPT's saved memories: a high-level picture of the user, not a log or
an exhaustive overview.

- **Entry:** `{ id, text, updatedAt }`, up to ~2 sentences (≤ 50 words), one
  lasting aspect per entry: who the user is, what they're working toward, how
  they like to work, key people and projects, standing preferences.
- **Cap:** ~30 entries and ~1.5k tokens total.
- **Reflection** (`Reflect`) is a background task, on the consolidation
  model, that reads the stored entries since the last reflection and the
  current list and outputs only operations: `add(text)`, `update(id, text)`,
  `delete(id)`, or `none`. It fires after a reset once 5 turns are
  unreflected, otherwise 15 minutes after the last reset if any are
  unreflected, and at boot. Its rules:
  - record patterns and lasting context, not events or task details;
  - fold new details into an existing entry and generalize, rather than
    adding entries;
  - rewrite entries that have become too specific at a higher level;
  - skip sensitive details unless the user explicitly asks to remember them.
- **Kernel enforcement:** an entry over 50 words is returned once for
  shortening and dropped if still too long; exceeding the cap triggers a
  **merge pass** that combines related entries and drops the least useful
  until it fits; near-duplicates (normalized text similarity) are rejected.

### 7.5 User control and recall

CoS tools:

- `memory_facts()` — "what do you remember about me?"
- `memory_remember({ text })` — immediate add (same limits), for "remember
  that…".
- `memory_forget({ id })` — for "forget that…".
- `memory_search({ query })` — keyword search over episode summaries and job
  results, for recall beyond the always-loaded memory.

When the CoS saves something during a conversation it may add a brief
"(noted: …)" to its reply.

### 7.6 Storage

`~/.japa/memory/facts.json`, `episodes/*.md`, committed to the workspace git
repo after each reflection. Memory is fixed kernel logic,
not a contract. Semantic search, if added later, would be a new core `search`
contract that `memory_search` consults.

## 8. Skills (core loader, content)

Pi Durable has no skills; japa adds them.

- **Format:** Agent Skills `SKILL.md` with `name` and `description`
  frontmatter, optional `scripts/` and reference files.
- **Locations, later overrides earlier by name:** packaged `skills/`,
  `extensions/<x>/skills/`, `~/.japa/skills/`.
- **Progressive disclosure:** each conversation gets a section listing name +
  description of all skills (for jobs, narrowed by the worker profile's
  `skills` if set). `skill_read({ name, file? })` loads the body or a
  referenced file.
- Skills contain no code that the daemon runs; scripts inside a skill are run
  by workers through their own tools.

## 9. Self-model and seamless UX

### 9.1 Identity section (static)

- **Role:** the user's only point of contact. Keep your own context lean; do
  quick things yourself (one or two tool calls); delegate multi-step,
  long-running, or heavy work — and anything that writes files or runs
  commands — to a job.
- **How japa works:** one paragraph each on the thread, jobs and workers,
  memory, skills, extensions and contracts, triggers, surfaces.
- **Mechanism ladder** — use the smallest mechanism that meets the need:

  | Need | Mechanism |
  |------|-----------|
  | A fact or preference about the user | memory |
  | Adjust something that already exists | settings / config (schedules, models, extension settings) |
  | A procedure or know-how using existing tools | **skill** (content) |
  | A new kind of worker from existing tools, models, environments | **worker profile** (content) |
  | Connect to something new: a model provider, UI, event source, capability, execution environment, storage, or credential store; or enforce something (guarantee, not guidance) | **extension** implementing a contract |

  Test: if existing tools plus written instructions can do it, it's content.
  Often both: an extension provides the tool and bundles a skill that teaches
  when and how to use it.

- **UX rules:**
  1. Never make the user think about the backend; don't mention skills,
     extensions, contracts, workers, or jobs unless asked.
  2. Ask only what only the user can answer: credentials, preferences that
     matter, consent for irreversible external actions. Never ask about
     implementation.
  3. Short acknowledgement → do it → **verify** (checks plus a real dry run)
     → report.
  4. Report = **what's done**, **how to use it**, **how to change or undo
     it**, in plain language. Example: "Done. Every weekday at 8am you'll get
     a brief on today's calendar and anything urgent in your inbox. Say 'move
     my brief' or 'stop the brief' to change it."

### 9.2 Capabilities section (generated)

Rebuilt on every install, reload, rollback, or content change: one line per
extension `summary`, worker profiles with descriptions, active schedules,
connected surfaces, and available models. Contract docs and authoring guides
are skills (§11.2), not always-loaded context.

### 9.3 Changes log

Root document `japa.changes`: a user-level changelog.

```ts
{ id, at, title, howToUse, undo: { commits: string[], configOps?: ConfigOp[] } }
```

Every install, content change, settings change, or schedule the CoS makes on
the user's behalf adds an entry. CoS tools: `changes_list()`,
`change_undo({ id })` (reverts the commits and inverts config ops, then
reloads). This makes "undo that" and "what did you set up last week?" work.

### 9.4 Settings

`~/.japa/settings.json`, read live through Pi Durable settings getters
(boot-phase keys `storage` and `secrets` apply on restart). Holds the models
(CoS, consolidation, default worker), job concurrency, memory caps, and
per-extension settings validated against each extension's
schema. CoS tools: `settings_get({ path? })`, `settings_set({ path, value })`
(validated; logged in `japa.changes`).

### 9.5 Secret requests

- `secret_request({ name, why })` (CoS tool) records a pending request in the
  root document `japa.secretRequests` and returns immediately.
- Interactive surfaces show pending requests as masked prompts. The value goes
  straight to the `secrets` adapter and never enters the transcript.
- On fulfilment the kernel posts `[secret <name> provided]` into the CoS
  thread (`requestId = secret:<requestId>`).

## 10. Self-extension and safety net (core)

### 10.1 Workspace and boundary

`~/.japa/` is a git repo: `extensions/`, `skills/`, `workers/`, `memory/`,
`settings.json`. The CoS and its jobs may change these. They can **never**
change the kernel package, so the kernel can always repair everything else.

### 10.2 Building

1. The CoS chooses the mechanism (ladder, §9.1) and starts a `builder` job
   with a brief stating the requirement and the chosen mechanism. The builder
   may escalate (content → extension) if needed and says so in its summary.
   The `builder` profile has built-in coding tools, the `local` environment
   with cwd set to a staging git worktree of `~/.japa`, and the authoring
   skills.
2. The builder runs `japa check <kind> <name>` (§10.3) in the worktree.
3. On `job_complete`, the CoS calls `install({ kind, name })` with
   `kind: "skill" | "worker" | "extension"`.
4. **Content install** (skill, worker): lint, merge, commit, refresh sections
   and tool lists.
5. **Extension install:** merge and commit, import, activate (runtime
   contracts immediately; boot-phase adapters on the next restart, which the
   CoS tells the user about), recompute tool lists, health-check (§10.4).
6. Every install records an entry in `japa.changes`.
7. On failure: revert the commit, re-activate the previous version, report the
   error into the CoS thread. The CoS retries via the builder or tells the
   user plainly.
8. The CoS verifies with a real dry run where possible, then reports (§9.1).

### 10.3 `japa check`

Extensions:

- **Typecheck** (`tsc --noEmit`) and the extension's own tests (vitest).
- **Manifest checks:** `summary` present; `examples` and `docs` present if it
  provides tools; tool description length limits; no unexpected tool-name
  collisions; every `provides` key names a core contract and each
  contribution passes that contract's `validate`.
- **Conformance:** `storage` and `environment` contributions run Pi Durable's
  conformance suites.
- **Smoke load** in a throwaway harness on `MemoryStorage`: `activate` /
  `dispose` clean, the extension appears in the capabilities section, and the
  computed tool lists include its tools as §5.3 specifies.
- **Routing eval** (extensions with tools): the consolidation model sees the
  full capabilities section and each `example`; it must route to this
  extension (directly or via a suitable worker) without taking over other
  extensions' examples.
- **Regression:** re-run every installed extension's routing examples.

Content: frontmatter lint (skills, workers); a worker profile's model,
environment, tools, extensions, and skills must all resolve.

### 10.4 Runtime protection

- **Health check after install:** contributions activate, surfaces and
  triggers start, providers register within a timeout.
- **Auto-rollback:** an extension whose contributions throw repeatedly
  (surface fails to start, trigger crashes, tool error rate above
  `settings.safety.toolErrorThreshold`) is rolled back to its last-known-good
  version; the CoS is told.
- **Last-known-good tag:** updated after an extension has run healthily for
  `settings.safety.goodAfterMinutes` (default 10).
- **Boot safe mode:** three crashes within five minutes of boot → start with
  kernel + packaged defaults + workspace content at last-known-good; the
  selected `storage` and `secrets` adapters stay selected (at last-known-good
  version) because the data lives there. If a boot adapter still fails, the
  daemon exits with a clear error and `japa safe-mode --default-adapters`
  restores the packaged ones. The CoS tells the user on next contact.
- Manual: CoS tool `rollback({ kind, name, to? })`; CLI `japa rollback` and
  `japa safe-mode`.

## 11. Packaged defaults

### 11.1 Default extensions

| Extension | Provides | What it does |
|-----------|----------|--------------|
| `providers` | provider | pi-ai built-in providers, keys from the secrets store. |
| `local-env` | environment | `local`: `NodeExecutionEnv` with the profile's cwd. |
| `sqlite` | storage | `openNodeSqliteStorage`, default `~/.japa/state.db`. |
| `file-secrets` | secrets | One file per secret in `~/.japa/secrets/`, mode 600. |
| `gateway` | surface | Newline-delimited JSON over the Unix socket `~/.japa/japa.sock`; streams root agent events (`watchEvents`), `japa.jobs`, pending secret requests; accepts submit (input/steer/follow-up), abort, secret responses, job view attach. Includes the `japa chat` TUI client (pi-tui): thread on the left, live job board on the right, masked secret prompts. Closing the TUI does not stop the daemon. |
| `schedule` | trigger, tool, durable | Durable cron and one-shot timers in `japa.schedules`; tools `schedule_add` / `schedule_list` / `schedule_remove` (logged in `japa.changes`); fires via `emit`. |
| `web` | tool | `web_fetch` (no key) and `web_search` (Brave; asks for its key with `secret_request` on first use). |

With these defaults the CoS directly has `web_fetch`, `web_search`, the
`schedule_*` tools, and built-in `read` (in its read-only environment).

### 11.2 Default content

Worker profiles: `general` and `builder` (kernel), `coder` (built-in coding
tools, `local`), `researcher` (`web` tools plus built-in `write` for report
files; uses the `research` skill).

Agent-facing skills (the self-model, loaded on demand):

- `choosing-a-mechanism` — the ladder with worked examples.
- `building-skills` — SKILL.md format, progressive disclosure, scripts.
- `building-workers` — worker profile format and choices.
- `building-extensions` — manifest, each core contract's API, the escape
  hatch, fake-model testing, `japa check`.
- `writing-job-briefs` — good briefs, choosing a worker, parallel jobs,
  follow-ups.
- `reporting-changes` — the done / how-to-use / how-to-undo format.

Task skill: `research` — a sourced, structured research report. Further task
skills are created from real requests.

## 12. CLI

`japa daemon` · `japa chat` · `japa status` · `japa check <kind> <name>` ·
`japa rollback <kind> <name> [to]` · `japa safe-mode [--default-adapters]`

## 13. Repository layout

One npm package (`japa`) in `/home/dshi/projects/japa`, run directly with
Node 24 type stripping (no build step):

```
src/sdk.ts                what extensions import (`japa/sdk`); the kernel
                          links ~/.japa/node_modules/japa to this package
src/kernel/               contracts, loader, boot, jobs, context & memory,
                          skills & workers loading, changes, settings,
                          self-extension, safety
src/cli/                  japa daemon and subcommands
extensions/providers/     provider
extensions/local-env/     environment
extensions/sqlite/        storage
extensions/file-secrets/  secrets
extensions/gateway/       surface + TUI client
extensions/schedule/      trigger + tools
extensions/web/           tools
workers/                  default worker profiles
skills/                   default skills
docs/superpowers/specs/
```

## 14. Error handling

- Model and stream retries: Pi Durable settings.
- Jobs: failures become `failed` and are reported; `needs_input` is a normal
  state, not an error.
- Triggers, job reports, secret notices: idempotent via `requestId`.
- Consolidation: a durable task; a crash resumes it; a stale result is
  discarded (§7.3).
- Extensions and boot adapters: §10.4.

## 15. Testing

vitest with pi-ai's faux provider (scripted model responses; no network):

- Contracts: validation, activation order, cardinality (one boot adapter).
- Loader and boot: override order, hot reload, same-name replace, boot-phase
  changes apply only on restart.
- Tool selection: root gets all extension tools and built-in `read`; worker
  profiles select built-ins and extensions; result cap; read-only CoS
  environment; profile environment dispatch.
- Jobs: lifecycle, concurrency queue, `needs_input`, restart mid-job with no
  double reports.
- Reset: happens when a run settles; carries over only the last exchange;
  proactive turns reset too.
- Reflection: fires at 5 unreflected turns or 15 quiet minutes, and at boot;
  a failure leaves the cursor and retries; long entries rejected/shortened,
  cap triggers merge, duplicates rejected.
- Skills and workers: discovery, override order, profile resolution,
  `skill_read`.
- Secrets: request → fulfil → notice; value absent from storage entries.
- Changes log: undo of an install, a content change, and a settings change.
- Safety: failed install rolls back; repeated runtime failures roll back;
  boot safe mode, including a failing boot adapter.
- `japa check`: manifest validation, conformance, routing eval (scripted
  model).
- End-to-end: boot daemon, attach gateway client, submit, start a job, see the
  report and the job board update.
