# Conversation window, recall, profile and scratchpad Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every CoS turn sees the current conversation plus what search finds. Memory is split into a profile about
the user and a capped project scratchpad.

**Architecture:**
- **Reset.** The per-run reset stays but carries nothing.
- **Mirror and context.** An in-process mirror of the root transcript, `History`, feeds pure renderers for the window
  and for recall. A `beforeRequest` hook in `cos.ts` builds one injected message per run, memoized with `api.memo`.
- **Profile and scratchpad.** The profile is `MemoryDoc` v3 (facts guarded by a scope filter). The scratchpad is a
  new `ScratchpadDoc`.
- **Reflection.** Writes profile ops, each backed by a verbatim quote from the user, and page rewrites.
- **Migration.** A one-time `Sort` task moves the v2 facts and episodes into the new shape.

**Tech Stack:** TypeScript on Node 24 (type stripping), pi-durable, pi-ai (faux provider in tests), vitest.

**Spec:** `docs/superpowers/specs/2026-10-11-japa-conversation-memory-design.md`

## Global Constraints

- **Token estimate:** 4 characters per token everywhere (`estimateTokens` in `state.ts`).
- **No model call on the turn path.** Only reflection and Sort call a model.
- **Automated input:** text matching `AUTOMATED = /^\[(job |schedule |secret |japa\]|[a-z][\w-]*[\]:])/`.
- **Window:**
  - A pause longer than 30 minutes (`PAUSE_MS = 1_800_000`) ends a conversation.
  - Budget is 8,000 tokens (`WINDOW_TOKENS`). The newest exchange gets up to 2,000 tokens (`NEWEST_TOKENS`).
  - Headlines and shortened messages are at most 200 characters, and `did:` lines at most 160.
- **Recall:**
  - At most 5 hits within 1,500 tokens (`RECALL_HITS`, `RECALL_TOKENS`).
  - Message snippets are up to 400 characters, page snippets up to 600.
  - `history_search` returns 10 hits. `history_read` defaults to 4 messages before and 4 after, capped at 4,000
    tokens.
- **Ranking:** BM25 with `k1 = 1.2` and `b = 0.75`, multiplied by `0.5 ** (ageDays / 14)`. Page hits get `× 1.5`.
- **Profile:**
  - At most 30 words per item.
  - Default `settings.memory = { maxFacts: 30, maxTokens: 1000 }`.
  - Evidence quotes are at least 3 words.
- **Scratchpad:**
  - Each page is at most 1,500 tokens (`PAGE_TOKENS`), with at most 15 active pages (`ACTIVE_PAGES`).
  - A page is archived after 14 days untouched and deleted 90 days after it was archived. Legacy episodes are
    deleted 90 days after Sort.
- **Exact copy:**
  - Window header `[Conversation so far]`.
  - Recall header `[From earlier: found by search; may be incomplete]`.
  - Page refusal `Page too long (N tokens; max 1,500): condense it to the current state and write it again.`
  - Profile refusal `Too long — keep it to 30 words.`
  - Filter refusal `Not about the user (<reason>): put it on a scratchpad page instead.`
  - The §3.5 rule in `identity.md`, verbatim.

## Review Focus

- **The newest exchange is a steer chain or has no reply.** The window still shows every input, and shows no
  `japa:` line when there was no reply. Tested in Task 3.
- **An image-only input.** It renders as `you:` (not automated) with its `[image saved to …]` note. Tested in Tasks 1
  and 3.
- **A job report for a job with no `origin`.** This covers jobs created before this change. Recall must skip the
  origin hit without throwing. Tested in Task 5.
- **A brand-new install, with no reset yet.** The first run has an empty window and possibly empty recall, so
  nothing is injected. Tested in Task 6.
- **The CoS edits a page while reflection is running.** The reflection's write is skipped through `basedOn`.
  Tested in Task 8.

---

### Task 1: Transcript messages

Turn root entries into the messages a person saw.

**Files:**
- Create: `src/kernel/memory/transcript.ts`
- Create: `test/history-helpers.ts`
- Test: `test/transcript-messages.test.ts`

**Interfaces:**
- Produces:

