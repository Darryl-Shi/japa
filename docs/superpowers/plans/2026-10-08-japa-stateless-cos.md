# The Stateless CoS Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The CoS's model context is cleared after every settled run and carries over only the last exchange; everything else it needs comes from durable state, and memory is written by a background reflection over the stored transcript.

**Architecture:** A kernel watcher on the root's `LiveDoc` commits a `ResetEntry` (`head: "self"`) whose model content is the last exchange, with no model call. `Consolidate` becomes `Reflect`, a background task that reads the stored entries after a cursor (`MemoryDoc.reflectedThrough`), writes facts and one episode, and never touches the root's context. Open loops, the handoff note, the 60 s consolidation timer and the two context settings go; the CoS reads jobs, schedules, facts and pending secret requests from documents instead.

**Tech Stack:** TypeScript on Node 24 (native type stripping, no build step), `@earendil-works/pi-durable`, `@earendil-works/pi-ai`, vitest with the faux provider and in-memory storage.

**Spec:** `docs/superpowers/specs/2026-10-08-japa-stateless-cos-design.md`, which extends `docs/superpowers/specs/2026-10-07-japa-design.md` (the main spec) and replaces its §7.3 context-reset and consolidation design.

## Global Constraints

- Prime directive: don't overcomplicate. Minimal code, no code for the sake of code, no speculative options. Prefer deleting code.
- `npm test` and `npm run typecheck` pass at the end of every task.
- Carry-over cap: **2,000 tokens**, estimated at **4 characters per token** (8,000 characters); the middle of the longest part is cut and marked `[…]`.
- Carry-over header: `[Your last exchange]`; input lines are `user: <text>`, the answer line is `you: <text>`.
- Reflection fires at **5** unreflected turns, otherwise **15 minutes** (900,000 ms) after the last reset; a turn is one reset after `reflectedThrough`.
- The jobs section lists active jobs plus jobs finished in the last **24 h** (86,400,000 ms).
- The promise rule text is copied **verbatim** from spec §3 (Task 3).
- Token estimates stay `Math.ceil(chars / 4)` (`estimateTokens` in `src/kernel/memory/state.ts`).
- Fact rules are unchanged: ≤ 50 words, near-duplicate rejection (Jaccard ≥ 0.8), `memory.maxFacts` 30, `memory.maxTokens` 1500, one shorten pass, one merge pass.
- `settings.context` keeps only `toolResultTokens` (default 2000). `models.consolidation` keeps its name.
- Pi Durable compaction stays at its default (`enabled: true`, `reserveTokens: 16384`, model-relative threshold `contextWindow − reserveTokens`): the kernel passes no `compaction` setting and must not disable it.
- Tests use the faux provider only; reflection requests are recognised by their system prompt starting with `You reflect`.

## Review Focus

- **An input queued while a run settles.** The reset must not land between the queued input and the context it belongs to: with an item in `pi.inbox`, the commit writes nothing and the next settle resets instead. → Task 2, `no reset while an input is queued`.
- **A run that ends with no assistant text** (abort, model error, or a tool-only run). The reset must still happen and must not emit an empty `you:` line or throw. → Task 2, `a turn with no answer resets without an answer line`.
- **The user-visible transcript.** A reset per turn must not make surfaces show carry-over text or lose history. → Task 2, `surfaces keep the whole history and hide the carry-over`.
- **A `settings.json` left from the old version** (`context.resetTokens`, `context.idleResetHours`). Unknown keys must be ignored, not fatal. → Task 1, `leftover context settings are ignored`.
- **A reflection that fails** (model error, abort, restart). The cursor must stay put so the same turns are retried, and no second Reflect may run beside it. → Task 1, `a reflection that faults leaves the cursor and is retried`.

---

## File Structure

