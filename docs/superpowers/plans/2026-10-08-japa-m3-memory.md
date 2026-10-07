# japa Milestone 3 — Context Lifecycle and Memory Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep the CoS's context short. When it is idle and its live window is too large or stale, a durable consolidation task updates what it remembers about the user, its open loops, and an episode log, then resets the context with a handoff note. Add the user-facing memory tools and the CoS tool-result cap.

**Architecture:** Memory is a root document `japa.memory` holding facts, open loops, episodes, and `lastResetAt`. Pure functions in `src/kernel/memory/state.ts` enforce the limits on facts. These limits are the word cap, near-duplicate rejection, and the overall cap. The `japa.consolidate` task works in three steps. It calls the consolidation model through `models.completeSimple` with one tool `save`, which is used only for structured output. It runs at most one shorten pass and one merge pass. It then commits the memory changes only if the root is still idle and unchanged, and finally calls `root.reset(handoff)`. A daemon interval checks the trigger. The CoS gets two new sections, "About you" and "Open loops". It also gets the memory tools and a `beforeRequest` hook that caps tool results in what the model sees. Storage keeps the full results.

**Spec:** `docs/superpowers/specs/2026-10-07-japa-design.md`. This plan covers §7 (all of it), the tool-result cap in §5.3, and the "finished since the last reset" board line in §7.2.

## Global Constraints

- All M1 and M2 constraints apply. Prime directive from the user: don't overcomplicate. Write minimal code and no code for its own sake.
- Tests use the faux provider only. The consolidation model is the faux model too. Route faux responses by request content. A consolidation request is recognisable by its system prompt or user text.
- Token estimates everywhere use `Math.ceil(chars / 4)`.
- Fact limits: at most 50 words per entry. The defaults for `settings.memory` are `{ maxFacts: 30, maxTokens: 1500 }`. Two facts are near-duplicates when the Jaccard similarity of their normalized word sets is ≥ 0.8. Normalizing means lowercasing, stripping punctuation and splitting on whitespace.
- New settings and their defaults:
  - `models.consolidation?: ModelRef`. When unset, `models.cos` is used.
  - `context: { resetTokens: 20000, idleResetHours: 2, toolResultTokens: 2000 }`.
  - `memory: { maxFacts: 30, maxTokens: 1500 }`.
  - `loadSettings` merges **every** object-valued top-level key one level deep over the defaults. This generalizes M1's per-key list.

## Rulings (binding)

- **Memory lives in Pi Durable documents, not files.** Spec §7.6 puts memory in `memory/*.json` and `memory/episodes/*.md`, committed to git. Here, facts, loops and episodes live in the root document `japa.memory`. This makes consolidation one atomic commit together with the staleness check, which is what §7.3 requires. If this is wrong, memory is not hand-editable or git-versioned. M5's workspace work can mirror it to files if that is wanted.
- **`memory_remember` over the cap still adds the fact.** The next consolidation's merge pass then brings the list back under the cap.
- **The trigger is a daemon interval, not a durable timer.** It runs every 60 s and is unref'd. The check is stateless, so a restart simply rechecks.

## Review Focus

1. **Stale consolidation is discarded.** Suppose new root entries arrive, or the root becomes busy, while the consolidation model is working. Then no memory is written and no reset happens. Test in Task 3.
2. **Nothing is lost across reset.**
   - The facts, the open loops, and the board's "finished since last reset" jobs all appear in the CoS's next request.
   - The handoff note becomes the first message of the new context.
   - The full history stays in storage. Surfaces still show the whole history.
   - Test in Task 3.
3. **Fact limits always hold after consolidation:**
   - no entry is over 50 words;
   - no near-duplicates are present;
   - the list fits within the caps, or the kernel truncated it.
   - Tests in Tasks 1 and 3.
4. **The tool-result cap applies to the CoS only.** It changes only what the model sees. The stored tool result is complete, and jobs see full results. Test in Task 2.

---

## File Structure

