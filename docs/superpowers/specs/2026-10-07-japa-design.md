# japa — a self-extensible chief of staff on Pi Durable

Date: 2026-10-07
Status: Draft for review

## 1. Purpose

japa is a personal, always-on agent in the spirit of OpenAI dots. The user talks
to exactly one agent — the **chief of staff (CoS)** — in **one continuous
thread**. The CoS delegates real work to background **jobs**, remembers the
user, reacts to triggers, and **extends itself** (new skills and extensions)
when asked to do something it can't yet do.

### Goals

- **One thread, one counterpart.** The user never manages threads, agents, or
  workers. They talk to the CoS; the CoS reports back.
- **Minimal core, contracts for everything else.** The kernel is small and
  advertises contracts; UIs, triggers, workers, tools, and memory strategy are
  contributions that can be replaced.
- **Self-extension.** The CoS builds skills and extensions itself, picks the
  right mechanism for the requirement, installs automatically, and rolls back
  on failure.
- **Seamless.** The user never needs to know how the backend works. A request
  like "brief me every morning" ends with "Done — here's how it works", not
  with implementation questions.
- **Lean, cheap context.** The CoS's model context is short and reset often,
  while memory persists.
- **General purpose.** Coding and knowledge/personal work are both just
  extensions; the core is domain-agnostic.

### Non-goals (v1)

Messaging surfaces (Slack/Telegram/iMessage), multiple users, out-of-process
extensions, embedding search, approval gates for side-effecting actions,
nested jobs, OAuth flows, a hosted/cloud deployment.

## 2. Foundation: Pi Durable

japa is built on `@earendil-works/pi-durable` (1.0.x, Node ≥ 22.19; we target
Node 24). Concepts we rely on:

- **Harness** over **SQLite storage** (`openNodeSqliteStorage`). Every
  transcript entry, task step, and document change is an atomic commit;
  crashes resume from the last checkpoint.
- **Conversations** (transcripts), **documents** (typed JSON committed with
  entries), **tasks** (durable state machines with timers and child tasks).
- **Extensions** (tools, sections, hooks, wraps, tasks) in a **registry** that
  can be hot-replaced; conversations store extension/tool names, not code.
- **`reset(note)`** starts a fresh model context while keeping all entries in
  storage.
- **Background tasks** own child conversations that survive aborts and do not
  keep the parent busy (pattern from Pi Durable example 23).
- **`watch()` / `viewState()` / `watchTaskGraph()`** for UIs; multiple clients
  can attach to one conversation.
- **`requestId`** for exactly-once submissions.

One process owns the storage. japa therefore runs as one daemon.

## 3. Architecture overview

```
           ┌──────────────── japad (one Node process) ────────────────┐
 surfaces  │  Kernel                                                  │
 (gateway ─┼─▶ contract registry · loader · safety net                │
  + TUI)   │   jobs · context lifecycle · memory · skills · secrets   │
           │   changes log · self-extension                           │
 triggers ─┼─▶ Pi Durable Harness (SQLite: ~/.japa/state.db)          │
           │     root conversation = CoS thread                       │
           │     job conversations (background, owned by anchors)     │
           └──────────────────────────────────────────────────────────┘
 ~/.japa/ (git): extensions/ skills/ memory/ settings.json   secrets/ (not in git)
```

- **Kernel** (`packages/kernel`): the only code the CoS cannot modify.
- **Default extensions** (`extensions/*` in this repo): replaceable.
- **Workspace** (`~/.japa/`): user- and CoS-authored extensions, skills,
  memory, settings. A git repo; every change is a commit.

## 4. Kernel and contracts

### 4.1 Contracts

A **contract** is a named extension point:

```ts
interface Contract<C> {
  name: string;                 // e.g. "surface"
  docs: string;                 // agent-facing guide (advertised, see §8)
  validate(c: unknown): C;      // shape check, used by `japa check`
  activate(c: C, ctx: KernelContext): Promise<Dispose>;
}
```

Built-in contracts:

