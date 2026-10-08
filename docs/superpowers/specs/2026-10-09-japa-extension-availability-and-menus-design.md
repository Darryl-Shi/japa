# japa — extension availability, and the /settings and /jobs menus

Date: 2026-10-09
Status: Draft for review
Amends: `2026-10-07-japa-design.md` (the "main spec") and
`2026-10-08-japa-messaging-telegram-design.md` (the "messaging spec", §5.4, §5.6)

## 1. Purpose

Two problems, two parts.

**A. Unconfigured extensions are exposed.** Every loaded extension's tools and
durable contributions go into the CoS's selection (`runtime.ts`
`reloadContent`), every worker's (`jobs/cos.ts` `agentOf`, when a profile names
no extensions), and the capabilities text — whether or not its secrets are set.
`brave_search` and `parallel_search` only find out at call time, then ask the
CoS to `secret_request` the key. The CoS sees tools it cannot use, may pick
them over working ones, and nags the user for keys they chose not to give.
`isConfigured` (`src/cli/configure.ts`) exists but only `japa setup` uses it.

**B. The messaging menus are thin.** `/settings` offers three lists with no
current values, no Back/Home, and dead-ends every action in bare text; it
cannot touch extension secrets or settings, the general numeric settings,
schedule details or the change log. `/jobs` is one unpaged list of buttons
whose detail is a single `[job N "title" status] result` line; finished jobs
show for 24 h, `needs_input` ones forever, and `JobsDoc` keeps every job
forever.

## 2. Part A — extension availability

### 2.1 Rule

An extension is **configured** when every secret `japa setup` asks for
(`askedSecretNames`: declared, not `generated`) is stored, and every required
setting (`askedProperties`: a property of its settings schema without a
default that is not optional) is saved in `settings.extensions.<name>`.

An extension is **available** when it is configured and
`settings.extensions.<name>.enabled` is not `false`.

`enabled` is an optional boolean the kernel adds to every extension's settings
schema in `settingsSchema` (`settings-tools.ts`), as it already adds `owner`
for messaging extensions; an extension without its own schema gets
`Type.Object({ enabled })`, so the key is validated for every extension.

### 2.2 What availability gates

Only what agents see:

- The extension's built Pi Durable extension (its tools, sections, hooks,
  wraps) is left out of the root selection and out of every job's agent
  (`agentOf`), whether the profile names it or not. A profile naming an
  unavailable extension stays valid (`profileError` still checks against all
  built extensions) and runs without it.
- The capabilities text lists available extensions only. An unavailable one is
  not mentioned at all, so the CoS never offers to set it up; that happens
  through `japa setup` or `/settings` (§3.4).

Everything else is unchanged: every loaded extension still runs `setup()`, is
installed in the registry, and activates its adapter contributions
(provider, storage, secrets, environment, surface, messaging, trigger).
Telegram still waits dormant for its token.

`Status.extensions[]` gains `state: "on" | "off" | "not set up"`. `japa status`
and `/status` show it after the summary for anything not `on`.

### 2.3 Where it lives

- New `src/kernel/availability.ts`: `askedProperties` and `isConfigured` move
  here from `src/cli/configure.ts` (which imports them back), taking
  `{ get(name): Promise<string | undefined> }` for secrets and the user
  settings object; plus `extensionState(e, secrets, settings)`.
- `runtime.ts` keeps `available: Set<string>` and a `refreshAvailability()`
  that recomputes it, and only when it changed: rebuilds the root selection
  (`selection.splice`, as `reloadContent` does), refreshes capabilities, and
  commits `reconfigureJobs` so unfinished jobs pick it up. `reloadContent` and
  `agentOf` filter `built` by `available`.
- `JobsOptions` gains `available: () => ReadonlySet<string>`.

### 2.4 When it is recomputed

At boot after the tool phase; after `reconcile`; after `setSetting` and
`change_undo` (through `SettingsDeps.changed`, which becomes async); after any
secret is stored — `KernelContext.setSecret`, `surface.secrets.fulfil`, and
the menu's secret entry (§3.4). A `japa setup` run against a live daemon takes
effect on the daemon's next restart, as today.

## 3. Part B — /settings

### 3.1 Navigation (`src/kernel/messaging/menu/nav.ts`)

`menu.ts` becomes `messaging/menu/` — `index.ts` (createMenu, commands,
press, input), `nav.ts`, `settings.ts`, `extensions.ts`, `jobs.ts`.