```
src/kernel/settings.ts           generalized merge; context, memory, models.consolidation
src/kernel/memory/state.ts       MemoryDoc ("japa.memory"), pure helpers
src/kernel/memory/tools.ts       memory_facts / memory_remember / memory_forget / memory_search
src/kernel/memory/consolidate.ts Consolidate task + prompts
src/kernel/memory/trigger.ts     shouldConsolidate(), startConsolidationTimer()
src/kernel/cos.ts                + sections "about-you", "open-loops"; result-cap hook; memory tools
src/kernel/jobs/state.ts         board(jobs, since?)
src/kernel/boot.ts               wiring
test/memory-state.test.ts, test/memory.test.ts, test/consolidate.test.ts
```

---

### Task 1: Settings and memory state

**Files:**
- Modify: `src/kernel/settings.ts`
- Create: `src/kernel/memory/state.ts`
- Test: `test/settings.test.ts`, `test/memory-state.test.ts`

**Interfaces:**
- **Settings.** Add the new keys from Global Constraints. The merge is generic: for each key in `DEFAULT_SETTINGS` whose value is a plain object, merge the user's object over the default one level deep. Keep the M1 and M2 settings tests passing.
- **Types:**
  - `Fact = { id: string; text: string; updatedAt: number }`.
  - `Loop = { id: string; text: string; createdAt: number }`.
  - `Episode = { id: string; at: number; text: string }`.
- **`MemoryDoc`** is a `defineDoc` with these properties:
  - shape: `{ nextId: number; facts: Fact[]; loops: Loop[]; episodes: Episode[]; lastResetAt?: number }`;
  - kind `"japa.memory"`, version 1, conversation scope, `history: "latest"`, `fork: "initial"`;
  - initial value `{ nextId: 1, facts: [], loops: [], episodes: [] }`;
  - it lives on the root conversation.
- **`FactOp`** is one of:
  - `{ op: "add"; text }`
  - `{ op: "update"; id; text }`
  - `{ op: "delete"; id }`
- **`applyFactOps(memory, ops, now): { tooLong: FactOp[] }`** mutates `memory` in place, so it can be called on a draft inside a commit:
  - **add:** skipped if the text is a near-duplicate of an existing fact. Otherwise the fact gets a new id from `nextId`.
  - **update:** replaces the text and sets `updatedAt`. Skipped if the id is unknown, or if the new text is a near-duplicate of a *different* fact.
  - **delete:** removes the fact.
  - Any add or update whose text is over 50 words is not applied. It is returned in `tooLong` instead.
- **`overCap(facts, limits): boolean`** is true when there are more facts than `maxFacts`, or the summed token estimate is over `maxTokens`.
- **`truncateToCap(facts, limits)`** drops the facts with the oldest `updatedAt` until the list fits. It is the kernel's last resort.
- **`applyLoopOps(memory, ops, now)`** handles two ops:
  - `{ op: "add"; text }`
  - `{ op: "close"; id }`, which removes the loop.
- **Exported helpers:** `wordCount`, `nearDuplicate(a, b)`, `estimateTokens(text)`.
- **`renderFacts(facts)`** gives `- <text>` lines, or `undefined` when there are none. **`renderLoops(loops)`** works the same way.
- **`search(memory, jobs, query, limit = 5)`:**
  - Scores episodes and job results by how many distinct query words they contain, matched case-insensitively.
  - Returns the best matches as lines, highest score first and newest first on ties:
    - `<ISO date> episode: <text>` for episodes
    - `<ISO date> job <id> "<title>": <result>` for jobs
  - Items that match nothing are left out.

- [ ] **Step 1: Write failing tests:**
  - the generic merge, including the `context` and `memory` defaults and a partial user `context`;
  - an add of a duplicate is skipped;
  - an update to a duplicate is skipped;
  - a 51-word add is returned in `tooLong`;
  - delete works;
  - `overCap` and `truncateToCap` handle both the count and the token limit;
  - loop add and close;
  - `search` ranks by matches and ignores items with none.
- [ ] **Step 2–4:** RED, implement, GREEN.
- [ ] **Step 5: Commit** `feat(memory): settings and memory state`

---

### Task 2: CoS memory sections, memory tools, tool-result cap

