# japa Milestone 6: Packaged Defaults (Implementation Plan)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Out of the box, japa can:
- schedule things, through durable cron and one-shot timers;
- read the web, through `web_fetch` and `web_search` with a swappable search engine;
- ship the default content: the `coder` and `researcher` worker profiles, the agent-facing authoring and briefing skills, and the `research` task skill.

**Architecture:** Two packaged extensions (`extensions/schedule`, `extensions/web`) built only on `japa/sdk`, plus content files (`workers/*.md`, `skills/*/SKILL.md`). The only kernel changes are:
- a generic `undo.call` in the change log;
- profile `thinking` validation, carried from M2.

**Spec:** `docs/superpowers/specs/2026-10-07-japa-design.md` §4.3, §4.4, §9.2, §9.3, §11.1, §11.2.

## Global Constraints

- All constraints from M1–M5 still apply. **Prime directive from the user:** don't overcomplicate. Write minimal code and no code for its own sake.
- Packaged extensions import only from `../../src/sdk.ts` (as `extensions/providers` does) and Node built-ins. If something they need is missing, add the export to `src/sdk.ts`.
- No new dependencies. No network in tests:
  - `web_fetch` tests use a local `node:http` server on 127.0.0.1.
  - Search-engine tests use a fake engine, or `vi.stubGlobal("fetch", ...)`.
  - Models are faux.
- Content files are concise, agent-facing and accurate against the real tool names, arguments and messages. Each skill is ≤ 400 words unless noted.

## Rulings (binding)

- **Schedules are durable tasks, not a trigger contribution.**
  - `schedule` provides tools plus `durable.tasks` (the escape hatch, §4.4). Each schedule is one background task owned by the root conversation (`conversationId: ROOT_CONVERSATION_ID`).
  - The task sleeps (`runtime.sleep`) until the next occurrence, then posts to the root with requestId `trigger:schedule:<id>:<at>`. This is the `emit` convention, so a re-run after a crash is deduplicated.
  - A removed schedule's task exits without firing when it next wakes, because tools can't abort tasks.
  - *If wrong:* a removed schedule's task lingers asleep until its next time. This is harmless.
- **The cron format is 5 standard fields in local time:** `*`, numbers, `a-b`, `a,b`, `*/n`, `a-b/n`. Day-of-week is 0–6 with Sunday = 0. Day-of-month and day-of-week combine with AND.
  - The next occurrence is found by stepping minute by minute for up to 366 days, after which the schedule is reported as invalid.
  - A one-shot schedule uses `at`, an ISO-8601 timestamp.
  - *If wrong:* a few cron expressions that rely on the OR rule fire less often than in Vixie cron.
- **Missed occurrences while the daemon is down fire once at boot,** and the schedule then continues from now. There is no catch-up storm.
- **Active schedules reach the CoS through a schedule `section`** (escape hatch), not through the kernel's capabilities text. Both are in the system prompt.
- **Undo of a schedule.** `Change.undo` gains an optional `call: { tool: string; args: JsonObject }`.
  - `change_undo` on an entry that has `call` (and no commits or configOps) does not act. It replies `To undo this, call <tool> with <json args>.` and keeps the entry.
  - `schedule_remove` logs its own change.
  - *If wrong:* "undo that" for a schedule takes the CoS two tool calls instead of one.
- **The default search engine is Brave Search.**
  - Request: `GET https://api.search.brave.com/res/v1/web/search?q=…&count=…`, header `X-Subscription-Token`.
  - Secret name: `web.brave.apiKey`.
  - If the key is missing, `web_search` replies: `web_search needs a Brave Search API key. Ask the user for it with secret_request({ name: "web.brave.apiKey", why: "..." }), then try again.`
  - *If wrong:* the user needs a Brave key, or an extension providing another engine.
- **`web_fetch` keeps HTML-to-text minimal.** It drops `script`, `style` and `noscript` elements, strips tags, decodes `&amp; &lt; &gt; &quot; &#39; &nbsp;` and numeric entities, and collapses whitespace.
  - Other text types pass through unchanged, and binary types are refused.
  - The output is truncated with pi-durable's `truncateHead`.

## Review Focus