```
src/kernel/reset.ts               NEW: lastExchange(), resetRoot(), watchResets()
src/kernel/memory/reflect.ts      NEW (replaces consolidate.ts): Reflect task, startReflect,
                                  unreflectedTurns, reflectDelay, upgradeMemory
src/kernel/memory/consolidate.ts  DELETED
src/kernel/memory/trigger.ts      DELETED
src/kernel/memory/state.ts        MemoryDoc version 2 + migrate; loops gone
src/kernel/memory/tools.ts        unchanged
src/kernel/cos.ts                 − open-loops section, + waiting-on-you section
src/kernel/secret-requests.ts     + renderPending()
src/kernel/jobs/state.ts          board() 24 h window; detail is the first line
src/kernel/jobs/cos.ts            jobs section drops the MemoryDoc read
src/kernel/boot.ts                reflect(); reset watcher; reflect triggers; no 60 s timer
src/kernel/settings.ts            context: { toolResultTokens }
src/kernel/identity.md            promise rule, no loops, no handoff
skills/choosing-a-mechanism/SKILL.md, skills/writing-job-briefs/SKILL.md   promise rule
test/reflect.test.ts              NEW (replaces test/consolidate.test.ts)
test/reset.test.ts                NEW
```

---

### Task 1: Reflection replaces consolidation

**Files:**
- Create: `src/kernel/memory/reflect.ts`
- Delete: `src/kernel/memory/consolidate.ts`, `src/kernel/memory/trigger.ts`, `test/consolidate.test.ts`
- Modify: `src/kernel/memory/state.ts`, `src/kernel/cos.ts` (drop the `open-loops` section), `src/kernel/jobs/state.ts` (`board`), `src/kernel/jobs/cos.ts` (jobs section), `src/kernel/boot.ts`, `src/kernel/settings.ts`, `README.md:42`
- Test: `test/reflect.test.ts` (new, replaces `test/consolidate.test.ts`), `test/memory-state.test.ts`, `test/jobs-state.test.ts`, `test/settings.test.ts`, `test/transcript.test.ts`

**Interfaces:**
- Consumes: `line(m: Message): string` from `src/kernel/jobs/cos.ts`; `BACKGROUND` from `src/kernel/jobs/run.ts`; `applyFactOps`, `overCap`, `truncateToCap`, `estimateTokens` from `src/kernel/memory/state.ts` (unchanged).
- Produces:
  - `type Memory = { nextId: number; facts: Fact[]; episodes: Episode[]; reflectedThrough?: EntryId; reflecting?: TaskId; upgraded?: { loops: string[] } }` in `src/kernel/memory/state.ts`. `Loop`, `LoopOp`, `applyLoopOps`, `renderLoops` are deleted; `Fact`, `Episode`, `FactOp`, `Limits`, `renderFacts`, `search`, `wordCount`, `nearDuplicate`, `estimateTokens`, `applyFactOps`, `overCap`, `truncateToCap` stay.
  - `MemoryDoc`: same kind `japa.memory`, **version 2**, `initial: () => ({ nextId: 1, facts: [], episodes: [] })`, plus `migrate(value, fromVersion)` — drops `loops`, `lastResetAt`, `previousResetAt`, `consolidating` and sets `upgraded: { loops: <the version 1 loop texts> }`.
  - `reflection({ models, settings }: { models: Models; settings: Settings }): { Reflect: AnyTask; startReflect(root: Conversation): Promise<TaskId> }` in `src/kernel/memory/reflect.ts`.
  - `unreflectedTurns(harness: Harness, root: Conversation): Promise<number>` — the number of `pi.reset` entries after `reflectedThrough`.
  - `reflectDelay(turns: number): number | undefined` — `0` at 5 or more turns, `900_000` at 1–4, `undefined` at 0.
  - `upgradeMemory(root: Conversation): Promise<string[]>` — when `memory.upgraded` is set, sets `reflectedThrough` to the newest root entry, clears `upgraded` and returns the dropped loop texts; otherwise returns `[]`.
  - `board(jobs: Record<string, Job>, now?: number): string | undefined` in `src/kernel/jobs/state.ts` — active jobs plus jobs with `updatedAt > now - 86_400_000`; the detail is the **first line** of `progress` (running) or `result` (terminal / needs_input), cut to 120 characters with `…` as today.
  - `Daemon.reflect(): Promise<void>` replaces `Daemon.consolidate()`; `Daemon.checkConsolidation` is gone.
  - `Settings["context"]` is `{ toolResultTokens: number }`.