| Contract  | Contribution                                    | Purpose |
|-----------|-------------------------------------------------|---------|
| `durable` | Pi Durable sections, hooks, wraps, tasks        | Raw harness capabilities |
| `surface` | `start(SurfaceContext) => stop`                 | UIs / clients |
| `trigger` | `start(TriggerContext) => stop`                 | Events that wake the CoS |
| `worker`  | `WorkerProfile`                                 | Job profiles |
| `memory`  | `MemoryStrategy`                                | Replaces the default memory (§6) |

Extensions may **define new contracts**; later extensions contribute to them.
The kernel treats them identically to built-ins.

### 4.2 Extension manifest

An extension is one TypeScript module whose default export is:

```ts
defineJapaExtension({
  name: "gcal",
  summary: "Lets me read and manage your Google Calendar",   // user-facing
  docs: "./skills/using-gcal/SKILL.md",                       // agent-facing, on demand
  examples: ["what's on my calendar tomorrow?", "move my 3pm to 4"],
  tools: [gcalList, gcalUpdate],                 // plain Pi Durable tools
  durable: { sections, hooks, wraps, tasks },   // optional
  surfaces, triggers, workers, memory,           // optional contract contributions
  contracts: [MyContract], contribute: { "my-contract": [...] },
  secrets: ["gcal.token"],                       // names it may read
  settings: Type.Object({ ... }),                // TypeBox schema for its settings
  // skills/ next to index.ts are bundled automatically
});
```

Rules:

- `summary` and `examples` are required. `docs` is required when the extension
  has tools.
- Extensions do **not** declare who may use their tools or how risky they
  are. The manifest's descriptive fields (`summary`, `examples`, `docs`) only
  affect routing; a poor description causes poor routing, which
  `japa check` catches (§10.3), never a safety or role violation.
- Tools listed in a worker profile (§5.2) belong to that profile only; tools
  in the manifest's `tools` are shared capabilities.
- The kernel converts `tools` + `durable` into one Pi Durable `Extension` named
  after the japa extension and installs it in the registry.

### 4.3 Tool selection and the CoS's limits

The kernel computes each conversation's tool list; extensions never classify
themselves.

- **Root (CoS):** all core CoS tools (§5.3, §6.5, §7, §8.3–§8.5, §10), the
  core `read` tool, plus
  **every shared extension tool**. The CoS does quick things itself.
- **Jobs:** core worker tools (§5.4) plus the shared tools of the extensions
  the worker profile selects (`general`: all), plus the profile's own tools.

On every install, reload, or rollback the kernel recomputes these lists and
applies them with `configure({ tools })` to the root and every active job
conversation, in one commit.

Limits on the CoS are enforced structurally, not by declarations:

- **Read-only environment.** The CoS's execution environment is a read-only
  wrapper around `NodeExecutionEnv`: file writes and `exec` are rejected. Any
  tool that changes files or runs processes through the environment fails in
  the CoS, so that work happens in jobs.
- **Result cap.** A tool result entering the CoS context is capped at
  `settings.context.toolResultTokens` (default 2k). The full output stays in
  storage; the CoS sees a truncation note suggesting a job if it needs all of
  it.
- **Delegation guidance** (identity, §8.1): one or two calls → do it
  yourself; multi-step, long-running, or heavy work → start a job.

Safety is the same for the CoS and workers. v1 has no approval gates; in-process
extension failures are handled by §10.4. A future guard for destructive
actions would be a kernel-owned policy applied to the CoS and workers alike.

### 4.4 Loader

- Sources, in order: packaged defaults (`extensions/*`), then
  `~/.japa/extensions/*`. A workspace extension with the same name replaces the
  default.
- TypeScript is loaded with Node 24 native type stripping. Reload is
  `import(file?v=<commit>)` followed by `registry.install()` and contract
  re-activation (dispose old, activate new). Old module copies stay in memory
  until restart.
- After a restart the loader reinstalls all extensions before
  `harness.resume()`, so pending extension tasks continue.

### 4.5 Root conversation

The kernel creates the root conversation on first boot (`harness.root()`) and
configures it as the CoS: CoS model, core sections (§8), tool list (§4.3).

## 5. Jobs (core)

### 5.1 Model

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