- A **screen** is `{ title, body?, buttons }`. Every screen but a home has a
  footer row `‹ Back` · `⌂ Home` (Home = the command's first screen).
- **Paged lists**: 8 items a page, nav row `‹` · `p/n` (no-op) · `›`.
- **Outcomes**: an action re-renders the screen it came from, with a first line
  `✓ <reply>` or `✗ <reason>` (`Not changed: …` becomes `✗ …`). No action ends
  in bare text.
- **Typed input**: a screen can ask for a value — "Send the new value as your
  next message." with a `Cancel` button. The owner's next text goes to the
  menu, not the CoS; for a secret it is deleted at once (as secret requests
  are, including the "couldn't delete" notice and the re-delivery drop via
  `fulfilledBy`). A command, `Cancel`, or any other button press cancels it.
  While a menu input is pending it takes precedence over a pending secret
  request; the request is re-announced when the input ends.
- **Expiry**: the action→screen map keeps the newest 500 actions; an older
  or pre-restart button answers "This menu expired — send /settings again."
  (or `/jobs`).
- Every message is fitted to `maxMessageChars` as today.

### 3.2 Home

`Settings` with buttons: Models · Extensions · Schedules · General ·
Recent changes.

### 3.3 Models

- Body: `CoS: <provider>/<model>`, `Worker: …`, `Consolidation: …` (unset
  roles read "same as CoS").
- Role → providers with credentials (`models.checkAuth`) and at least one
  model → paged models, the current one prefixed `✓ `.
- Worker and Consolidation have a `Use CoS model` button (sets the path to
  `undefined`).
- Setting goes through `messaging.setSetting(models.<role>, …)`; the outcome
  shows on the Models screen.

### 3.4 Extensions

- List: every loaded extension and every workspace one (as today), labelled
  `✅ on`, `⚪ not set up`, `⏸ off`, `⚠️ error`, paged.
- Detail body: summary; its status line, if any; its load/activation error, if
  any; `Secrets:` each asked secret as `set` / `not set` (never the value);
  `Settings:` each property of its schema with its current value or
  `default (<default>)` / `not set`.
- Buttons:
  - `Set <secret name>` per asked secret → typed secret input → stored via a
    new `MessagingContext.setSecret(extension, name, value)` (checks the name
    is declared, stores it, runs `refreshAvailability`).
  - One per setting: booleans toggle on press; enums (`Type.Union` of
    literals / `StringEnum`) open a choice list with the current one ticked;
    anything else asks for typed input, parsed as JSON if it parses, else used
    as a string. All through `setSetting(extensions.<name>.<prop>, …)`.
  - `Turn off` / `Turn on` (sets `extensions.<name>.enabled` to `false` /
    `undefined`), shown for configured extensions.
  - `Roll back to last known good` (confirm), workspace extensions only.
- `MessagingContext.extensions()` returns, per extension: name, summary,
  state, error, status line, workspace flag, asked secrets with
  `{ name, description, set }`, its settings schema (as `settingsSchema`) and
  current values.

### 3.5 Schedules

- List: `⏸ ` for paused, then the label, paged.
- Detail body: text; `Repeats: <cron>` or `Once: <local time>`;
  `Next: <local time>` or `Paused`.
- Buttons: `Pause` / `Resume`, `Remove` (confirm).
- The schedule extension gains:
  - `Schedule.paused?: boolean` and `Schedule.gen: number` (missing = 0).
    `ScheduleTask` input becomes `{ id, gen? }`; a task exits when its schedule
    is gone, paused, or has another `gen` (its input `gen` missing = 0).
  - `schedule_pause({ id })`: sets `paused`; logged, undo calls
    `schedule_resume`.
  - `schedule_resume({ id })`: clears `paused`, increments `gen`, sets `next`
    (cron: the next occurrence after now; once: unchanged, so a missed one
    fires at once), and starts a new task; logged, undo calls
    `schedule_pause`.
  - `schedule_list` details become
    `{ id, text, cron?, at?, next, paused, label }`; its text marks paused
    ones.

### 3.6 General

Each shown as `<label>: <value>`, a button each, typed input, through
`setSetting` (so validated and logged):

| Label | Path |
|-------|------|
| Max concurrent jobs | `jobs.maxConcurrent` |
| Keep finished jobs (days) | `jobs.keepFinishedDays` (new, §4.3) |
| Memory: max facts | `memory.maxFacts` |
| Memory: max tokens | `memory.maxTokens` |
| Tool errors before rollback | `safety.toolErrorThreshold` |
| Minutes until marked good | `safety.goodAfterMinutes` |
| Tool result tokens | `context.toolResultTokens` |

### 3.7 Recent changes

The 10 newest changes (`ChangesDoc`), `<id> <title> · <age>`, each a button →
detail (title, time, how to use) with `Undo` (confirm) running `change_undo`
through `messaging.tool`. A change whose undo is a tool call (schedules) is
undone by running that tool through `messaging.tool`.

## 4. Part B — /jobs

### 4.1 List

- Body: counts, e.g. `2 running · 1 needs input · 5 finished`.
- Buttons, paged: active jobs (queued, running, needs_input) by id, then
  finished ones newest `updatedAt` first, each
  `<icon> #<id> <title> · <age>` (age since `updatedAt`, e.g. `4m`, `3h`,
  `2d`); icons `⏳` queued, `🔄` running, `❓` needs_input, `✅` done, `❌`
  failed, `⛔` cancelled. Titles cut to fit 64 characters of label.
- `Clear finished` (confirm) when any job is finished; afterwards the list
  re-renders with `✓ Cleared N finished jobs`.
- No jobs: "No jobs."

### 4.2 Detail

```
#12 Research flights
🔄 running · worker researcher
Started 2h ago · updated 5m ago · ran 1h 55m

Brief:
<brief, cut at ~800 chars with "…">

Progress:            (running)  /  Result: (done)  /  Question: (needs_input)  /  Reason: (failed)
<text>
```

`ran` is `updatedAt - createdAt` for finished jobs and `now - createdAt` for
active ones. Buttons: `Full brief` (when cut; shows the whole brief, fitted to
one message, with Back), `‹ Back` to the same list page.

### 4.3 Clearing

- `jobs.keepFinishedDays` (integer ≥ 1, default 7) joins `Settings.jobs`.
- New `prune(jobs, before)` in `jobs/state.ts` deletes done, failed and
  cancelled jobs whose `updatedAt < before`; never queued, running or
  needs_input ones.
- The kernel prunes at boot and hourly (an unref'd interval cleared on
  `close`) with `before = now - keepFinishedDays`.
- `Clear finished` prunes with `before = Infinity`, through a new
  `MessagingContext.clearFinishedJobs(): Promise<number>`.
- Pruning removes only the `JobsDoc` entry; the job's conversation stays in
  storage. `job_message` / `job_transcript` on a pruned id answer
  `No job <id>.` as for any unknown id.
- `job_list` lists what remains. The CoS's jobs board keeps its 24 h window.
- `recent()` is no longer used by `/jobs`.

## 5. Errors

- Availability: a secrets read that throws counts as not set; the error is
  logged once per refresh.
- Menu: any thrown error in a press or input renders as `✗ <message>` on the
  originating screen; nothing is half-applied beyond what `setSetting` and the
  tools already guarantee.

## 6. Testing

- **Availability** (`test/availability.test.ts`, `test/boot.test.ts`): an
  extension with an unset asked secret is absent from the root selection, from
  a job's agent (named by its profile or not) and from capabilities, and
  `status()` reports `not set up`; storing the secret (each of `setSecret`,
  `fulfil`, the menu path) makes it available live; `enabled: false` hides a
  configured one and `status()` reports `off`; a generated-only secret
  extension (desktop) is available; adapters of unavailable extensions still
  activate.
- **Navigation** (`test/messaging-menu.test.ts`): Back/Home on every screen;
  outcome lines; paging; typed input reaches the menu, not the CoS; secret
  input is deleted; commands, Cancel and other presses cancel input; expiry.
- **Settings screens**: current models shown and ticked; providers without
  credentials hidden; `Use CoS model`; extension detail lists secret set/not
  set without values; boolean toggle, enum choice and typed setting each go
  through `setSetting` and are logged; Turn off/on; rollback confirm;
  general settings validated (`✗` on bad input); change undo.
- **Schedules** (`test/schedule.test.ts`): pause stops firing; resume of a
  cron schedule fires at the next occurrence and never twice (old task exits
  by `gen`); resume of a missed one-off fires once; pause/resume logged and
  undoable; existing tasks without `gen` keep working.
- **Jobs** (`test/jobs-state.test.ts`, `test/messaging-menu.test.ts`): list
  order, counts, paging, icons, ages; detail fields per status; brief cut and
  `Full brief`; `Clear finished` removes only finished jobs; `prune` respects
  the age and never touches active ones; `keepFinishedDays` validated; hourly
  prune timer cleared on close.