- [ ] **Step 1: Write the failing tests**

Create `test/reflect.test.ts` from `test/consolidate.test.ts`, keeping its `route`/`save`/`memory`/`factTexts` helpers, routing reflection requests on `system.startsWith("You reflect")`, and using `facts = (...ops) => ({ facts: ops, episode: "e" })`. Delete the `shouldConsolidate` table, both `checkConsolidation` tests, the stale-consolidation test and the board test (the board moves to Step 1's `test/jobs-state.test.ts` edits). Tests:

```ts
test("reflection saves facts and an episode and advances the cursor", async () => {
  // route: save({ facts: [{ op: "add", text: "Ada prefers short answers" }], episode: "Ada introduced herself." })
  await ask(daemon, "I'm Ada, I prefer short answers");
  await daemon.reflect();
  const saved = await memory(daemon);
  expect(saved.facts.map((f) => f.text)).toEqual(["Ada prefers short answers"]);
  expect(saved.episodes.map((e) => e.text)).toEqual(["Ada introduced herself."]);
  expect(saved.reflectedThrough).toBe((await daemon.root.entries({}, 1, undefined, ctx)).items[0]!.id);
});

test("reflection reads only the turns after the cursor", async () => {
  // `prompts: string[]` collects the user text of every "You reflect" request
  await ask(daemon, "first");
  await daemon.reflect();
  await ask(daemon, "third");
  await daemon.reflect();
  expect(prompts[1]).toContain("third");
  expect(prompts[1]).not.toContain("first");
});

test("reflection does not change the root's context", async () => {
  const before = (await daemon.root.context(ctx)).messages.length;
  await daemon.reflect();
  expect((await daemon.root.context(ctx)).messages.length).toBe(before);
});

test("a long range is reflected in chunks, oldest first", async () => {
  // kit = testKit({ models: [{ id: "narrow", contextWindow: 4000 }] }) → budget 2000 tokens = 8000 characters
  await ask(daemon, `A ${"x".repeat(5000)}`);
  await ask(daemon, `B ${"y".repeat(5000)}`);
  await daemon.reflect();
  expect(prompts).toHaveLength(2);
  expect(prompts[0]!.includes("A ")).toBe(true);
  expect(prompts[0]!.includes("B ")).toBe(false);
  expect((await memory(daemon)).reflectedThrough).toBe((await daemon.root.entries({}, 1, undefined, ctx)).items[0]!.id);
  expect((await memory(daemon)).episodes).toHaveLength(2);   // one per chunk
});

test("a reflection that faults leaves the cursor and is retried", async () => {
  // first reflection answers save({}) (no facts/episode → the phase throws and the task faults)
  await daemon.reflect().catch(() => {});
  expect((await memory(daemon)).reflectedThrough).toBeUndefined();
  await daemon.reflect();
  expect(await factTexts(daemon)).toEqual(["Ada likes tea"]);
});

test.each([[0, undefined], [1, 900_000], [4, 900_000], [5, 0], [12, 0]])(
  "reflectDelay(%i) is %s", (turns, expected) => expect(reflectDelay(turns)).toBe(expected));

test("unreflectedTurns counts the resets after the cursor", async () => {
  // append two ResetEntry writes with `root.submit({ type: "write", entry: { kind: "pi.reset", head: "self" } })`
  expect(await unreflectedTurns(daemon.harness, daemon.root)).toBe(2);
});

test("boot reflects when turns are unreflected", async () => {
  // sqlite home: boot, ask, append a reset write, close; boot again and wait for a "You reflect" request
  await waitFor(() => prompts.length > 0);
});

test("a version 1 memory drops its loops and keeps its facts", () => {
  const fact = { id: "1", text: "Ada likes tea", updatedAt: 5 };
  expect(MemoryDoc.definition.migrate!({ nextId: 4, facts: [fact], loops: [{ id: "3", text: "call the bank", createdAt: 1 }],
    episodes: [], lastResetAt: 7, previousResetAt: 2, consolidating: 9 }, 1)).toEqual(
    { nextId: 4, facts: [fact], episodes: [], upgraded: { loops: ["call the bank"] } });
});

test("the upgrade notice is delivered once and sets the cursor", async () => {
  // sqlite home (as test/boot.test.ts "history survives a restart on sqlite"): boot, ask once, commit
  // `upgraded: { loops: ["call the bank"] }` into MemoryDoc, close, boot again as `d`
  expect((await texts(d.root, "user")).filter((t) => t.startsWith("[japa] Open loops"))).toEqual([
    "[japa] Open loops are no longer kept for you; your context is cleared after every reply. If any of these still matter, back it with a schedule or a job:\n- call the bank",
  ]);
  expect((await memory(d)).upgraded).toBeUndefined();
  expect((await memory(d)).reflectedThrough).toBeDefined();
  // a third boot posts nothing more (requestId `memory:v2-loops`)
});

test("leftover context settings are ignored", async () => {
  const { daemon } = await bootTest({ context: { resetTokens: 20000, idleResetHours: 2 } });
  expect(daemon.status().errors).toEqual([]);
});
```

In `test/memory-state.test.ts`: delete `loops add and close` and the `loops: []` fields in the `memory()` helper. In `test/jobs-state.test.ts`: replace `board also lists jobs finished since the given time` with

```ts
test("board lists jobs finished in the last 24 hours and the first line of their detail", () => {
  const now = 100 * HOUR;
  const jobs = jobsOf(job(1, "done", { result: "old", updatedAt: now - 25 * HOUR }),
    job(5, "failed", { result: "boom\nstack trace", updatedAt: now - 23 * HOUR }));
  expect(board(jobs, now)).toBe('- 5 "t5" failed: boom');
});
```

In `test/settings.test.ts`: `context` defaults to `{ toolResultTokens: 2000 }`. In `test/transcript.test.ts`: delete `surfaces keep the history from before a reset and hide the handoff` (Task 2 replaces it).

- [ ] **Step 2: Run the tests and the typecheck to see them fail**

Run: `npx vitest --run test/reflect.test.ts test/memory-state.test.ts test/jobs-state.test.ts && npm run typecheck`
Expected: FAIL — `reflect` is not a property of `Daemon`, `reflectDelay`/`unreflectedTurns`/`upgradeMemory` are not exported, `board` still windows on `since`.

- [ ] **Step 3: Implement the interfaces above**

- `state.ts`: the `Memory` type, `MemoryDoc` version 2 with `migrate`, and the loops deletions.
- `reflect.ts`: carry over `ask()`, `saveTool`, `factOps`, `SHORTEN`, `merge()`, `listed()` and the shorten/merge passes from `consolidate.ts` unchanged. The `save` tool takes `{ facts: factOps, episode: Type.String() }`. The prompt is today's `REFLECT` with the `loops:` and `handoff:` bullets deleted, its first sentence replaced by `You reflect on a chief-of-staff assistant's recent turns and update what it remembers about the user. Call save once with:`, the episode bullet reading `a short summary of these turns`, and the automated-reports line kept verbatim. The user text is `Turns since the last reflection:\n<lines>\n\nFacts:\n<listed(facts)>`.
- The `Reflect` task (`japa.reflect`, version 1, one phase `reflect`, `abort` as in `Consolidate`): reads `MemoryDoc`, drains `tx.scanEntries({ conversationId: ROOT_CONVERSATION_ID, minEntryId: (reflectedThrough + 1) as EntryId }, 200, cursor)` into oldest-first order, skips entries of kind `pi.reset` and `pi.compaction`, renders each remaining entry's non-system `model` messages with `line()`, and takes entries while the rendered text stays within `Math.floor(contextWindow / 2)` tokens of the consolidation model (`models.consolidation ?? models.cos`) — half the window leaves room for the prompt, the facts and the answer; at least one entry is always taken. After the model answers, one commit applies the fact ops, pushes `{ id, at, text: episode }` to `episodes` and sets `reflectedThrough` to the last entry read. It returns `{ status: "running", checkpoint: { phase: "reflect" } }` while entries remain and terminal otherwise. Destructuring a missing `save` field throws, which faults the task and leaves the cursor.
- `startReflect(root)`: as `startConsolidation`, guarding on `memory.reflecting`.
- `boot.ts`: `reflect()` = `await opened.waitForTask(await startReflect(root), ctx)`; delete the 60 s interval, `checkConsolidation`, the `estimateTokens`/`shouldConsolidate`/`LiveDoc` imports it needed; after the document-ensuring commit call `upgradeMemory(root)` and, for a non-empty result, `root.submit({ type: "input", content: notice, requestId: "memory:v2-loops" }, ctx)`; after `harness.resume()`, when `reflectDelay(await unreflectedTurns(opened, root)) === 0`, start reflection without awaiting it (`void reflect().catch(() => {})`).
- `cos.ts`: delete the `open-loops` section and the `renderLoops` import. `jobs/cos.ts`: the jobs section becomes `doc && board(doc.jobs)`; delete the `MemoryDoc` import. `jobs/state.ts`: the 24 h window and the first-line detail.
- `settings.ts`: `context: { toolResultTokens: number }`, default `{ toolResultTokens: 2000 }`. `README.md:42`: the same.

- [ ] **Step 4: Run everything**

Run: `npm test && npm run typecheck`
Expected: PASS. Also `grep -rn "consolidat" src | grep -v "models.consolidation\|settings.models" ` prints nothing but the model-setting lines, and `grep -rn "loops" src` prints nothing.

- [ ] **Step 5: Commit**

```bash
git add src test README.md
git commit -m "feat(memory): reflect in the background instead of consolidating"
```

---

### Task 2: The reset

**Files:**
- Create: `src/kernel/reset.ts`
- Modify: `src/kernel/boot.ts`
- Test: `test/reset.test.ts` (new), `test/transcript.test.ts`

**Interfaces:**
- Consumes: `unreflectedTurns`, `reflectDelay` and `Daemon.reflect()` from Task 1.
- Produces, in `src/kernel/reset.ts`:
  - `lastExchange(entries: readonly EntryRecord[]): string | undefined` — pure. Ignores entries carrying a `head` (the reset marker and compaction summaries) and every entry that is not `pi.user` or `pi.assistant`. Renders `[Your last exchange]`, then one `user: <text>` line per user entry, then `you: <text>` for the **last** assistant entry with text. Non-text content parts render as `[<type>]`, e.g. `[image]`. Returns `undefined` when neither a user line nor an answer line exists. While the rendered text exceeds 8,000 characters, the middle of the longest line's text is replaced by `[…]` so the whole fits.
  - `resetRoot(harness: Harness, root: Conversation): Promise<boolean>` — reads the newest root entry; returns `false` when there is none or it is a `pi.reset`. Otherwise one commit that returns `false` without writing when `LiveDoc.run !== undefined`, when `InboxDoc.items` holds an item whose `mode` is not `"write"`, or when the newest entry is no longer the one it read; else appends `ResetEntry` with `head: "self"` and, when `lastExchange` gave text, `model: [{ role: "user", content: text, timestamp: now }]`, and returns `true`.
  - `watchResets(harness: Harness, root: Conversation, onReset: () => Promise<void>): Promise<{ stop(): Promise<void> }>` — `harness.watchDoc(LiveDoc, root.id, ctx)`; on every frame whose `run` is undefined it calls `resetRoot` and, when that returns `true`, `onReset()`; errors are swallowed. Idempotent because a committed reset makes the newest entry a `pi.reset`.
- `boot.ts` produces no new `Daemon` members: `close()` stops the watch and clears the quiet timer.

- [ ] **Step 1: Write the failing tests**

Create `test/reset.test.ts` (helpers `route`, `ask`, `texts`, `textOf`, `carryOver` — add `carryOver(daemon)` to `test/helpers.ts`: `waitFor` until the newest root entry has kind `pi.reset`, then return its `model?.[0]` text or `undefined`).

```ts
const entry = (kind: string, message: object | undefined, extra = {}) => ({ id: 1, conversationId: 1, kind, model: message && [message], ...extra });

test("the carry-over is the inputs and the final answer only", () => {
  expect(lastExchange([
    entry("pi.reset", { role: "user", content: "[Your last exchange]\nuser: older" }, { head: 1 }),
    entry("pi.user", { role: "user", content: "fix the build" }),
    entry("pi.assistant", { role: "assistant", content: [{ type: "toolCall", id: "1", name: "read", arguments: {} }] }),
    entry("pi.tool-result", { role: "toolResult", toolName: "read", content: [{ type: "text", text: "FILE" }] }),
    entry("pi.assistant", { role: "assistant", content: [{ type: "text", text: "Done." }] }),
  ])).toBe("[Your last exchange]\nuser: fix the build\nyou: Done.");
});

test("every input of the run is carried over and an image becomes a note", () => {
  // two pi.user entries, the second with content [{ type: "image", data: "...", mimeType: "image/png" }]
  expect(text).toBe("[Your last exchange]\nuser: look at this\nuser: [image]\nyou: Nice.");
});

test("an exchange over 2 000 tokens is cut in the middle of its longest part", () => {
  const text = lastExchange([userEntry("hi"), assistantEntry("y".repeat(20000))])!;
  expect(text.length).toBe(8000);
  expect(text.startsWith("[Your last exchange]\nuser: hi\nyou: yyy")).toBe(true);
  expect(text).toContain("[…]");
  expect(text.endsWith("yyy")).toBe(true);
});

test("a run with neither an input nor an answer has no carry-over", () => {
  expect(lastExchange([entry("pi.reset", undefined, { head: 1 })])).toBeUndefined();
});

test("a settled turn ends with the last exchange, and the next turn sees it", async () => {
  await ask(daemon, "I'm Ada");
  expect(await carryOver(daemon)).toBe("[Your last exchange]\nuser: I'm Ada\nyou: ok");
  await ask(daemon, "What's next?");
  const next = requests.at(-1)!.filter((m) => m.role !== "system").map(textOf);
  expect(next).toEqual(["[Your last exchange]\nuser: I'm Ada\nyou: ok", "What's next?"]);
  expect(systemOf(requests.at(-1)!)).toMatch(/about-you/);
  expect(await texts(daemon.root, "user")).toEqual(["I'm Ada", "[Your last exchange]\nuser: I'm Ada\nyou: ok", "What's next?"]);
});

test("the reset makes no model call", async () => {
  const before = faux.state.callCount;   // one request for the turn itself
  await ask(daemon, "hi");
  await carryOver(daemon);
  expect(faux.state.callCount).toBe(before + 1);
});

test("no reset while the run is still going", async () => {
  // a held faux answer: while it is in flight, resetRoot returns false and appends nothing
  expect(await resetRoot(daemon.harness, daemon.root)).toBe(false);
});

test("no reset while an input is queued", async () => {
  // submit a second input while the first run is held, then release and call resetRoot before the queued run starts
  expect(await resetRoot(daemon.harness, daemon.root)).toBe(false);
});

test("a second reset for the same turn does nothing", async () => {
  await ask(daemon, "hi");
  await carryOver(daemon);
  expect(await resetRoot(daemon.harness, daemon.root)).toBe(false);
});

test("a steered chain resets once, after the chain settles", async () => {
  // submit "first", then a steer "also this" while the first answer is held
  expect(await texts(daemon.root, "user")).toEqual(["first", "also this",
    "[Your last exchange]\nuser: first\nuser: also this\nyou: ok"]);
});

test("a job report resets the context like any other turn", async () => {
  // job_start → job_complete → the report turn
  expect(await carryOver(daemon)).toMatch(/^\[Your last exchange\]\nuser: \[job 1 "Report" done\] /);
});

test("a turn with no answer resets without an answer line", async () => {
  // the faux answer is an abort: submit, then `daemon.root.abort(ctx)`
  expect(await carryOver(daemon)).toBe("[Your last exchange]\nuser: hi");
});

test("reflection runs after the 5th unreflected turn", async () => {
  for (const t of ["1", "2", "3", "4", "5"]) await ask(daemon, t);
  await waitFor(() => reflections.length > 0);
});

test("a long single turn compacts the root instead of overflowing", { timeout: 30_000 }, async () => {
  // kit = testKit({ models: [{ id: "wide", contextWindow: 40_000 }] }); a tool returning 20 000 characters,
  // called 8 times in one turn
  const page = await daemon.root.entries({}, 200, undefined, ctx);
  expect(page.items.some((e) => e.kind === "pi.compaction")).toBe(true);
});
```

In `test/transcript.test.ts`, replace the deleted reset test with:

```ts
test("surfaces keep the whole history and hide the carry-over", async () => {
  // attach a client, ask "before", wait for its reset, ask "after", attach a second client
  const expected = [
    { kind: "user", text: "before" }, { kind: "assistant", text: "ok" },
    { kind: "user", text: "after" }, { kind: "assistant", text: "ok" },
  ];
  await vi.waitFor(() => expect(live.t.lines).toEqual(expected));
  await vi.waitFor(() => expect(later.t.lines).toEqual(expected));
});
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `npx vitest --run test/reset.test.ts`
Expected: FAIL — `src/kernel/reset.ts` does not exist.

- [ ] **Step 3: Implement `src/kernel/reset.ts`**

`resetRoot`'s commit reads `tx.latestHeadMarker(ROOT_CONVERSATION_ID)` and `tx.scanEntries({ conversationId: ROOT_CONVERSATION_ID, minEntryId: marker?.head ?? (1 as EntryId) }, 500)`, reverses the page into oldest-first order and passes it to `lastExchange`; every table read precedes the `appendEntry`. The cut loop in `lastExchange`: with `over = rendered.length - 8000 > 0`, take the longest part, keep `part.length - over - 3` characters split head/tail around `[…]`, and repeat while the rendering is still too long (a part shorter than the cut becomes `[…]`).

- [ ] **Step 4: Wire the watcher in `boot.ts`**

After `harness.resume()`: `const resets = await watchResets(opened, root, afterReset)`, where `afterReset` clears the pending quiet timer, reads `reflectDelay(await unreflectedTurns(opened, root))` and either awaits `reflect()` (delay `0`) or arms `setTimeout(() => void reflect().catch(() => {}), delay).unref()`. `close()` calls `await resets.stop()` and clears the timer before disposing.

- [ ] **Step 5: Run everything**

Run: `npm test && npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/kernel/reset.ts src/kernel/boot.ts test
git commit -m "feat(cos): reset the context after every settled run"
```

---

### Task 3: What the CoS reads from

**Files:**
- Modify: `src/kernel/secret-requests.ts`, `src/kernel/cos.ts`, `src/kernel/identity.md`, `skills/choosing-a-mechanism/SKILL.md`, `skills/writing-job-briefs/SKILL.md`, `docs/superpowers/specs/2026-10-07-japa-design.md` (§7.2–§7.4, §7.6, §9.4 context settings, §15 testing lines)
- Test: `test/secret-requests.test.ts`, `test/content.test.ts`

**Interfaces:**
- Produces: `renderPending(pending: SecretRequest[]): string | undefined` in `src/kernel/secret-requests.ts` — `- <name>: <why>` lines, `undefined` when none; and the `waiting-on-you` section in `japa-cos`, rendered from `SecretRequestsDoc` after `about-you`.

- [ ] **Step 1: Write the failing tests**

In `test/secret-requests.test.ts`:

```ts
test("a pending secret request shows in the waiting-on-you section and goes when fulfilled", async () => {
  const { extension, surface } = probe();   // the existing helper in this file
  const { daemon, faux } = await bootTest({}, [extension]);
  await tool(daemon, faux, "secret_request", { name: "svc.token", why: "to read your calendar" });
  expect(await system(daemon, faux)).toMatch(/waiting-on-you[\s\S]*- svc\.token: to read your calendar/);
  const pending = (await daemon.harness.snapshot(SecretRequestsDoc, ROOT_CONVERSATION_ID, ctx))!.pending;
  await surface().secrets.fulfil(pending[0]!.id, "s3cr3t");
  expect(await system(daemon, faux)).not.toMatch(/waiting-on-you/);
  await daemon.close();
});
```

(`tool` and `system` come from `test/jobs-helpers.ts`.)

In `test/content.test.ts`:

```ts
const PROMISE_RULE = "Never promise anything you have not backed with a mechanism: a job for work now, a schedule for anything later — including following up on something you are waiting for (\"check in about Bob's reply on Thursday\") — or a trigger for \"when X happens\". Your context is cleared after every reply; anything not backed this way is forgotten.";

test("the identity text and the two skills state the promise rule", () => {
  for (const file of [join(packageRoot, "src/kernel/identity.md"),
      join(packageRoot, "skills/choosing-a-mechanism/SKILL.md"),
      join(packageRoot, "skills/writing-job-briefs/SKILL.md")]) {
    expect([file, readFileSync(file, "utf8").includes(PROMISE_RULE)]).toEqual([file, true]);
  }
});
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `npx vitest --run test/secret-requests.test.ts test/content.test.ts`
Expected: FAIL — no `waiting-on-you` section, the promise rule is not in the three files.

- [ ] **Step 3: Implement the section and write the content**

- `renderPending` and the `waiting-on-you` section (omitted when nothing is pending).
- `identity.md`: **The thread** becomes "you see only the current exchange: your context is cleared after every reply, and what matters is kept by mechanisms and memory." **Memory** drops open loops and says reflection happens in the background. Add the promise rule verbatim as its own paragraph after the mechanism ladder, and a sentence that `waiting-on-you` lists the secrets you asked the user for.
- `skills/choosing-a-mechanism/SKILL.md` and `skills/writing-job-briefs/SKILL.md`: add the promise rule verbatim — in the first under the ladder examples, in the second under "Following up".
- Main spec: §7.2's section list becomes identity, capabilities, about-you, jobs, schedules, waiting-on-you, last exchange; §7.3 becomes the event-driven reset (no consolidation trigger, no handoff); §7.4 keeps the fact rules and names the background reflection; §7.6 drops `loops.json`; §9.4 drops the context thresholds; §15 replaces the consolidation and open-loops testing lines with the reset and reflection ones.

- [ ] **Step 4: Run everything**

Run: `npm test && npm run typecheck`
Expected: PASS. Also `grep -rn -i "open loops\|handoff\|resetTokens\|idleResetHours" src skills workers README.md docs/superpowers/specs/2026-10-07-japa-design.md` prints nothing.

- [ ] **Step 5: Commit**

```bash
git add src skills test docs/superpowers/specs/2026-10-07-japa-design.md
git commit -m "feat(cos): waiting-on-you section and the promise rule"
```