**Files:**
- Create: `src/kernel/memory/tools.ts`
- Modify: `src/kernel/cos.ts`, `src/kernel/jobs/state.ts`, `src/kernel/jobs/cos.ts` (board call), `src/kernel/boot.ts`
- Test: `test/memory.test.ts`

**Interfaces:**
- **New sections in `japa-cos`**, rendered after `identity` in this order:
  - `about-you` renders `renderFacts` of the root `MemoryDoc`;
  - `open-loops` renders `renderLoops`.
  - Each section is omitted when it renders `undefined`.
  - They read the document through the section input's committed read, as the jobs section does.
- **`board(jobs, since?: number)`** also includes terminal jobs (`done`, `failed`, `cancelled`) with `updatedAt > since`, shown as `- <id> "<title>" <status>: <result>`. The jobs section passes `MemoryDoc.lastResetAt ?? 0`.
- **Memory tools**, added to `japa-cos` so that only the root has them:
  - **`memory_facts()`** gives `<id>: <text>` lines, or `Nothing saved yet.`
  - **`memory_remember({ text })`:**
    - Over 50 words, it replies `Too long — keep it to about two sentences (50 words).` and saves nothing.
    - A near-duplicate replies `Already remembered: <existing text>`.
    - Otherwise it adds the fact and replies `Remembered.`, even when this goes over the cap (see the ruling).
  - **`memory_forget({ id })`** replies `Forgot: <text>` or `No memory <id>.`
  - **`memory_search({ query })`** gives the `search()` lines over the root memory and jobs, or `Nothing found.`
- **Result cap:**
  - `japa-cos` gets a `beforeRequest` hook on `GenerationTask`. It returns the request's messages with the text of each `toolResult` message capped at `settings.context.toolResultTokens * 4` characters.
  - Text over the cap is cut and followed by `\n[Truncated <n> characters. Start a job if you need the full output.]`.
  - Because the hook lives in `japa-cos`, only the root gets it.
  - The stored entries keep the full result.
- **Sections are static per document state.** That way prompt caching only breaks when memory changes.

- [ ] **Step 1: Write failing tests:**
  1. After `memory_remember`, the CoS's next request has an "about-you" system section with the fact. Check the faux `role: "system"` messages, as in M1's identity test.
  2. `memory_forget` removes the fact.
  3. A remember that is too long or a duplicate is refused.
  4. `memory_search` finds a done job's result by keyword.
  5. An extension tool that returns 20 000 characters shows up in the CoS's next request as at most 8 000 characters plus the truncation note.
  6. The stored tool-result entry still holds all 20 000 characters.
  7. The same tool called from a job shows up in that job's next request uncut.
- [ ] **Step 2–4:** RED, implement, GREEN.
- [ ] **Step 5: Commit** `feat(memory): about-you, open loops, memory tools, result cap`

---

### Task 3: Consolidation

**Files:**
- Create: `src/kernel/memory/consolidate.ts`
- Modify: `src/kernel/boot.ts`, `src/kernel/cos.ts`
- Test: `test/consolidate.test.ts`

**Interfaces:**
- **`consolidation({ models, settings })`** returns `{ Consolidate, startConsolidation(api) }`.
  - `Consolidate` is a task `japa.consolidate`. It is installed in a kernel Pi Durable extension, which may be `japa-cos`.
  - It is created on the root as `{ ownership: { kind: "conversation" }, background: true }`.
  - **Phase `consolidate`:**
    1. Read the live window, meaning the root's model messages since the last reset. Read the current memory and the root's latest entry id, called `head`.
    2. Call `models.completeSimple(model, { systemPrompt, messages, tools: [save] })`. The model is `models.consolidation ?? models.cos`.
       - The prompt carries the reflection rules from spec §7.4 and the open-loop and episode instructions from §7.3.
       - The `save` tool's arguments are `{ facts: FactOp[], loops: LoopOp[], episode: string, handoff: string }`.
       - The rendered window and the current facts and loops (with ids) go in the user message.
       - The result is read from the `save` tool call's arguments. If there is no tool call, the task completes without doing anything.
    3. Apply the ops to a copy of the memory with `applyFactOps` and `applyLoopOps`.
    4. **Shorten pass:** if `tooLong` is non-empty, run one more `save`-style call. It gets only those entries and the instruction to shorten each to ≤ 50 words. Apply its ops, and drop any entry that is still too long.
    5. **Merge pass:** if `overCap`, run one call. It gets the full fact list and the caps, with the instruction to merge related entries and drop the least useful until the list fits. Apply its ops, then `truncateToCap`.
    6. Then, in one commit:
       - If the root is busy, or its latest entry is no longer `head`, finish as completed and write nothing.
       - Otherwise, write the new memory. Append an episode `{ id, at: now, text: episode }` and set `lastResetAt = now`. Checkpoint `{ phase: "reset", handoff }`.
  - **Phase `reset`:** call `root.reset(handoff)`, then finish.
  - **`startConsolidation(api)`** creates the task in a commit, unless a `Consolidate` task for the root is already live. Store its id in `MemoryDoc` as `consolidating?: TaskId`, and clear it when the task finishes.