### 5.2 Worker profiles (`worker` contract)

```ts
interface WorkerProfile {
  name: string; description: string;
  model?: ModelRef; thinkingLevel?: ThinkingLevel;
  extensions?: string[];   // extensions whose shared tools it gets; default: all
  tools?: Tool[];          // profile-owned tools, available only to this profile
  skills?: string[];       // narrows visible skills; default: all
  instructions: string; cwd?: string;
}
```

Core ships two profiles:

- `general` — default model, all extensions' shared tools, generic instructions.
- `builder` — builds skills and extensions (§10); coding tools, cwd is a
  staging git worktree of `~/.japa`, authoring skills preloaded in its list.

Profile names and descriptions are advertised to the CoS (§8).

### 5.3 CoS job tools

- `job_start({ title, brief, worker? })` → returns the job id immediately.
- `job_message({ id, text, mode: "steer" | "followup" })`
- `job_stop({ id })`
- `job_list()`
- `job_transcript({ id, tail? })` — inspect a job only when needed.

### 5.4 Worker job tools

- `job_progress({ note })` — updates `progress` for live status.
- `job_complete({ summary })` — sets `done`, stores `result`, ends the run.
- A run that ends without `job_complete` sets `needs_input`; its last message
  becomes the question.
- A run that fails (error after retries) sets `failed`.

Workers cannot start jobs in v1.

### 5.5 Reporting

A background reporter task posts each state change that needs CoS attention
(`done`, `needs_input`, `failed`) into the root conversation as a short input,
e.g. `[job 7 "Fix CI" done] <summary>`, with
`requestId = report:<jobId>:<seq>`, so a restart never double-posts. The CoS
decides what to tell the user, what to answer itself, and what to start next.

## 6. CoS context and memory (core)

### 6.1 Two views of one thread

Storage keeps every entry and surfaces render the full history, so the user
sees one continuous chat. The model sees only the **current context** since
the last `reset()`.

### 6.2 What the CoS sees on each request

Rendered as sections, in this order (static first, for prompt caching):

1. **Identity** — role, how japa works, mechanism ladder, UX rules (§8).
2. **Contracts and capabilities** — generated from manifests (§8).
3. **About you** — the user fact list (§6.4).
4. **Open loops** — commitments and things being waited on.
5. **Job board** — one line per non-terminal job, plus jobs finished since
   the last reset.
6. **Handoff note** — written at the last reset.
7. **Live window** — messages since the last reset.

### 6.3 Context lifecycle

- **Trigger:** the CoS is idle **and** either the live window exceeds
  `settings.context.resetTokens` (default 20k) or the time since the last user
  message exceeds `settings.context.idleResetHours` (default 2).
- **Consolidate:** a background durable task on the consolidation model reads
  the live window and, in one commit to memory files and documents:
  1. runs **reflection** (§6.4) on the user facts,
  2. updates **open loops** (add new commitments, close finished ones),
  3. writes an **episode summary** to `memory/episodes/`,
  4. writes the **handoff note**.
- **Reset:** the task then calls `reset(handoffNote)`. If the conversation
  became busy or got new entries after consolidation started, the result is
  discarded and consolidation retries at the next trigger.
- Pi Durable's automatic compaction stays enabled only as a fallback.

### 6.4 User facts ("About you") — reflection

Like ChatGPT's saved memories: a high-level picture of the user, not a log or
an exhaustive overview.

- **Entry:** `{ id, text, updatedAt }`, up to ~2 sentences (≤ 50 words), one
  lasting aspect per entry: who the user is, what they're working toward, how
  they like to work, key people and projects, standing preferences.
- **Cap:** ~30 entries and ~1.5k tokens total.
- **Reflection** is one consolidation-model pass that sees the live window and
  the current list and outputs only operations: `add(text)`,
  `update(id, text)`, `delete(id)`, or `none`. Its rules:
  - record patterns and lasting context, not events or task details;
  - fold new details into an existing entry and generalize, rather than
    adding entries;
  - rewrite entries that have become too specific at a higher level;
  - skip sensitive details unless the user explicitly asks to remember them.