1. **A schedule fires exactly once per occurrence**, including across a restart. A removed schedule never fires again. Tests in Task 1.
2. **Cron next-occurrence is correct** for the supported syntax, including month and day boundaries. Tests in Task 1.
3. **The search engine is swappable through the `search-engine` contract.** A missing key leads the CoS to `secret_request`. Tests in Task 2.
4. **Content is accurate:** every tool, argument, path, command and message the skills and profiles mention exists exactly as written. This is reviewed by reading against the code.

---

## File Structure

```
extensions/schedule/index.ts     manifest, ScheduleDoc, tools, section, task
extensions/schedule/cron.ts      parseCron, nextAfter
extensions/web/index.ts          manifest, search-engine contract, web_fetch, web_search
extensions/web/html.ts           htmlToText
extensions/web/brave.ts          default search engine
workers/coder.md, workers/researcher.md
skills/<name>/SKILL.md           7 skills
src/kernel/changes.ts, settings-tools.ts   undo.call
src/kernel/workers.ts            thinking validation
```

---

### Task 1: The `schedule` extension

**Files:**
- Create: `extensions/schedule/index.ts`, `extensions/schedule/cron.ts`
- Modify: `src/kernel/changes.ts`, `src/kernel/settings-tools.ts` (`undo.call`), `src/sdk.ts` (exports, if needed)
- Test: `test/cron.test.ts`, `test/schedule.test.ts`

**Interfaces:**
- **`cron.ts`:**
  - `nextAfter(expr: string, after: number): number`.
  - Returns the first minute strictly after `after` that matches, in local time.
  - Throws `Error("invalid cron: <reason>")` on bad syntax, or when nothing matches within 366 days.
- **`ScheduleDoc`:**
  - Kind `japa.schedules`, on the root conversation (latest history, fork `initial`).
  - Shape: `{ nextId: number; schedules: Record<string, Schedule> }`, where `Schedule = { id; text; cron?: string; at?: number; next: number; taskId: string }`.
- **Tools:**
  - **`schedule_add({ text, cron?, at? })`:**
    1. Exactly one of `cron` and `at` must be given. `at` is an ISO string and must be in the future.
    2. Compute `next`.
    3. In one commit:
       - add the schedule;
       - `tx.createTask(ScheduleTask, { id }, { ownership: { kind: "conversation" }, conversationId: ROOT_CONVERSATION_ID, background: true })`;
       - `logChange` with title `Scheduled "<text>" (<cron or local time>)`, howToUse `It will arrive as a message at that time.`, and undo `{ commits: [], call: { tool: "schedule_remove", args: { id } } }`.
    4. Reply `Scheduled <id>: next at <local time>. (change <cid>)`.
    5. Invalid input replies `Not scheduled: <reason>`.
  - **`schedule_list()`:** one line per schedule, `<id>  <cron | once>  next <local time>  <text>`, or `No schedules.`
  - **`schedule_remove({ id })`:** deletes the schedule from the doc and logs `Removed schedule "<text>"`. Its undo is `call: schedule_add` with the original args. It replies `Removed schedule <id>.`, or `No schedule <id>.`
- **Section:** `Active schedules:` followed by the `schedule_list` lines. It is omitted when there are none.
- **`ScheduleTask` (`japa.schedule`) phases:**
  - **`wait`:**
    1. Read `next` from the doc; if the schedule is gone, go terminal.
    2. `await runtime.sleep(next)`.
    3. Commit: if the schedule is gone, terminal. Otherwise compute the following occurrence, `nextAfter(cron, max(now, next))`, write it to the doc, and move to `{ phase: "fire", at: next }`. For a one-shot schedule, delete it from the doc and move to `{ phase: "fire", at: next, last: true }`.
  - **`fire`:**
    1. Submit `[schedule <id>] <text>` to the root with `whenBusy: "followUp"` and requestId `trigger:schedule:<id>:<at>`. Don't wait for the answer.
    2. Commit back to `wait`, or to terminal if `last`.
- **`change_undo` with `undo.call`:** see Rulings.