- **The daemon exposes `consolidate(): Promise<void>`**, which starts consolidation and waits for the task. It is used by tests and by the Task 4 timer.
- **Automatic compaction stays at the Pi Durable default.**

- [ ] **Step 1: Write failing tests:**
  - **Consolidate → reset:**
    1. The user says "I'm Ada, I prefer short answers" and the CoS replies.
    2. `consolidate()` runs. The faux consolidation answer is a `save` with one fact, one loop, an episode and the handoff "Ada asked for short answers.".
    3. The facts and loops are saved and the episode is appended.
    4. The next CoS request's messages start after the reset: the handoff message, then the new user message. Before them come the about-you section with the fact and the open-loops section with the loop.
    5. `root.entries` still holds the old messages.
  - **Stale:** the faux consolidation response is held. Meanwhile a new user message arrives and is answered. After the response is released, memory is unchanged and no reset happened.
  - **Limits:**
    - A `save` adding a 60-word fact triggers the shorten call. The shortened version is stored.
    - A shorten answer that is still too long gets the fact dropped.
    - A `save` that pushes the facts over `maxFacts` (set to 3 in the test) triggers the merge call. The result has at most 3 facts.
  - **Board:** a job finished before the reset is still listed as finished. After the next reset, it no longer appears.
- [ ] **Step 2–4:** RED, implement, GREEN.
- [ ] **Step 5: Commit** `feat(memory): consolidate and reset the CoS context`

---

### Task 4: Consolidation trigger

**Files:**
- Create: `src/kernel/memory/trigger.ts`
- Modify: `src/kernel/boot.ts`
- Test: `test/consolidate.test.ts`

**Interfaces:**
- **`shouldConsolidate({ busy, windowTokens, lastUserAt, now }, settings.context): boolean`** is a pure function. It returns true when all of these hold:
  - `!busy`;
  - `windowTokens > 0`;
  - either `windowTokens > resetTokens`, or `lastUserAt !== undefined && now - lastUserAt > idleResetHours * 3_600_000`.
- **The daemon's `checkConsolidation(now = Date.now())`:**
  - computes the inputs:
    - `busy` comes from the root's live run;
    - `windowTokens` is `estimateTokens` over the live window's text;
    - `lastUserAt` is the timestamp of the latest user message in the window;
  - calls `consolidate()` when `shouldConsolidate` is true.
- **Boot:**
  - Boot starts a 60 s `setInterval` (unref'd) that calls `checkConsolidation` and ignores its errors.
  - `close()` clears the interval before shutting down.

- [ ] **Step 1: Write failing tests:**
  - **Table-driven tests of `shouldConsolidate`:**
    - busy → false;
    - an empty window → false;
    - over the token limit → true;
    - idle past the hours limit → true;
    - neither → false.
  - **`checkConsolidation`:**
    - With `resetTokens: 10` in settings and one exchange in the window, it consolidates.
    - With the default settings and a fresh exchange, it does not.
- [ ] **Step 2–4:** RED, implement, GREEN.
- [ ] **Step 5: Commit** `feat(memory): consolidate when idle and full or stale`