- **Kernel enforcement:** an entry over 50 words is returned once for
  shortening and dropped if still too long; exceeding the cap triggers a
  **merge pass** that combines related entries and drops the least useful
  until it fits; near-duplicates (normalized text similarity) are rejected.

### 6.5 User control and recall

CoS tools:

- `memory_facts()` — "what do you remember about me?"
- `memory_remember({ text })` — immediate add (same limits), for "remember
  that…".
- `memory_forget({ id })` — for "forget that…".
- `memory_search({ query })` — keyword search over episode summaries and job
  results, for recall beyond the always-loaded memory.

When the CoS saves something during a conversation it may add a brief
"(noted: …)" to its reply.

### 6.6 Storage and replacement

`~/.japa/memory/facts.json`, `loops.json`, `episodes/*.md`, committed to the
workspace git repo after each consolidation. The `memory` contract
(`MemoryStrategy`: `sections()`, `consolidate(window)`, `search(query)`) lets
an extension replace the whole strategy; the kernel's implementation is the
default contribution.

## 7. Skills (core loader)

Pi Durable has no skills; japa adds them.

- **Format:** Agent Skills `SKILL.md` with `name` and `description`
  frontmatter, optional `scripts/` and reference files. Skills do not
  declare an audience.
- **Locations, later overrides earlier by name:** packaged `skills/`,
  `extensions/<x>/skills/`, `~/.japa/skills/`.
- **Progressive disclosure:** each conversation gets a section listing name +
  description of all skills (for jobs, narrowed by the worker profile's
  `skills` if set). `skill_read({ name, file? })` loads the body
  or a referenced file.
- Skills contain no code that the daemon runs; scripts inside a skill are run
  by workers through their own tools.

## 8. Self-model and seamless UX

### 8.1 Identity section (static)

- **Role:** the user's only point of contact. Keep your own context lean;
  do quick things yourself (one or two tool calls); delegate multi-step,
  long-running, or heavy work — and anything that writes files or runs
  commands — to a job.
- **How japa works:** one paragraph each on the thread, jobs, memory, skills,
  extensions, triggers, surfaces.
- **Mechanism ladder** — use the smallest mechanism that meets the need:

  | Need | Mechanism |
  |------|-----------|
  | A fact or preference about the user | memory |
  | Adjust something that already exists | settings / config (schedules, worker defaults, extension settings) |
  | A procedure or know-how using existing tools | **skill** |
  | New capability: a new API/service, new state, events, a UI, or enforcement (guarantee, not guidance) | **extension** |

  Test: if existing tools plus written instructions can do it, it's a skill.
  Often both: an extension provides the tool and bundles a skill that teaches
  when and how to use it.

- **UX rules:**
  1. Never make the user think about the backend; don't mention skills,
     extensions, contracts, or jobs unless asked.
  2. Ask only what only the user can answer: credentials, preferences that
     matter, consent for irreversible external actions. Never ask about
     implementation.
  3. Short acknowledgement → do it → **verify** (checks plus a real dry run)
     → report.
  4. Report = **what's done**, **how to use it**, **how to change or undo
     it**, in plain language. Example: "Done. Every weekday at 8am you'll get
     a brief on today's calendar and anything urgent in your inbox. Say 'move
     my brief' or 'stop the brief' to change it."

### 8.2 Capabilities section (generated)

Rebuilt from manifests on every registry change: one line per extension
`summary`, worker profiles with descriptions, active triggers and schedules,
and the list of contracts with one-line descriptions. Detailed contract docs
and authoring guides are skills (§11.2), not always-loaded context.

### 8.3 Changes log

Root document `japa.changes`: a user-level changelog.

```ts
{ id, at, title, howToUse, undo: { commits: string[], configOps?: ConfigOp[] } }
```

Every install, skill change, settings change, or schedule the CoS makes on the
user's behalf adds an entry. CoS tools: `changes_list()`,
`change_undo({ id })` (reverts the commits and inverts config ops, then
reloads). This makes "undo that" and "what did you set up last week?" work.

### 8.4 Settings