- [ ] **Step 1: Write failing tests:**
  - **`nextAfter`:**
    - `*/15 * * * *` gives the next quarter hour.
    - `0 9 * * 1-5` from Friday 10:00 gives Monday 09:00.
    - `0 0 1 * *` crosses month and year boundaries.
    - `30 8 29 2 *` gives the next leap day.
    - Invalid inputs throw: `61 * * * *`, `* * *`, and `0 0 30 2 *` (never matches).
  - **Schedule** (through a booted daemon with the faux CoS calling the tools). Use a tiny cron/at, or advance time with a short `at` such as now + 1.5 s. Pick whichever pi-durable clock control is available; a harness `clock` option or `vi.useFakeTimers`. Prefer real short waits if simple:
    1. A one-shot `at` fires once and delivers `[schedule 1] …` to the root, then the schedule is gone.
    2. A removed schedule doesn't fire.
    3. **Restart:** add a schedule, close the daemon before it is due, then boot the same home after it was due. It fires exactly once.
    4. `change_undo` on the add replies with the `schedule_remove` instruction.
    5. The section lists active schedules.
- [ ] **Step 2–4:** RED, implement, GREEN.
- [ ] **Step 5: Commit** `feat(schedule): durable schedules`

---

### Task 2: The `web` extension

**Files:**
- Create: `extensions/web/index.ts`, `extensions/web/html.ts`, `extensions/web/brave.ts`
- Test: `test/web.test.ts`

**Interfaces:**
- **Contract `search-engine`** (defined by `web`, phase `runtime`, cardinality `many`):
  - Docs: "A web search backend for web_search, chosen by settings `extensions.web.engine`."
  - Contribution: `{ name: string; search(query: string, count: number, secret: (name: string) => Promise<string | undefined>): Promise<{ title: string; url: string; snippet: string }[]> }`.
  - `activate` registers the contribution in a module-level `Map` (the web extension's own) with the contributing extension's `ctx.secret` bound, and its dispose removes it.
- **Settings:** `extensions.web: { engine: "brave" }`. Use the existing extension `settings` schema mechanism.
- **`web_fetch({ url })`:**
  - Plain `fetch` with a 30 s timeout.
  - On a non-2xx status, reply `HTTP <status> for <url>`.
  - For `text/html`, return `htmlToText`. For other `text/*`, JSON or XML, return the text. Otherwise reply `Not a text page (<content-type>).`
  - Truncate with `truncateHead`, which needs a re-export from sdk.
- **`web_search({ query, count? = 5 })`:**
  - Uses the engine named by the live setting.
  - An unknown engine replies `No search engine "<name>". Engines: <names>.`
  - Results are formatted as `<n>. <title>\n<url>\n<snippet>` and separated by blank lines.
  - Engine errors reply `Search failed: <message>`.
- **`brave.ts`:**
  - The manifest's `secrets` includes `web.brave.apiKey`.
  - If the key is missing, throw a typed `MissingKey`. `web_search` maps it to the Ruling's exact reply.
- **The manifest** gets a summary, examples and docs describing both tools.

- [ ] **Step 1: Write failing tests:**
  - **`htmlToText`:** strips `script`/`style`, decodes entities, collapses whitespace.
  - **`web_fetch`:**
    - Against a local server: an HTML page gives text.
    - A 404 gives `HTTP 404 for …`.
    - `image/png` is refused.
  - **`web_search`:**
    - With a fake engine extension (`provides: { "search-engine": [...] }`) selected through settings, formatted results come back.
    - An unknown engine name gives its error.
  - **Brave:**
    - With no key, the reply is the `secret_request` instruction.
    - With a key in the test secrets store and `fetch` stubbed, the request carries the `X-Subscription-Token` header, and the results parse from `{ web: { results: [{ title, url, description }] } }`.
- [ ] **Step 2–4:** RED, implement, GREEN.
- [ ] **Step 5: Commit** `feat(web): web_fetch and web_search`

---

### Task 3: Default worker profiles

**Files:**
- Create: `workers/coder.md`, `workers/researcher.md`
- Modify: `src/kernel/workers.ts` (thinking validation), `test/workers.test.ts`, and any test that pins the worker list

**Interfaces:**
- **`coder`:**
  - Tools `[read, write, edit, bash]`, environment `local`, no extensions.
  - Description: "Writes and changes code and files on this computer, and runs commands."
  - Body (~120 words): work in the brief's directory (ask with `job_message` if it isn't given); make small verified changes; run the tests; finish with `job_complete` and a summary of what changed, with paths.
