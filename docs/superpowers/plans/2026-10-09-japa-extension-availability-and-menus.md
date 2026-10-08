# Extension availability and the /settings and /jobs menus — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Hide unconfigured/switched-off extensions from the CoS and workers, and rebuild the messaging `/settings` and `/jobs` menus with navigation, current values, full control and job cleanup.

**Architecture:** A kernel `availability.ts` decides each extension's state; the runtime keeps an `available` set that filters the root selection, job agents and capabilities, and is recomputed whenever a secret or setting changes. The menu becomes `src/kernel/messaging/menu/` with a small navigation layer (screens, Back/Home, paging, outcomes, typed input) and one file per area. Jobs gain pruning; schedules gain pause/resume.

**Tech Stack:** TypeScript (Node 24, type-stripping, `.ts` imports), vitest, `@earendil-works/pi-durable`, `@earendil-works/pi-ai` TypeBox.

**Spec:** `docs/superpowers/specs/2026-10-09-japa-extension-availability-and-menus-design.md` — read it; this plan argues from it.

## Global Constraints

- Run tests with `npx vitest --run <files>`; the full suite with `npx vitest --run`; types with `npx tsc --noEmit`. Both must be clean at the end of every task.
- Follow the repo's style: short doc comments on exported functions, no new dependencies, `.ts` import suffixes.
- Every change made from a menu goes through the existing code paths (`setSetting`, `change_undo`, `rollback`, the schedule tools via `messaging.tool`) so it is validated and logged.
- Button actions ≤ 64 bytes. Messages fitted to `adapter.maxMessageChars` (first part of `splitMessage`).
- Labels and copy pinned by the spec are used verbatim: `‹ Back`, `⌂ Home`, `‹`, `›`, `Cancel`, `✓ `, `✗ `, `Send the new value as your next message.`, `This menu expired — send /settings again.` (or `/jobs`), `Clear finished`, `Full brief`, `Use CoS model`, `Turn off`, `Turn on`, `Roll back to last known good`, `Pause`, `Resume`, `Remove`, `Undo`, `No jobs.`, `No schedules.`.
- Extension state labels: `✅ on`, `⚪ not set up`, `⏸ off`, `⚠️ error`. Job icons: `⏳` queued, `🔄` running, `❓` needs_input, `✅` done, `❌` failed, `⛔` cancelled.
- Page size 8; action map cap 500; `jobs.keepFinishedDays` default 7, integer ≥ 1; prune interval 1 hour (unref'd); brief cut at 800 chars.

## Review Focus

1. A secret typed into a menu input must never reach the CoS or stay in the chat: deleted at once, and a re-delivered copy dropped (Task 5 test "secret input is deleted and a re-delivery is dropped").
2. Telegram's own token or a CoS-pending secret request set from the menu must not leave the request pending or a `secretProvided` waiter hanging (Task 7 test "setting a requested secret from the menu fulfils the request").
3. Resuming a paused cron schedule must not fire twice (old task exits by `gen`) (Task 4 test).
4. Pruning must never remove queued, running or needs_input jobs, however old (Task 3 test).
5. Turning off / un-configuring an extension mid-job must not crash the job's next run: its agent is reconfigured without it (Task 2 test "a running job loses a hidden extension's tools").

---

### Task 1: availability rule

**Files:**
- Create: `src/kernel/availability.ts`
- Modify: `src/cli/configure.ts` (import `askedProperties`/`isConfigured` from the kernel; `isConfigured(ctx, e)` call sites adapt), `src/kernel/settings-tools.ts` (`settingsSchema`)
- Test: `test/availability.test.ts` (new), `test/configure.test.ts`, `test/settings-tools.test.ts`

**Interfaces:**
- Produces:
  - `export type ExtensionState = "on" | "off" | "not set up"`
  - `export type SecretReader = { get(name: string): Promise<string | undefined> }`
  - `export function askedProperties(e: JapaExtension): Record<string, TSchema>` (moved verbatim)
  - `export async function isConfigured(e: JapaExtension, secrets: SecretReader, extensionSettings: Record<string, JsonObject | undefined>): Promise<boolean>` — a `get` that throws counts as not set.
  - `export async function extensionState(e, secrets, extensionSettings): Promise<ExtensionState>` — not configured → `"not set up"`; else `extensionSettings[e.name]?.enabled === false` → `"off"`; else `"on"`.
  - `settingsSchema(e)` now always returns an object schema containing `enabled: Type.Optional(Type.Boolean({ description: "Set false to hide this extension from japa" }))`, plus `owner` for messaging extensions, plus the extension's own properties (keeping its `required`).

- [ ] **Step 1: Write failing tests** in `test/availability.test.ts`: an extension with secret `x.key` and no stored value → `"not set up"`; stored → `"on"`; stored + `{ enabled: false }` → `"off"`; a `generated: true`-only extension → `"on"`; a required setting without default unset → `"not set up"`, set → `"on"`; a secrets reader that throws → `"not set up"`. In `test/settings-tools.test.ts`: `settingsSchema` of an extension without settings has `enabled`; `settings_set extensions.brave.enabled false` is accepted and `"no"` is rejected.
- [ ] **Step 2: Run** `npx vitest --run test/availability.test.ts test/settings-tools.test.ts` — FAIL.
- [ ] **Step 3: Implement** the module and the `settingsSchema` change; `configure.ts` keeps its exported `isConfigured(ctx, e)` as a thin wrapper over the kernel one using `ctx.secrets` and `readUserSettings(ctx.home).extensions`.
- [ ] **Step 4: Run** the new tests plus `test/configure.test.ts test/setup.test.ts` — PASS (an `enabled` property is optional, so `askedProperties`/`offerKeys` don't change).
- [ ] **Step 5: Commit** `feat(kernel): extension availability rule; every extension's settings accept enabled`

### Task 2: runtime hides unavailable extensions

**Files:**
- Modify: `src/kernel/runtime.ts`, `src/kernel/jobs/cos.ts` (`JobsOptions`, `agentOf`), `src/kernel/boot.ts`, `src/kernel/settings-tools.ts` (`SettingsDeps.changed` → `() => Promise<void>`, awaited), `src/kernel/contracts.ts` (`Status`), `src/kernel/status.ts`
- Test: `test/availability.test.ts`, plus fix any existing tests whose fixtures relied on an unconfigured extension's tools (e.g. `test/brave.test.ts`, `test/parallel.test.ts` — store the key in the fixture rather than weaken assertions)

**Interfaces:**
- Consumes: Task 1's `extensionState`.
- Produces:
  - `createRuntime` input gains `secrets: SecretReader`; runtime gains `available: ReadonlySet<string>`, `states: ReadonlyMap<string, ExtensionState>` and `refreshAvailability(root?: Conversation): Promise<void>` — recomputes states from `settings.extensions`; when the available set changed it re-splices `selection` (cos, safety, jobs, skills, then only available built extensions), refreshes capabilities, and if `root` is given commits `reconfigureJobs`. `start` computes states before the tool phase's `reloadContent`.
  - `JobsOptions.available: () => ReadonlySet<string>`; `agentOf` includes only available extensions, whether the profile names them or not.
  - `capabilities()` is given only available extensions.
  - `Status.extensions[]` gains `state?: ExtensionState`; `statusText` appends ` (not set up)` / ` (off)` after the summary when state is not `"on"`.
  - boot calls `rt.refreshAvailability(root)` after: `KernelContext.setSecret`, `surface.secrets.fulfil`, every `setSetting`/`change_undo` (via `changed`), and `reconcile`.

- [ ] **Step 1: Write failing tests** (boot-level, `bootTest` with an extra test extension `demo` providing tool `demo_ping` and secret `demo.key`): `demo_ping` absent from the root's tools and capabilities text and `status()` shows `not set up`; a job started with a profile naming `demo` has no `demo_ping`; after `kernel.setSecret` / secret request fulfil / `settings_set` the tool appears live without restart; `settings_set extensions.demo.enabled false` hides it again and status shows `off`; adapters of an unconfigured extension still activate (a fake messaging extension with an unset secret still gets `start` called); "a running job loses a hidden extension's tools" — job's next run after turning `demo` off has no `demo_ping` and completes. `statusText` cases for `(not set up)` / `(off)`.
- [ ] **Step 2: Run** `npx vitest --run test/availability.test.ts` — FAIL.
- [ ] **Step 3: Implement** as in Interfaces.
- [ ] **Step 4: Run** `npx vitest --run` and `npx tsc --noEmit` — all PASS.
- [ ] **Step 5: Commit** `fix(kernel): unconfigured and switched-off extensions are hidden from the CoS and workers`

### Task 3: job pruning

**Files:**
- Modify: `src/kernel/settings.ts` (`jobs: { maxConcurrent; keepFinishedDays }`, default 7, schema `Type.Integer({ minimum: 1 })`), `src/kernel/jobs/state.ts`, `src/kernel/boot.ts`, `src/kernel/contracts.ts` (`MessagingContext`)
- Test: `test/jobs-state.test.ts`, `test/jobs-control.test.ts` (or a new `test/jobs-prune.test.ts`), `test/settings.test.ts`

**Interfaces:**
- Produces:
  - `export function prune(jobs: Record<string, Job>, before: number): number` — deletes done/failed/cancelled jobs with `updatedAt < before`; returns how many.
  - `MessagingContext.clearFinishedJobs(): Promise<number>` — `prune(…, Infinity)` in a root commit.
  - boot prunes with `before = now - keepFinishedDays * DAY` once after the root docs exist, then hourly (`setInterval(…, 3_600_000).unref()`, cleared in `close`).

- [ ] **Step 1: Failing tests:** `prune` removes old finished jobs only, never queued/running/needs_input (even with `updatedAt = 0`), returns the count; `keepFinishedDays` defaults to 7 and `0` is rejected by `settings_set`; a daemon booted with a 10-day-old done job and a 1-day-old one keeps only the latter; `clearFinishedJobs` removes all finished jobs and leaves active ones; `job_transcript` on a pruned id answers `No job <id>.`.
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement.** **Step 4: Run** the touched test files + `npx tsc --noEmit` — PASS.
- [ ] **Step 5: Commit** `feat(jobs): finished jobs are pruned after jobs.keepFinishedDays; clearFinishedJobs`

### Task 4: schedule pause and resume

**Files:**
- Modify: `extensions/schedule/index.ts`
- Test: `test/schedule.test.ts`

**Interfaces:**
- Produces: `Schedule` gains `paused?: boolean`, `gen?: number`; task input `{ id: string; gen?: number }` (missing = 0) — the task exits when the schedule is gone, paused, or its `gen ?? 0` differs from the input's. Tools `schedule_pause({ id })` → `Paused schedule <id>.` (logged; undo `call` → `schedule_resume`), `schedule_resume({ id })` → `Resumed schedule <id>: next at <local>.` (increments `gen`; cron: next occurrence after now; once: `next` unchanged; starts a new task; logged; undo `call` → `schedule_pause`). Both answer `No schedule <id>.` for unknown ids and `Schedule <id> is already paused.` / `Schedule <id> isn't paused.` when redundant. `schedule_list` `details` items: `{ id, text, cron?, at?, next, paused, label }`; its text line gets ` (paused)` for paused ones. Add the new tools to the extension's `docs`.

- [ ] **Step 1: Failing tests:** a paused one-shot doesn't fire; resuming a past-due one-shot fires it once; pause then resume a cron schedule (`* * * * *`, using the existing test style for timing) fires exactly once per occurrence — never twice; pause/resume logged and appear in `changes_list`; a schedule created before this change (no `gen`) still fires; list details include `paused`.
- [ ] **Step 2–4:** Run (FAIL), implement, run `npx vitest --run test/schedule.test.ts` + `npx tsc --noEmit` (PASS).
- [ ] **Step 5: Commit** `feat(schedule): pause and resume`

### Task 5: menu navigation layer

**Files:**
- Delete: `src/kernel/messaging/menu.ts`
- Create: `src/kernel/messaging/menu/index.ts` (`createMenu`, `COMMANDS`, `HELP`), `src/kernel/messaging/menu/nav.ts`, `src/kernel/messaging/menu/settings.ts` (Home + the existing Models/Schedules/Extensions screens ported as-is onto nav — later tasks replace them), `src/kernel/messaging/menu/jobs.ts` (existing jobs screens ported)
- Modify: `src/kernel/messaging/surface.ts` (route the owner's text to a pending menu input), `test/messaging-menu.test.ts` (import path; adapt to Back/Home and outcomes)

**Interfaces:**
- Produces (`nav.ts`):
  - `export type Button = { label: string; action: string }`
  - `export type Page = (outcome?: string) => Promise<OutgoingMessage>` — every screen is a Page; `outcome` is a pre-formatted first line.
  - `export function outcomeLine(reply: string): string` — `Not changed: X` → `✗ X`; otherwise `✓ <reply>`.
  - `export function createNav(scope: "s" | "j", run: string)` returning `nav` with:
    - `button(label, page: Page): Button` — action `<run>:<scope>:<n>`; the map keeps the newest 500.
    - `act(label, run: () => Promise<string>, then: Page): Button` — runs, then renders `then(outcomeLine(reply))`; a thrown error renders `then("✗ " + message)`.
    - `screen({ title, body?, rows, back?, home?, outcome? }): OutgoingMessage` — markdown `[outcome\n\n]**title**[\n\nbody]`; rows then a footer row `‹ Back` (when `back`) · `⌂ Home` (when `home`).
    - `paged({ title, body?, items: Button-producing [label, Page][], page?, back?, home?, outcome? })` — 8 per page, nav row `‹` · `p/n` (a button re-rendering the same page) · `›` only when >1 page.
    - `confirm(question, yes, run, then: Page, back: Page): Page` — buttons `yes` (→ `act`) and `Cancel` (→ back).
    - `ask({ title, prompt?, secret?: boolean, apply: (text: string) => Promise<string>, then: Page, cancel: Page }): Page` — renders `Send the new value as your next message.` with `Cancel`, and registers a pending input.
  - Menu (`index.ts`) API used by the surface: `command(m)`, `press(m)`, `pendingInput(): boolean`, `input(m: Incoming): Promise<void>` (deletes the message first when secret, records `<adapter>:<id>` via `messaging.recordSecretMessage(by)` — a new `MessagingContext` method setting `SecretRequestsDoc.fulfilledBy` — then applies and edits the menu message to `then(outcome)`), `cancelInput()`. A command, `Cancel`, or any other press cancels a pending input. Expired: `This menu expired — send /settings again.` (scope `j` → `/jobs`; pre-restart/unknown format → `/settings`).
  - Surface order in `handle`: owner check → command (cancels menu input and secret prompt) → action → re-delivered secret drop (`secretFulfilledBy`) → pending menu input (text only) → pending secret request → CoS buffer. When a menu input ends and a secret request is pending, the request prompt is sent again.

- [ ] **Step 1: Failing tests** in `test/messaging-menu.test.ts`: every non-home screen has `‹ Back` and `⌂ Home`; Back returns to the previous screen; a successful action shows `✓ …` on the screen it came from, a rejected one `✗ …`; paging shows `1/2`; typed input reaches the menu, not the CoS (no submission); "secret input is deleted and a re-delivery is dropped" (message id in `fake.deleted`, value never in the CoS transcript, delivering the same id again is dropped); `/status` and `Cancel` and another button cancel input (next text goes to the CoS); a menu input takes precedence over a pending secret request, and the request prompt is re-sent after; the 501st-oldest action expires; `/jobs` stale button says `send /jobs again`.
- [ ] **Step 2: Run** `npx vitest --run test/messaging-menu.test.ts test/messaging.test.ts` — FAIL.
- [ ] **Step 3: Implement.** Existing behaviour tests (model set & undoable, schedule remove with confirm, rollback, jobs list) keep passing, adapted only for the new Back/Home rows and outcome lines.
- [ ] **Step 4: Run** the two files + full suite + `npx tsc --noEmit` — PASS.
- [ ] **Step 5: Commit** `refactor(messaging): menu navigation — Back/Home, outcomes, paging, typed input`

### Task 6: settings home, Models, General, Recent changes

**Files:**
- Modify: `src/kernel/messaging/menu/settings.ts`, `src/kernel/contracts.ts` + `src/kernel/boot.ts` (`MessagingContext.changes(): Promise<Change[]>`, newest first)
- Test: `test/messaging-menu.test.ts`

**Interfaces:**
- Consumes: Task 5 `nav`; Task 3 `jobs.keepFinishedDays`.
- Produces: Home buttons in this order: `Models`, `Extensions`, `Schedules`, `General`, `Recent changes`.
  - Models body lines `CoS: p/m`, `Worker: p/m | same as CoS`, `Consolidation: …`; role → providers where `await models.checkAuth(p) !== undefined` and with ≥1 model → paged models labelled `✓ <id>` for the current one; Worker/Consolidation role screens add `Use CoS model` (`setSetting(path, undefined)`). After setting, the Models screen shows the outcome.
  - General: one button per row of spec §3.6, labelled `<Label>: <value>`, each an `ask` whose `apply` is `setSetting(path, text)` (the validator converts numerals).
  - Recent changes: 10 newest, label `<id> <title> · <age>` (age as Task 9's `ago`; define `ago(ms): string` in `nav.ts` — `<1m`, `Nm`, `Nh` (<48h), `Nd`); detail body: title, local time, howToUse; `Undo` → confirm → `change_undo` via `messaging.tool`, or for a change with `undo.call`, that tool via `messaging.tool`; outcome on the Recent changes list.

- [ ] **Step 1: Failing tests:** Models body shows current values; the current model is ticked; a provider without credentials isn't listed (use a kit/provider whose `checkAuth` is undefined); `Use CoS model` clears `models.worker` and is logged; General shows `Max concurrent jobs: 4`, typing `2` sets it (`✓ Set jobs.maxConcurrent…`), typing `0` shows `✗ …` and changes nothing; Recent changes lists a change made by `settings_set` and `Undo` reverts it; undoing a schedule-add change removes the schedule.
- [ ] **Step 2–4:** FAIL, implement, `npx vitest --run test/messaging-menu.test.ts` + `npx tsc --noEmit` PASS.
- [ ] **Step 5: Commit** `feat(messaging): settings menu — models with current values, general settings, recent changes with undo`

### Task 7: Extensions screens

**Files:**
- Create: `src/kernel/messaging/menu/extensions.ts`
- Modify: `src/kernel/messaging/menu/settings.ts` (route), `src/kernel/contracts.ts`, `src/kernel/boot.ts`
- Test: `test/messaging-menu.test.ts` (extensions describe block)

**Interfaces:**
- Consumes: Task 2 `rt.states`, `refreshAvailability`; Task 1 `settingsSchema`, `askedSecretNames`; Task 5 `nav.ask({ secret: true })`.
- Produces:
  - `export type ExtensionInfo = { name: string; summary?: string; state: ExtensionState; error?: string; status?: string; workspace: boolean; loaded: boolean; secrets: { name: string; description?: string; set: boolean }[]; schema?: TSchema; values: JsonObject }`
  - `MessagingContext.extensions(): Promise<ExtensionInfo[]>` — loaded extensions plus workspace ones that failed to load (`loaded: false`, `state: "not set up"`), sorted by name.
  - `MessagingContext.setSecret(extension: string, name: string, value: string, by?: string): Promise<string>` — rejects an undeclared name (`Not changed: …`); when a request for `name` is pending, fulfils it through `surface.secrets.fulfil` (tells the CoS, resolves waiters); otherwise stores it, resolves `secretProvided` waiters, records `by`; then `refreshAvailability(root)`; returns `Set <name>.`.
  - List labels `<name> · <✅ on | ⚪ not set up | ⏸ off | ⚠️ error>` (error wins). Detail body: summary; status line; `Error: …`; `Secrets:` lines `- <name>: set|not set`; `Settings:` lines `- <prop>: <JSON value> | default (<default>) | not set` (excluding `enabled`). Buttons: `Set <secret>` each; one per setting except `enabled` — boolean toggles on press (`<prop>: on|off`), enum (`enum` array or `anyOf` of `const`) opens a choice list with `✓` on the current, otherwise `ask` (JSON-parse the text if it parses, else the string); `Turn off`/`Turn on` when configured (`enabled` false/undefined); `Roll back to last known good` (confirm) when `workspace`.

- [ ] **Step 1: Failing tests:** list labels for an `on`, a `not set up` (`demo` with unset `demo.key`) and an errored workspace extension; detail shows `demo.key: not set` and never a stored value; `Set demo.key` → typed secret is deleted, stored, label becomes `✅ on`, and `demo_ping` becomes available to the CoS; "setting a requested secret from the menu fulfils the request" (pending `secret_request` for `demo.key` disappears and the CoS gets `[secret demo.key provided]`); boolean toggle, enum choice and typed setting each set through `setSetting` and appear in `changes_list`; invalid typed value shows `✗`; `Turn off` → `⏸ off` and the tool disappears, `Turn on` restores; rollback still works after confirmation (existing test moved here).
- [ ] **Step 2–4:** FAIL, implement, run file + full suite + `npx tsc --noEmit` PASS.
- [ ] **Step 5: Commit** `feat(messaging): extensions menu — secrets, settings, on/off, rollback`

### Task 8: Schedules screens

**Files:**
- Modify: `src/kernel/messaging/menu/settings.ts` (or create `menu/schedules.ts`)
- Test: `test/messaging-menu.test.ts`

**Interfaces:**
- Consumes: Task 4 tools and `schedule_list` details.
- Produces: list label `⏸ <label>` for paused, else `<label>`, paged; `No schedules.` body when empty (still with Back/Home). Detail body: text; `Repeats: <cron>` or `Once: <local time>`; `Next: <local time>` or `Paused`. Buttons `Pause`/`Resume` (act → tool; outcome on the detail), `Remove` (confirm → tool; outcome on the list).

- [ ] **Step 1: Failing tests:** detail shows `Repeats: 0 9 * * *` and `Next: …`; `Pause` shows `✓ Paused schedule 1.` and `Paused`, list shows `⏸ `; `Resume` restores; `Remove` asks then removes with `✓ Removed schedule 1.` on the list; empty list says `No schedules.` with Back/Home.
- [ ] **Step 2–4:** FAIL, implement, PASS (`npx vitest --run test/messaging-menu.test.ts`, `npx tsc --noEmit`).
- [ ] **Step 5: Commit** `feat(messaging): schedules menu — details, pause/resume, remove`

### Task 9: /jobs screens, README

**Files:**
- Modify: `src/kernel/messaging/menu/jobs.ts`, `README.md` (the messaging paragraph: what `/jobs` and `/settings` offer; that unconfigured extensions are hidden until set up via `japa setup` or `/settings`, and `extensions.<name>.enabled`; `jobs.keepFinishedDays`)
- Test: `test/messaging-menu.test.ts`

**Interfaces:**
- Consumes: Task 3 `clearFinishedJobs`; Task 6 `ago`.
- Produces: `/jobs` is a home screen (no Back; `⌂ Home` absent on it, present on detail). Body `N running · N needs input · N queued · N finished` (omit zero parts; `No jobs.` when none). Buttons: active jobs by id, then finished newest `updatedAt` first, label `<icon> #<id> <title> · <ago>` cut to 64 chars with `…`; `Clear finished` (confirm) when any finished → outcome `✓ Cleared N finished jobs`. Detail exactly as spec §4.2: line 1 `**#<id> <title>**`, line 2 `<icon> <status> · worker <worker>`, line 3 `Started <ago> ago · updated <ago> ago · ran <dur>` (`dur(ms)`: `<1m`, `Nm`, `Nh Nm`, `Nd Nh`), blank, `Brief:` + brief cut at 800 chars with `…`, blank, then `Progress:` (running, from `progress`), `Result:` (done), `Question:` (needs_input), `Reason:` (failed), omitted when empty. `Full brief` when cut; Back returns to the same list page.

- [ ] **Step 1: Failing tests** (seed `JobsDoc` directly via `daemon.root.commit` for deterministic times): order active-then-finished-newest; icons and counts; paging; long title cut; detail fields per status; brief cut + `Full brief`; `Clear finished` removes finished and keeps a running job; Back from detail returns to page 2 when opened from page 2.
- [ ] **Step 2–4:** FAIL, implement, run file + full suite + `npx tsc --noEmit` PASS.
- [ ] **Step 5: Commit** `feat(messaging): /jobs — details, paging, clear finished; README`