`~/.japa/settings.json`, read live through Pi Durable settings getters. Holds
the models (CoS, consolidation, default worker), job concurrency, context
thresholds, memory caps, and per-extension settings validated against each
extension's schema. CoS tools: `settings_get({ path? })`,
`settings_set({ path, value })` (validated; logged in `japa.changes`).

### 8.5 Secrets

- `secret_request({ name, why })` (CoS tool) records a pending request in the
  root document `japa.secretRequests` and returns immediately.
- Surfaces show pending requests as masked prompts (part of the `surface`
  contract). The value is written to `~/.japa/secrets/<name>` (mode 600,
  outside git) and never enters the transcript.
- On fulfilment the kernel posts `[secret <name> provided]` into the CoS
  thread (`requestId = secret:<name>:<requestId>`).
- Extensions read only the secrets their manifest lists, via
  `ctx.secret(name)`.

## 9. Triggers and surfaces (contracts)

### 9.1 `trigger`

```ts
interface TriggerContext {
  emit(event: { key: string; text: string }): Promise<void>; // into the CoS thread
  docs: DocAccess; settings: unknown; secret(name: string): Promise<string>;
}
```

`emit` submits a short input to the root conversation with
`requestId = trigger:<extension>:<key>`, so each event is delivered exactly
once. Triggers needing durable timers use Pi Durable tasks via the `durable`
contract.

### 9.2 `surface`

```ts
interface SurfaceContext {
  root: { submit(input, mode), abort(), watch(), viewState() };
  job(id): { watch(), viewState() };        // read-only job view
  taskGraph(): ChordState;
  secrets: { pending(), fulfil(name, value) };
}
```

## 10. Self-extension and safety net (core)

### 10.1 Workspace and boundary

`~/.japa/` is a git repo: `extensions/`, `skills/`, `memory/`,
`settings.json`. The CoS and its jobs may change these. They can **never**
change the kernel package, so the kernel can always repair everything else.

### 10.2 Building

1. The CoS chooses the mechanism (ladder, §8.1) and starts a `builder` job
   with a brief stating the requirement and the chosen mechanism. The builder
   may escalate from skill to extension if a skill can't meet the
   requirement, and says so in its summary.
2. The builder works in a staging worktree and runs
   `japa check <name>` (§10.3).
3. On `job_complete`, the CoS calls `skill_install({ name })` or
   `extension_install({ name })`.
4. **Skill install:** lint frontmatter, merge, commit, refresh skill sections.
5. **Extension install:** merge and commit, import, activate, recompute tool
   lists, health-check (§10.4), record in `japa.changes`.
6. On failure: revert the commit, re-activate the previous version, report the
   error into the CoS thread. The CoS retries via the builder or tells the
   user plainly.
7. The CoS verifies with a real dry run where possible, then reports (§8.1).

### 10.3 `japa check`

- **Typecheck** (`tsc --noEmit`) and the extension's own tests (vitest).
- **Static manifest checks:** `summary`, `examples`, and (if it has
  tools) `docs` present; tool description length limits; no unexpected tool-name
  collisions.
- **Smoke load** in a throwaway harness on `MemoryStorage`: contract shapes
  valid, `activate`/`dispose` clean, the extension appears in the rendered
  capabilities section, and the computed root/job tool lists include its tools as §4.3 specifies.
- **Routing eval:** the consolidation model sees the full capabilities
  section and each `example`; it must route to this extension (directly or
  via a suitable worker), without taking over other extensions' examples.
- **Regression:** re-run every installed extension's routing examples.

Skills get a lighter check: frontmatter lint and, if they declare
`examples`, the routing eval.

### 10.4 Runtime protection

- **Health check after install:** contributions activate, surfaces start, and
  triggers start within a timeout.
- **Auto-rollback:** an extension whose contributions throw repeatedly
  (surface fails to start, trigger crashes, tool error rate above
  `settings.safety.toolErrorThreshold`) is rolled back to its last-known-good
  version; the CoS is told.
- **Last-known-good tag:** updated after an extension has run healthily for
  `settings.safety.goodAfterMinutes` (default 10).