- **`researcher`:**
  - Tools `[read, write]`, extensions `[web]`, skills `[research]`.
  - Description: "Researches a question on the web and writes a sourced report."
  - Body (~120 words): follow the `research` skill; cite URLs; write long reports to a file and give its path in the summary; finish with `job_complete`.
- **Thinking validation:** a profile `thinking` must be one of pi-ai's thinking levels (import the list or type from pi-ai; don't hardcode it if it's exported). Otherwise the profile error is `thinking must be one of <levels>`.

- [ ] **Step 1: Write failing tests:**
  - Both new profiles load and pass `profileError` at boot.
  - `thinking: huge` gives the error.
- [ ] **Step 2–4:** RED, implement, GREEN.
- [ ] **Step 5: Commit** `feat(content): coder and researcher workers`

---

### Task 4: Default skills

**Files:**
- Create: `skills/{choosing-a-mechanism,building-skills,building-workers,building-extensions,writing-job-briefs,reporting-changes,research}/SKILL.md`, and delete `skills/.gitkeep`
- Modify: `src/kernel/identity.md`, only if needed to point at these skills
- Test: `test/content.test.ts`

**Content** (frontmatter `name` and `description`; the description says when to load the skill):

- **choosing-a-mechanism:**
  - The ladder from identity, with 6 worked examples: a weekly summary becomes a schedule; changing the model is a setting; a recurring writing procedure becomes a skill; a specialised background role becomes a worker; a new API becomes an extension tool; a new chat channel becomes a surface extension.
- **building-skills:**
  - The SKILL.md format: frontmatter `name` equals the directory name, `description` says when to use it.
  - Progressive disclosure: extra files sit next to SKILL.md, are referenced by relative path and are read with `read`.
  - Scripts.
  - `japa check skill <name>`.
- **building-workers:**
  - The profile fields as `readProfile` accepts them: `name`, `description`, `model`, `thinking`, `environment`, `tools`, `extensions`, `skills`, `cwd`. State the defaults and the `~`/`$JAPA_HOME` expansion.
  - How to choose the tools.
  - `japa check worker <name>`.
- **building-extensions** (≤ 900 words):
  - The `defineJapaExtension` manifest fields, with the exact names from `src/kernel/extension.ts`.
  - Each core contract's shape (from `src/kernel/contracts.ts`), plus `KernelContext.settings()` and `secret()` (manifest `secrets`).
  - Defining a new contract.
  - The `durable` escape hatch (sections, hooks, wraps, tasks), with `extensions/schedule` as the example.
  - Testing with the faux provider.
  - `japa check extension <name>` and what it checks.
  - Imports only `japa/sdk` and Node built-ins.
  - A complete minimal one-tool example.
- **writing-job-briefs:**
  - A good brief contains the goal, context, constraints and what "done" looks like.
  - Choose the worker from the capabilities list.
  - Parallel jobs for independent work.
  - Follow-ups with `job_message`; stopping with `job_stop`.
  - Use the exact job tool names from `src/kernel/jobs/cos.ts`.
- **reporting-changes:**
  - The done / how-to-use / how-to-undo format.
  - It matches `japa.changes`: the `changes_list` and `change_undo` tools.
- **research:**
  - Plan sub-questions, then search and fetch primary sources, cross-check, and write a structured report.
  - The report has a summary first, then findings with inline `[n]` citations and a numbered source list of URLs.
  - Say what is uncertain.

**Test (`test/content.test.ts`):**
- Every packaged skill passes `check("skill", name, packageRoot, home)`.
- Every packaged worker passes `check("worker", …)`.
- Every backticked token in the skills that looks like a tool name (`/\`([a-z]+_[a-z_]+)\`/`) is a real tool name in a booted daemon's root or worker tool set, or one of the `job_*` worker tools. This test enforces Review Focus #4.

- [ ] **Step 1: Write the content test** (RED: the skills don't exist yet).
- [ ] **Step 2: Write the skills** by reading the referenced source files for exact names. GREEN.
- [ ] **Step 3: Commit** `feat(content): default skills`