```ts
export const AUTOMATED: RegExp;
export type HistoryMessage = {
  id: EntryId;                 // first entry of the message
  kind: "you" | "japa" | "auto";
  text: string;
  at: number;                  // ms
  did?: string;                // japa only: "did: …", ≤ 160 chars, absent when nothing qualifies
  job?: string;                // auto only: job id from a leading `[job <n> `
};
export function transcriptMessages(entries: readonly EntryRecord[]): HistoryMessage[]; // oldest first in and out
```

- `test/history-helpers.ts` exports `you(id, text, at)`, `auto(id, text, at)`, `reply(id, text, at, calls?)`,
  `toolResult(id, name, text)` and `reset(id)`. Each builds an `EntryRecord` (the `entry()` pattern from
  `test/reset.test.ts`). `calls` is `{ name, args, result? }[]`: the tool calls on the assistant message, plus their
  result entries.

**Rules:**
- A `pi.user` entry becomes a `you` message, or an `auto` message if `AUTOMATED` matches its text. Text is the text
  parts joined; other parts become `[<type>]` (as `render` in `reset.ts` does today).
- Each maximal run of `pi.assistant`/`pi.tool-result` entries between user entries becomes one `japa` message. Its
  text is every assistant text part, joined with `\n`. A run with no assistant text produces no message (its `did`
  is dropped with it).
- `pi.reset`, `pi.compaction` and system messages are skipped.
- `at` is the message `timestamp`, or the previous message's `at` (0 for the first).
- `did` lists tool calls except read-only ones, matched by
  `/^(read|.*_list|.*_get|job_transcript|history_.*|page_read|memory_facts|skill_read)$/`. Each is rendered as
  `name`, plus ` <x>`, where x is the first of `args.id`, `args.title`, `args.name`, `args.path`, then
  ` (<thing> <n>)` when its result's text matches `/\b(job|schedule|change) (\d+)/i`. Calls are joined with `, `,
  prefixed `did: `, and cut to 160 characters.

- [ ] **Step 1: Write the failing tests**
  - `user, reply and tool traffic become one you and one japa message`: the text is the assistant texts only, and
    `did` is `did: job_start Cleanup (job 68)` for a `job_start {title:"Cleanup"}` whose result is
    `Started job 68.`
  - `read-only calls are left out of did`: `read` and `job_list` give `did` undefined.
  - `automated inputs are auto with their job`: `[job 68 "Cleanup" done] …` gives `{kind:"auto", job:"68"}`;
    `[whatsapp] unlinked` and `[google: couldn't connect: …]` give `auto` without a job.
  - `an image-only input is you, not auto`: content `[{type:"text",text:"\n[image saved to /x.png]"},{type:"image"}]`
    gives `kind:"you"` and text containing `[image saved to /x.png]` and `[image]`.
  - `resets and compactions are skipped, and missing timestamps inherit`.
- [ ] **Step 2:** Run `npx vitest --run test/transcript-messages.test.ts`. Expected: FAIL (module missing).
- [ ] **Step 3:** Implement `transcript.ts` per the rules above.
- [ ] **Step 4:** Run the same command. Expected: PASS.
- [ ] **Step 5:** Commit: `feat(memory): transcript messages`.

### Task 2: Keyword search

**Files:**
- Create: `src/kernel/memory/search.ts`
- Modify: `src/kernel/memory/state.ts`: export `words`
- Test: `test/search.test.ts`

**Interfaces:**
- Consumes: `words(text): string[]` from `state.ts`.
- Produces:

```ts
export type Doc = {
  key: string;                                   // unique: entry id, "job:<id>", "page:<id>", "episode:<id>"
  kind: "you" | "japa" | "auto" | "job" | "page" | "episode";
  text: string;
  at: number;
  id?: EntryId;                                  // transcript docs
  title?: string;                                // pages and jobs
};
export function rank(docs: readonly Doc[], query: string, now: number, limit: number): Doc[]; // score > 0 only
export function snippet(text: string, query: string, max: number): string;  // ≤ max chars around the first matched word; "…" marks cuts
```

- [ ] **Step 1: Write the failing tests**
  - `a rare term outranks a common one`.
  - `recency halves the score every 14 days`: two equal docs 14 days apart; the newer one ranks first.
  - `pages get a 1.5x bonus`: a page and a `you` doc with the same text and age; the page ranks first.
  - `no match returns nothing`, and `limit is honoured`.
  - `snippet centres on the match and is at most max characters`.
- [ ] **Step 2:** Run `npx vitest --run test/search.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement Okapi BM25 over `words(text)`. Average document length and IDF come from `docs` at call
  time, with IDF = `ln(1 + (N − n + 0.5)/(n + 0.5))`. Multiply by recency and the page bonus (Global Constraints).
- [ ] **Step 4:** Run. Expected: PASS.
- [ ] **Step 5:** Commit: `feat(memory): keyword search`.

### Task 3: The window

**Files:**
- Create: `src/kernel/memory/window.ts`
- Test: `test/window.test.ts`

**Interfaces:**
- Consumes: `HistoryMessage` (Task 1).
- Produces:

```ts
export function ago(at: number, now: number): string;
// "just now" (<1 min), "N min ago" (<60 min), "N h ago" (<24 h), "N d ago" (<7 d), else "YYYY-MM-DD"
export function conversation(before: readonly HistoryMessage[]): HistoryMessage[];
// the current conversation; when it's empty, the previous conversation's last exchange
export function renderWindow(before: readonly HistoryMessage[], now: number): string | undefined;
// `before`: every message before the run, oldest first
```

**Rules:**
- **Boundary.** Measured against the run's start (`now`): if `now − last.at > PAUSE_MS`, the current conversation
  is empty and `conversation` returns the last exchange (the last `you`/`auto` messages plus the `japa` reply after
  them). Otherwise it walks back until a gap between consecutive messages exceeds `PAUSE_MS`.
- **Line format:**
  - `you · <ago> · #<id>: <text>`
  - `japa · <ago>: <text>`, followed by `  <did>` on its own line when present
  - `<label> · <ago> · #<id>: <headline> (full: <pointer>)`
  - For job reports, `label` is `job <n> report`; otherwise `label` is the bracketed prefix (e.g. `[whatsapp]`).
    `pointer` is `job_transcript <n>` or `history_read <id>`.
  - A headline is the first line, cut to 200 characters.
- **Budget.** See spec §2.1. The output is `[Conversation so far]\n` plus the lines, or undefined when there are no
  messages.

- [ ] **Step 1: Write the failing tests** (fixtures from Task 1's helpers)
  - `the conversation runs back to the first gap over 30 minutes`.
  - `after a pause, only the previous exchange is shown, with its age`: messages from 3 h before `now` give exactly
    the last you/japa pair, each with `3 h ago`.
  - `automated arrivals are one headline with a pointer`: a 5,000-character job report renders as one line, at most
    200 characters, ending `(full: job_transcript 68)`.
  - `did lines follow the reply`.
  - `the WhatsApp replay`: you `+65 91466066`, japa `Your pairing code…`, auto `[whatsapp] WhatsApp was unlinked…`,
    japa `WhatsApp didn't stay linked…` all within 5 minutes. The output contains `+65 91466066`.
  - `older messages are shortened before any are dropped`: 40 messages of 1,500 characters each. The newest exchange
    is intact (up to 2,000 tokens), older messages are at most 200 characters, and the total is at most 32,000
    characters.
  - `drops leave a pointer line`: 400 short messages render a `[N earlier messages in this conversation:
    history_read <id>]` line, and the total is at most 32,000 characters.
  - `a steered run shows every input and no reply line when there was no reply`.
  - `an empty history renders nothing`.
- [ ] **Step 2:** Run `npx vitest --run test/window.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement. Cutting the newest exchange reuses the middle cut from `reset.ts`: move `cut()` here
  and export it.
- [ ] **Step 4:** Run. Expected: PASS.
- [ ] **Step 5:** Commit: `feat(memory): conversation window`.

### Task 4: Memory v3 state, profile guard, scratchpad state

**Files:**
- Modify: `src/kernel/memory/state.ts`
- Create: `src/kernel/memory/scratchpad.ts`
- Modify: `src/kernel/settings.ts`: memory default `maxTokens: 1000`
- Test: `test/memory-state.test.ts` (update), `test/scratchpad-state.test.ts`, `test/settings.test.ts` (1500 → 1000)

**Interfaces:**
- Produces, in `state.ts`:

```ts
export type Memory = {
  nextId: number; facts: Fact[];
  legacyEpisodes?: Episode[]; legacyUntil?: number;
  reflectedThrough?: EntryId; reflecting?: TaskId; sorting?: TaskId; sorted?: true;
  upgraded?: { loops: string[] };
};
// MemoryDoc: version 3; initial { nextId: 1, facts: [], sorted: true }
// migrate(value, from): from 1 → v1 loops into `upgraded`; from 1 or 2 → `episodes` into `legacyEpisodes`; `sorted` unset
export const MAX_WORDS = 30;
export function offScope(text: string): string | undefined;   // the reason, or undefined when the text is fine
export function hasEvidence(evidence: string, userLines: readonly string[]): boolean;
export type FactOp = { op: "add"; text: string } | { op: "update"; id: string; text: string } | { op: "delete"; id: string };
export function applyFactOps(memory: Memory, ops: FactOp[], now: number): { tooLong: FactOp[]; rejected: { op: FactOp; reason: string }[] };
export function expireLegacy(memory: Memory, now: number): void;  // drops legacyEpisodes and legacyUntil once now > legacyUntil
```

  `search()` and `Memory.episodes` are removed.

- **`offScope` reasons**, checked in this order:
  - `a file path`: `/(^|\s)(~\/|\/[\w.-]+\/[\w.-]+)/`
  - `a URL`: `/https?:\/\//`
  - `an IP address`: `/\b\d{1,3}(\.\d{1,3}){3}\b/`
  - `a commit or hash`: `/\b(?=[0-9a-f]*\d)[0-9a-f]{7,}\b/i`
  - `a job reference`: `/\bjob \d+/i`
- **`hasEvidence`:** true when the evidence has at least 3 words and, after lowercasing and collapsing whitespace,
  is a substring of some line.
- Produces, in `scratchpad.ts`:

```ts
export type Page = { id: string; title: string; text: string; updatedAt: number; archivedAt?: number };
export type Scratchpad = { nextId: number; pages: Page[] };
export const ScratchpadDoc;                      // kind "japa.scratchpad", version 1, conversation scope, history "latest"
export const PAGE_TOKENS = 1500, ACTIVE_PAGES = 15, ARCHIVE_AFTER = 14 * 86_400_000, DELETE_AFTER = 90 * 86_400_000;
export function findPage(pad: Scratchpad, title: string): Page | undefined;  // case-insensitive exact title
export function writePage(pad: Scratchpad, title: string, text: string, now: number): { error: string } | { page: Page; created: boolean };
// over PAGE_TOKENS → the refusal copy; otherwise creates or replaces, clears archivedAt, and archives the
// least-recently-updated active page when more than ACTIVE_PAGES are active
export function tidyPages(pad: Scratchpad, now: number): void;    // archive after ARCHIVE_AFTER, delete DELETE_AFTER after archivedAt
export function renderIndex(pad: Scratchpad, now: number): string | undefined; // "- <title> (updated <ago>)", newest first, active only
```

- [ ] **Step 1: Write the failing tests**
  - **`memory-state`:** keep the add/update/near-duplicate/cap tests, with 30 words.
    - `a path, URL, IP, hash or job reference is rejected with its reason`: each pattern is rejected;
      `Prefers RMB/SGD prices` and `Uses boat.dev` pass.
    - `evidence must be a quote of 3+ words`.
    - `v2 migrates episodes to legacy and is unsorted`.
    - `v1 still migrates`.
    - `legacy episodes expire`.
  - **`scratchpad-state`:**
    - `a page over 1,500 tokens is refused with the copy`.
    - `the 16th active page archives the least recently updated`.
    - `writing an archived page reactivates it`.
    - `pages archive after 14 days and are deleted 90 days later`.
    - `the index lists active pages newest first with their age`.
  - **`settings`:** the default is `{ maxFacts: 30, maxTokens: 1000 }`.
- [ ] **Step 2:** Run `npx vitest --run test/memory-state.test.ts test/scratchpad-state.test.ts test/settings.test.ts`.
  Expected: FAIL.
- [ ] **Step 3:** Implement. `applyFactOps` runs `offScope` on adds and updates before the word count.
- [ ] **Step 4:** Run. Expected: PASS. `npm run typecheck` will fail where `episodes` and `search` were used (in
  `tools.ts` and `reflect.ts`). Replace those uses with temporary minimal edits:
  - `memory_search`: use `legacyEpisodes ?? []`.
  - Reflection: stop pushing episodes.

  Tasks 7 and 8 replace them properly.
- [ ] **Step 5:** Commit: `feat(memory): v3 state, profile scope guard, scratchpad state`.

### Task 5: History service, recall and job origin

**Files:**
- Create: `src/kernel/memory/history.ts`
- Create: `src/kernel/memory/recall.ts`
- Modify: `src/kernel/jobs/state.ts`: add `origin?: EntryId` to `Job`
- Modify: `src/kernel/jobs/cos.ts`: `job_start` records `origin`
- Test: `test/recall.test.ts`, `test/jobs.test.ts` (add one test)

**Interfaces:**
- Consumes: Tasks 1–4.
- Produces:

```ts
// history.ts
export type History = {
  attach(root: Conversation): void;
  /** Catches the mirror up with the root's new entries; returns every message and the newest reset's id. */
  refresh(context: Context): Promise<{ messages: HistoryMessage[]; lastReset?: EntryId }>;
};
export function createHistory(): History;
export function corpus(messages: readonly HistoryMessage[], memory: Memory, pad: Scratchpad, jobs: Record<string, Job>): Doc[];

// recall.ts
export function renderRecall(input: {
  query: string; docs: readonly Doc[]; exclude: ReadonlySet<string>;  // keys already in view
  origin?: HistoryMessage; now: number;
}): string | undefined;
```

**History rules:**
- `refresh` pages `root.entries({ minEntryId: lastSeen + 1 }, 200, cursor, context)` (newest first), reverses the
  pages, and re-derives messages from the kept raw entries.
- Keep the raw entry list in memory: the mirror is rebuilt per daemon, and a japa message's `did` needs its tool
  results.

**Corpus rules:**
- One doc per message: key = `String(id)`, kind = message kind.
- `job:<id>` for each job with a `result`. Its text is `"<title>": <result>` and its `at` is `updatedAt`.
- `page:<id>` for every page, active or archived. Its text is `<title>\n<text>`.
- `episode:<id>` for each legacy episode.

**Recall rules:**
- The origin hit comes first: `you asked · <ago> · #<id>: <snippet 400>`.
- The other hits come from `rank(docs without exclude, query, now, 5)`:
  - `you`/`japa`/`auto` → `<kind> · <ago> · #<id>: <snippet 400>`;
  - `page` → `page "<title>" · updated <ago>: <first 600 chars> (page_read "<title>")`;
  - `job` → `job <id> "<title>" · <ago>: <snippet 400> (job_transcript <id>)`;
  - `episode` → `note · <ago>: <snippet 400>`.
- Hits are added while the total stays within 6,000 characters.
- Output: header `[From earlier: found by search; may be incomplete]` + lines, or undefined.

**Origin:** in `job_start`'s commit, `origin` is the id of the first `pi.user` item from
`tx.scanEntries({ conversationId: ROOT_CONVERSATION_ID }, 20)`.

- [ ] **Step 1: Write the failing tests**
  - **`recall`:**
    - `the superpowers replay`: a `you` doc from 10 Oct, "too much ceremony … superpowers …", among 50 unrelated
      docs; query `do u not remember my complaint about superpowers` gives that line first.
    - `excluded keys never appear`.
    - `at most 5 hits within 6,000 characters`.
    - `an origin hit comes first and is labelled you asked`.
    - `no hits renders nothing`.
    - `corpus includes archived pages, job results and legacy episodes`.
  - **`jobs` (sandboxed: `test.skipIf(NO_BWRAP)`):** `job_start records the input that started it`. Ask "clean up",
    the faux model calls `job_start`, and `jobs(daemon)["1"].origin` equals the id of the "clean up" user entry.
  - **`history` (in `recall.test.ts`, with `bootTest`):** `the mirror catches up incrementally`. Ask twice, calling
    `refresh` after each; the second call returns both exchanges.
- [ ] **Step 2:** Run `npx vitest --run test/recall.test.ts test/jobs.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run. Expected: PASS.
- [ ] **Step 5:** Commit: `feat(memory): history mirror, recall and job origin`.

### Task 6: Inject the context; the reset carries nothing

**Files:**
- Create: `src/kernel/memory/context.ts`
- Modify: `src/kernel/reset.ts`: remove `lastExchange`, `HEADER`, `CAP`, `render`, `show`, and the carry. Append the
  `ResetEntry` with `{ head: "self" }` only, and keep every check.
- Modify: `src/kernel/cos.ts`: `cosExtension(settings, tasks, tools, capabilities, history)` adds the context hook to
  the existing `beforeRequest`.
- Modify: `src/kernel/boot.ts`: `const history = createHistory()` before `cosExtension(…)`, and
  `history.attach(root)` after `ensureRoot`.
- Modify: `test/helpers.ts`: replace `carryOver` with `resetDone(daemon): Promise<void>`, which waits until the newest
  entry is a `ResetEntry`. Update callers in `test/transcript.test.ts`, `test/messaging.test.ts` and
  `test/reflect.test.ts`. In messaging, drop the `[image saved…]` carry assertion; Task 1 covers the note.
- Test: `test/reset.test.ts` (rewrite the carry tests)

**Interfaces:**
- Consumes: `History`, `corpus`, `renderWindow`, `renderRecall`, `MemoryDoc`, `ScratchpadDoc`, `JobsDoc`.
- Produces:

```ts
export function buildContext(input: {
  messages: readonly HistoryMessage[]; lastReset?: EntryId;
  memory: Memory; pad: Scratchpad; jobs: Record<string, Job>; now: number;
}): string | undefined;
```

**Rules:**
- **Inputs and window.** The run's inputs are the `you`/`auto` messages with `id > lastReset` (all of them when
  there is no reset). The window covers the messages with `id < lastReset` (none when there is no reset).
- **Recall query.** The run inputs' texts, plus the `you` texts in `conversation(before)`.
- **Excluded from recall.** The keys of the window's messages and of the run's inputs.
- **Origin.** It is the message whose id is `jobs[input.job].origin`, for the first `auto` input that has a `job`.
- **Output.** The window and recall joined by a blank line, or undefined when both are empty.

**Hook** (`cos.ts`, in the same `beforeRequest`):

```ts
let text = await api.memo<string | null>("japa.context", context);
if (text === undefined) {
  const { messages, lastReset } = await history.refresh(context);
  text = buildContext({ messages, lastReset, memory, pad, jobs, now: Date.now() }) ?? null; // docs via api.snapshot
  text = await api.memo("japa.context", text, context);
}
// when text is non-null: insert { role: "user", content: text, timestamp: 0 } before the first non-system message
```

- [ ] **Step 1: Write the failing tests** (`reset.test.ts`; remove the four `lastExchange` unit tests)
  - `a settled turn ends with a reset that carries nothing`: the newest entry is a `ResetEntry` with no model.
  - `the next turn sees the conversation so far`: ask "I'm Ada", then "What's next?". The last request's
    non-system messages are `[<starts with "[Conversation so far]" and contains "I'm Ada">, "What's next?"]`.
  - `the context is built once per run`: a run with two tool rounds gets the same injected text in both requests.
  - `the WhatsApp replay`: ask "+65 91466066"; submit input `[whatsapp] WhatsApp was unlinked; …`; ask "new code
    pls". The injected text contains `+65 91466066`.
  - `the jellyfin replay`: ask "jellyfin and maria can go"; submit input `[job 68 "Cleanup" done] Server 1 cleanup
    is done …`; ask "what's wrong with mariadb and jellyfin". The injected text contains
    `jellyfin and maria can go`, above the job 68 headline.
  - `an old discussion comes back through recall`: write a `pi.user` entry
    `superpowers is too much ceremony` with `timestamp: Date.now() − 2 days` through
    `root.submit({ type: "write", entry })`, then ask "my complaint about superpowers". The injected text contains
    `[From earlier` and `too much ceremony`.
  - `a brand-new root's first turn has nothing injected`.
  - Keep, with `resetDone` in place of the carry text: `no reset while the run is still going`,
    `no reset while an input is queued`, `a second reset for the same turn does nothing`,
    `a steered chain resets once`, `a job report resets the context like any other turn`, `the reset makes no model
    call`, the reflection-timing tests (whose `reflections()` helper answers with
    `save({ profile: [], pages: [] })`), and the compaction test.
- [ ] **Step 2:** Run `npx vitest --run test/reset.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement `context.ts`, the hook, the reset change and the boot wiring.
- [ ] **Step 4:** Run `npx vitest --run test/reset.test.ts test/transcript.test.ts test/messaging.test.ts`, then
  `npm run typecheck`. Expected: PASS.
- [ ] **Step 5:** Commit: `feat: inject the conversation window and recall; the reset carries nothing`.

### Task 7: Tools, sections and identity

**Files:**
- Modify: `src/kernel/memory/tools.ts`: remove `memory_search`; add `history_search`, `history_read`, `page_read`
  and `page_write`. `memoryTools` becomes `memoryTools(history: History)`.
- Modify: `src/kernel/cos.ts`: add a `scratchpad` section (`renderIndex`) after `about-you`; pass `history` to
  `memoryTools`.
- Modify: `src/kernel/boot.ts`: `pruneAndReport` also commits `tidyPages` and `expireLegacy` on the root.
  `root.commit` initialises `ScratchpadDoc` next to `MemoryDoc`.
- Modify: `src/kernel/identity.md` ("The thread", "Memory", "Memory, settings and secrets").
- Test: `test/memory.test.ts`, `test/content.test.ts`

**Interfaces:**
- Consumes: `History`, `corpus`, `rank`, `snippet`, `transcriptMessages`, the window line format, `writePage`,
  `findPage`, `offScope`.
- Produces the tools:
  - **`history_search({ query, since?, until? })`.** `since` and `until` are ISO dates or datetimes. It returns up to
    10 hits, each `<YYYY-MM-DD HH:MM> <kind> #<id or key>: <snippet 400>`, or `Nothing found.`
  - **`history_read({ id, before?, after? })`.** Window line format with full text, capped at 16,000 characters; or
    `No message #<id>.`
  - **`page_read({ title })`.** Returns `# <title> (updated <ago>[, archived])\n<text>`. With no exact match, it
    returns the best page hit's text prefixed `No page "<title>"; closest: `, or `No page "<title>".` when there is
    no hit.
  - **`page_write({ title, text })`.** Returns `Saved page "<title>".`, `Created page "<title>".` or the refusal copy.
  - **`memory_remember`.** Its description is "Remember something lasting about the user (not project or system
    details), in at most 30 words." It refuses with the profile refusal copies.

**identity.md changes:**
- **"The thread":** use the spec §3.5 text verbatim.
- **"Memory":**
  - "About you" holds lasting things about the user.
  - Project and topic state goes on scratchpad pages (`page_read` and `page_write`, at most 1,500 tokens each),
    holding the current state, not a log.
  - Keep a page for any work that spans turns, and update it when a decision is made or the state changes.
  - Recall past conversation with `history_search` and `history_read`.

- [ ] **Step 1: Write the failing tests**
  - **`memory.test`:**
    - `memory_remember refuses a path with the filter copy`.
    - `a fact over 30 words is refused`.
    - `page_write then page_read round-trips and the index appears in the system prompt` (`scratchpad` section with
      `- Factory (updated just now)`).
    - `page_write over 1,500 tokens is refused with the copy`.
    - `history_search finds an earlier message by keyword` (asks "the drum monitor is NUX", then searches "NUX").
    - `history_search finds a done job's result` (the existing `memory_search` test, ported).
    - `history_read returns the messages around an id`.
  - **`content.test`:** identity contains the §3.5 rule string, `page_write` and `history_search`, and does not
    contain `memory_search` or `episode`.
- [ ] **Step 2:** Run `npx vitest --run test/memory.test.ts test/content.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run, plus `npm run typecheck`. Expected: PASS.
- [ ] **Step 5:** Commit: `feat(memory): history and page tools, scratchpad section, identity`.

### Task 8: Reflection writes the profile and pages

**Files:**
- Modify: `src/kernel/memory/reflect.ts`
- Test: `test/reflect.test.ts` (rewrite the save shape; keep the cursor, chunking, failure and timing tests)

**Interfaces:**
- Consumes: `applyFactOps`, `hasEvidence`, `AUTOMATED`, `ScratchpadDoc`, `writePage`, `findPage`.
- Produces: the `save` tool schema
  `{ profile: ({op:"add",text,evidence} | {op:"update",id,text,evidence} | {op:"delete",id})[], pages: {title,text,basedOn?}[] }`.
  The `REFLECT` prompt keeps the prefix `You reflect on a chief-of-staff assistant's recent turns`. The user text
  keeps the prefix `Turns since the last reflection:`.

**Prompt content** (spec §4 and §6):
- **Profile scope and exclusions.** With a good example, `Protective of his Claude subscription limits; expects
  integrations to be efficient by default.`, and a bad one, `Factory settings: global defaults plus per-project
  overrides (behaviour, model/thinking per role, sandbox, ci).`
- **Evidence.** Every add or update needs a verbatim quote from a `user:` line that isn't automated.
- **Corrections.** A correction later in the batch wins.
- **Pages.** They record the state the batch reached, at most 1,500 tokens each. Pass back the `basedOn` you were
  shown, and leave out pages that didn't change.
- **Input layout.** The batch lines, then `Profile:` with `<id> (<age>): <text>`, then `Pages:`, one block per active
  page: `## <title> (basedOn <updatedAt>)\n<text>`.

**Commit:**
- **Profile ops.** Reject adds and updates whose evidence fails against the batch's non-automated `user:` lines.
  Apply the rest with `applyFactOps` and run the existing shorten and merge passes.
- **Page writes.** Skip a write when the page exists and `basedOn !== page.updatedAt`. A write over the cap gets one
  shorten call (prompt `Shorten this page to at most 1,500 tokens, keeping its current state.`, tool
  `save({ text })`) and is dropped if it is still over.
- **Cursor.** Advance it; no episodes.

- [ ] **Step 1: Write the failing tests**
  - `reflection saves profile items with evidence and advances the cursor`.
  - `an add whose evidence isn't in the batch is rejected`.
  - `evidence quoted from an automated line is rejected`.
  - `an off-scope add is rejected`.
  - `a page write creates the page`.
  - `a page write with a stale basedOn is skipped`: the CoS writes the page during reflection (held faux response),
    and its text survives.
  - `an oversized page is shortened once, then dropped if still too long`.
  - `the prompt shows profile ages and active pages`.
  - Keep, ported to the new shape: `reads only the turns after the cursor`, chunking, failure leaves the cursor,
    `boot reflects the turns left unreflected`.
- [ ] **Step 2:** Run `npx vitest --run test/reflect.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run, plus `npx vitest --run test/reset.test.ts`. Expected: PASS.
- [ ] **Step 5:** Commit: `feat(memory): reflection writes the profile with evidence, and pages`.

### Task 9: The one-time Sort

**Files:**
- Create: `src/kernel/memory/sort.ts`
- Modify: `src/kernel/boot.ts`: register `Sort` with `cosExtension`'s tasks. After `upgradeMemory`, call
  `startSort(root)` when `!memory.sorted`. Expose `daemon.sort(): Promise<void>` (start and wait), like `reflect`.
- Test: `test/sort.test.ts`

**Interfaces:**
- Consumes: `MemoryDoc`, `ScratchpadDoc`, `applyFactOps`, `writePage`, `reflectModel` (export it from `reflect.ts`
  as `reflectionModel(models, settings)`).
- Produces: `sorting({ models, settings }): { Sort; startSort(root: Conversation): Promise<TaskId> }`. Task name
  `japa.sort`, version 1. The prompt starts with `You sort a chief-of-staff assistant's old memory`. Tool
  `save({ profile: FactOp[], pages: {title,text}[] })`. The evidence check is waived; `offScope` and the caps still
  apply.

**Input:**
- `Facts:` with `<id>: <text>`.
- Then `Episodes (newest first):`, cut to half the model's context window.

**Commit:**
- Replace `facts` with the result of applying the ops to the current facts.
- Write up to 15 pages, ignoring the rest and any over-cap page.
- Set `legacyUntil = now + DELETE_AFTER` and `sorted = true`.

A failed or aborted Sort leaves `sorted` unset, so boot starts it again.

- [ ] **Step 1: Write the failing tests**
  - `a v2 memory is sorted into profile and pages once`: write a v2-shaped doc by committing `MemoryDoc` with
    `sorted` deleted, facts `["Lives at Kopar at Newton", "Factory settings: global defaults…"]` and one episode.
    The faux `save` keeps the first fact, deletes the second and writes page `Software factory`. Afterwards:
    - the facts are `["Lives at Kopar at Newton"]`;
    - the page exists;
    - `sorted` is true and `legacyUntil` is set;
    - a second `daemon.sort()` makes no model call.
  - `a failed sort leaves sorted unset and runs at the next boot` (sqlite home, as in `boot reflects…`).
  - `a fresh install never sorts`: no Sort model call after boot.
  - `legacy episodes are searchable until they expire` (`history_search` finds the episode text).
- [ ] **Step 2:** Run `npx vitest --run test/sort.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the whole suite, `npm test`, and `npm run typecheck`. Expected: PASS (tests that need
  bubblewrap are skipped where it's absent).
- [ ] **Step 5:** Commit: `feat(memory): one-time sort of v2 memory into profile and pages`.