- **Boot safe mode:** three crashes within five minutes of boot → start with
  kernel + defaults at last-known-good; the CoS is told on next contact.
- Manual: CoS tool `extension_rollback({ name, to? })`; CLI `japa rollback`
  and `japa safe-mode`.

## 11. Packaged defaults

### 11.1 Default extensions

| Extension | Contracts | What it does |
|-----------|-----------|--------------|
| `gateway` | surface | WebSocket server on `~/.japa/japa.sock`; streams root `watch()` frames, `japa.jobs`, pending secret requests; accepts submit (input/steer/follow-up), abort, secret responses, job view attach. Includes the `japa chat` TUI client (pi-tui): thread on the left, live job board on the right, masked secret prompts. Closing the TUI does not stop the daemon. |
| `schedule` | trigger, durable | Durable cron and one-shot timers in `japa.schedules`; CoS tools `schedule_add` / `schedule_list` / `schedule_remove` (logged in `japa.changes`); fires via `emit`. |
| `web` | tools | `web_fetch` (no key) and `web_search` (pluggable provider; asks for its key with `secret_request` on first use). |
| `coder` | worker | Profile owning the coding tools (`read`, `write`, `edit`, `bash`) with a configurable cwd. |
| `researcher` | worker | `web` tools plus a profile-owned `write` for report files; uses the `research` skill. |

With these defaults the CoS directly has `web_fetch`, `web_search`, and the
`schedule_*` tools, plus the kernel's core `read` tool (in its read-only
environment). Coding tools stay with the `coder` profile.

### 11.2 Default skills

Agent-facing (the self-model, loaded on demand):

- `choosing-a-mechanism` — the ladder with worked examples.
- `building-skills` — SKILL.md format, progressive disclosure, scripts.
- `building-extensions` — manifest, contracts API, fake-model testing,
  `japa check`, shared vs profile-owned tools.
- `writing-job-briefs` — good briefs, choosing a worker, parallel jobs,
  follow-ups.
- `reporting-changes` — the done / how-to-use / how-to-undo format.

Task:

- `research` — a sourced, structured research report.

Further task skills are created from real requests.

## 12. CLI

`japa daemon` · `japa chat` · `japa status` · `japa check <name>` ·
`japa rollback <name> [to]` · `japa safe-mode`

## 13. Repository layout

pnpm workspace in `/home/dshi/projects/japa`:

```
packages/kernel/       contracts, loader, jobs, context lifecycle, memory,
                       skills, secrets, changes, self-extension, safety
packages/cli/          japa daemon and subcommands
extensions/gateway/    surface + TUI client
extensions/schedule/   trigger
extensions/web/        tools
extensions/coder/      worker
extensions/researcher/ worker
skills/                default skills
docs/superpowers/specs/
```

## 14. Error handling

- Model and stream retries: Pi Durable settings.
- Jobs: failures become `failed` and are reported; `needs_input` is a normal
  state, not an error.
- Triggers, job reports, secret notices: idempotent via `requestId`.
- Consolidation: a durable task; a crash resumes it; a stale result is
  discarded (§6.3).
- Extensions: §10.4.

## 15. Testing

vitest with Pi AI's faux provider (scripted model responses; no network):

- Contract registry and loader: define/contribute, hot reload, same-name
  replace, rollback.
- Tool selection: root gets all shared tools, profile-owned tools stay in
  their profile; result cap; read-only
  CoS environment.
- Jobs: lifecycle, concurrency queue, `needs_input`, restart mid-job with no
  double reports.
- Context: consolidate → reset; open loops and facts survive; stale
  consolidation is discarded.
- Reflection limits: long entries rejected/shortened, cap triggers merge,
  duplicates rejected.
- Skills: discovery, override order, worker-profile narrowing, `skill_read`.
- Secrets: request → fulfil → notice; value absent from storage entries.
- Changes log: undo of an install and of a settings change.
- Safety: failed install rolls back; repeated runtime failures roll back;
  boot safe mode.
- `japa check`: manifest validation and the routing eval (with a scripted
  model).
- End-to-end: boot daemon, attach gateway client, submit, start a job, see the
  report and the job board update.
