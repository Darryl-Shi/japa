# Explicit job outcomes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A job's run ends only by an explicit worker tool — `job_complete` (→ `done`) or the new `job_ask`
(→ `needs_input`) — and a run that calls neither is nudged once, then reported `done` with its text or `failed` if empty.

**Architecture:** `job_ask` joins `job_progress`/`job_complete` in `WorkerExtension` and sets a new `Job.asked` flag,
mirroring `completed`. `decide()` in `src/kernel/jobs/run.ts` reports from those flags; otherwise it creates a
follow-up `JobRun` carrying `NUDGE` (input `nudge: true`) in the same commit, and decides a nudged run's plain answer
as `done`/`failed`. Worker profiles, skills and the CoS identity are reworded to match.

**Tech Stack:** TypeScript (Node 24, ESM, `.ts` imports), pi-ai / pi-durable, TypeBox via `Type`, vitest with the
faux provider (`test/jobs-helpers.ts`).

**Spec:** `docs/superpowers/specs/2026-10-09-japa-job-outcomes-design.md`

## Global Constraints

- `JobStatus` is unchanged. `needs_input` is set only by `job_ask`.
- Only job conversations get `job_ask`: it lives in `WorkerExtension` (`src/kernel/jobs/worker.ts`); nothing else
  registers or configures it.
- Exact strings:
  - `job_ask` description: `Ask the chief of staff one clear question you need answered to continue, and end your turn. It answers with a follow-up message.`
  - `job_ask` reply: `Asked.`; second ending call in a run: `This turn already ended with job_complete.` /
    `This turn already ended with job_ask.`
  - `NUDGE`: `Your turn ended without job_complete or job_ask. If the job is finished, call job_complete with your summary. If you need an answer to continue, call job_ask with one clear question. Otherwise, carry on with the job.`
  - Failed reason: `the worker ended its turn without a reply`
  - `WORKER_TEXT`: `You are working on a job for the chief of staff. Report notable progress with job_progress. When finished, call job_complete with a short summary. If you need an answer to continue, call job_ask with one clear question.`
- `JobRun` keeps name `japa.job-run`, version 1; `JobRunInput.nudge` is optional so persisted tasks still load.
- Report text (`reportText`) and `report:<jobId>:<seq>` ids unchanged; `seq` advances only on a report.
- No new dependencies. Code style: 2-space, double quotes, ~120 cols, short why-comments.
- `npx vitest --run` and `npm run typecheck` pass at the end of every task.

## Review Focus

1. **A worker that never calls a tool** (most tests' default `say("ok")`, chatty models) — it gets exactly one nudge,
   then one `done` report with its text; never a second nudge or a loop. Task 2: `nudged run that ends with text`.
2. **A CoS message arriving while the nudge is queued** — each run is decided on its own: the nudge's run and the
   message's run each report once. Task 2: `a message queued behind the nudge is decided on its own`.
3. **A job stopped while its nudge is pending** — stays `cancelled`, reports nothing. Task 2:
   `a job stopped during its nudge stays cancelled`.
4. **Whitespace-only text after the nudge** — counts as empty: `failed`. Task 2: `an empty run is nudged; an empty
   nudged run fails` uses `say("  \n")` for the nudged run.

---

### Task 1: `job_ask` and the `asked` flag

**Files:**
- Modify: `src/kernel/jobs/state.ts` (`Job`)
- Modify: `src/kernel/jobs/worker.ts` (`updateJob`, `jobComplete`, new `jobAsk`, `WorkerExtension.tools`)
- Modify: `src/kernel/jobs/run.ts` (`decide`)
- Test: `test/jobs.test.ts`, `test/jobs-control.test.ts`, `test/availability.test.ts`

**Interfaces:**
- Produces: `Job.asked?: boolean` — "job_ask called in the run not yet reported". `job_ask` tool. `decide()` reports
  `needs_input` from `asked` (Task 2 extends `decide`).

- [ ] **Step 1: Write the failing tests**

In `test/jobs.test.ts`:
- Rename `a job asks a question and resumes on a follow-up` → `a job asks with job_ask and resumes on a follow-up`;
  its brief answer becomes `call("job_ask", { question: "Which repo?" })`. Assertions unchanged
  (`['[job 1 "Clone" needs_input] Which repo?']`, then `done` `cloned`, `seq: 2`).
- In `a follow-up queued before job_complete reports its own answer`, `say("Which part?")` →
  `call("job_ask", { question: "Which part?" })`. Assertions unchanged.
- In `the CoS and jobs are offered their own tools`, add `"job_ask"` to the root's `not.toContain` list and to the
  job's `arrayContaining` list.
- New `job_complete and job_ask in one message: the first ends the turn`:
  ```ts
  // worker answers "Do both" with:
  fauxAssistantMessage([fauxToolCall("job_complete", { summary: "x" }), fauxToolCall("job_ask", { question: "y" })],
    { stopReason: "toolUse" })
  await waitFor(() => idle(daemon));
  expect(await reported(daemon)).toEqual(['[job 1 "Both" done] x']);
  expect((await jobs(daemon))["1"]).toMatchObject({ status: "done", result: "x" });
  expect(await texts(job, "toolResult")).toEqual(["Done.", "This turn already ended with job_complete."]);
  ```

In `test/jobs-control.test.ts`, new `job_ask racing a stop leaves the job cancelled`: copy `job_complete racing a stop
leaves the job cancelled`, with the held answer `call("job_ask", { question: "q" })`; expect statuses `["cancelled"]`
and `reported` `[]`.

In `test/availability.test.ts`, `startPinger`'s default `onBrief` becomes `call("job_ask", { question: "Which one?" })`.

- [ ] **Step 2: Run them to see the new ones fail**

Run: `npx vitest run test/jobs.test.ts test/jobs-control.test.ts test/availability.test.ts`
Expected: FAIL — `job_ask` is not a tool (the job tools test, the one-message test, and the `job_ask` question tests,
which now report `needs_input` with `ok`).

- [ ] **Step 3: Implement**

- `state.ts`: add `asked?: boolean; // job_ask called in the run not yet reported` after `completed`.
- `worker.ts`: `updateJob<T>(api, context, change: (job: Job) => T): Promise<T | undefined>` returns `change`'s result
  (undefined when the job is gone). A helper `ended(job)` returns `"job_complete"` if `job.completed`, `"job_ask"` if
  `job.asked`, else undefined. `job_complete`: cancelled → unchanged; already ended → reply
  `This turn already ended with <ended>.`; else as today. `job_ask({ question: Type.String() })`: cancelled →
  unchanged, reply `Asked.`; already ended → the same refusal; else `status = "needs_input"`, `result = question`,
  `asked = true`, `updatedAt = Date.now()`, reply `Asked.`. Every reply from both tools carries
  `control: { terminate: true }`. Add `jobAsk` to `WorkerExtension.tools`.
- `run.ts` `decide()`: wherever `job.completed = false` is set for a cancelled/aborted/unanswered run, also set
  `job.asked = false`. After the `job.completed` branch: `if (job.asked) { job.asked = false; return reportText(job,
  job.result!); }`. The plain-text `needs_input` fallback stays for now (Task 2 replaces it).

- [ ] **Step 4: Run the tests**

Run: `npx vitest run test/jobs.test.ts test/jobs-control.test.ts test/availability.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Full suite, commit**

Run: `npx vitest --run` → all pass.
```bash
git add src/kernel/jobs test/jobs.test.ts test/jobs-control.test.ts test/availability.test.ts
git commit -m "feat(jobs): job_ask — a worker asks explicitly; one ending per run"
```

### Task 2: Nudge a run that ends without `job_complete` or `job_ask`

**Files:**
- Modify: `src/kernel/jobs/run.ts` (`JobRunInput`, `deliver` phase, `decide`, new `NUDGE`)
- Test: `test/jobs.test.ts`, `test/jobs-control.test.ts`; any test the full suite shows relied on plain-text
  `needs_input`

**Interfaces:**
- Consumes: `Job.asked`, `job_ask` (Task 1).
- Produces: `export const NUDGE: string` (exact text in Global Constraints) from `src/kernel/jobs/run.ts`;
  `JobRunInput = { jobId; conversationId; text; mode: "steer" | "followUp"; nudge?: true }`.

- [ ] **Step 1: Write the failing tests** (`test/jobs.test.ts`, importing `NUDGE` from `../src/kernel/jobs/run.ts`;
  `nudges(job)` = `(await texts(job, "user")).filter((t) => t === NUDGE).length`)

- `a run that ends without job_complete or job_ask is nudged, then completes`: brief → `say("Working on it")`;
  `NUDGE` → `call("job_complete", { summary: "4" })`. Expect `reported` `['[job 1 "Sum" done] 4']`, `nudges` 1.
- `a nudged run can ask with job_ask`: `NUDGE` → `call("job_ask", { question: "Which repo?" })`. Expect
  `['[job 1 "Clone" needs_input] Which repo?']`, status `needs_input`.
- `a nudged run that ends with text reports it done`: brief → `say("partial")`; `NUDGE` → `say("Here is the answer")`.
  Expect `['[job 1 "T" done] Here is the answer']`, status `done`, `nudges` 1.
- `an empty run is nudged; an empty nudged run fails`: brief → `fauxAssistantMessage([])`; `NUDGE` → `say("  \n")`.
  Expect `['[job 1 "T" failed] the worker ended its turn without a reply']`, status `failed`, `nudges` 1.
- `a finished job that answers a follow-up with text is nudged, not asked`: brief → `call("job_complete", { summary:
  "first" })`; CoS `follow` → `job_message` followup `anything else?`; worker on `anything else?` →
  `say("No user input is needed")`; `NUDGE` → `say("Nothing else")`. Expect
  `['[job 1 "T" done] first', '[job 1 "T" done] Nothing else']`.
- `a message queued behind the nudge is decided on its own`: brief → `say("partial")`; `NUDGE` →
  `hold.wait(call("job_complete", { summary: "one" }), signal)`; once `hold.started()`, CoS sends `job_message`
  followup `more` and the test waits until it is queued (as `a steer during a run…` does); worker on `more` →
  `call("job_complete", { summary: "two" })`; release. Expect `['[job 1 "T" done] one', '[job 1 "T" done] two']`,
  `nudges` 1.
- `a restart during the nudge nudges once and reports once` (sqlite storage, like `a job interrupted by a restart…`):
  brief → `say("partial")`; `NUDGE` → `hold.started() ? call("job_complete", { summary: "finished" }) :
  hold.wait(say("lost"), signal)`; close after `hold.started`, boot again, wait for `idle`. Expect
  `['[job 1 "Long" done] finished']`, `nudges` 1.

In `test/jobs-control.test.ts`, `a job stopped during its nudge stays cancelled`: brief → `say("partial")`; `NUDGE` →
`hold.wait(say("x"), signal)`; once started, the CoS calls `job_stop` `1`; wait for `idle`. Expect statuses
`["cancelled"]`, `reported` `[]`.

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run test/jobs.test.ts test/jobs-control.test.ts`
Expected: FAIL — `NUDGE` isn't exported; plain-text runs report `needs_input`.

- [ ] **Step 3: Implement in `src/kernel/jobs/run.ts`**

- `export const NUDGE` (exact text above); `JobRunInput` gains `nudge?: true`.
- `decide(tx, job, settled, nudged: boolean): Promise<Decision>` with
  `type Decision = { report: string } | { nudge: true } | undefined`. The existing early branches return
  `{ report }`/`undefined` as before; then `completed` → report done; `asked` → report needs_input; then
  `!nudged` → `{ nudge: true }` (status stays as is: `running`); else text = the answer's text blocks joined and
  trimmed: non-empty → `status = "done"`, `result = text`; empty → `status = "failed"`,
  `result = "the worker ended its turn without a reply"`; report.
- `deliver`: pass `task.input.nudge === true`. On `{ nudge: true }`, in the same commit:
  `await tx.createTask(JobRun, { jobId, conversationId, text: NUDGE, mode: "followUp", nudge: true }, BACKGROUND)`,
  set `job.updatedAt`, and checkpoint `{ phase: "report" }` with no report (so `seq` doesn't advance).
- Update the `decide` doc comment and the `jobRun` doc comment to describe the nudge.

- [ ] **Step 4: Run the tests**

Run: `npx vitest run test/jobs.test.ts test/jobs-control.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Full suite; fix tests that relied on plain-text `needs_input`**

Run: `npx vitest --run`. A test that fails because a worker's plain-text answer no longer reports `needs_input`:
if the test is about a job waiting for an answer, script the worker with `job_ask`; otherwise update the expectation
to the new outcome (one nudge, then `done` with the text). Don't change what the test is about.
Expected after fixes: all pass.

- [ ] **Step 6: Commit**

```bash
git add src/kernel/jobs/run.ts test
git commit -m "feat(jobs): a run that ends without job_complete or job_ask is nudged once, then done or failed"
```

### Task 3: Instructions

**Files:**
- Modify: `src/kernel/jobs/worker.ts` (`WORKER_TEXT`), `src/kernel/identity.md` (**Jobs and workers**),
  `workers/coder.md`, `workers/general.md`, `workers/researcher.md`, `workers/operator.md`,
  `skills/building-workers/SKILL.md`, `skills/research/SKILL.md`

**Interfaces:**
- Consumes: `job_ask` (Task 1).

- [ ] **Step 1: Reword**

- `WORKER_TEXT`: exact text in Global Constraints.
- `workers/coder.md`: "If the brief doesn't say where to work, don't guess: call `job_ask` with one clear question
  asking for the directory; the chief of staff will answer."
- `workers/general.md`: "Report progress on long jobs, call `job_ask` when you are blocked on a decision, and finish
  with a concise result that states what you did and what you found."
- `workers/researcher.md`: "If both search tools say they need an API key, call `job_ask` with one of those messages
  as your question, so the chief of staff can get the key from the user."
- `workers/operator.md`: "For MFA, CAPTCHAs, payments that need the user's device, or anything else only the user can
  do, call `job_ask` asking the user to finish it in the desktop. Continue when the chief of staff tells you it's
  done."
- `skills/building-workers/SKILL.md`: "Every worker also gets `job_progress`, `job_complete`, `job_ask` and
  `skill_read`. To ask something, a worker calls `job_ask` with one clear question; the chief of staff answers with
  `job_message`."
- `skills/research/SKILL.md`: "…and a worker asks with `job_ask`, passing that message as its question, so the chief
  of staff can."
- `src/kernel/identity.md`, end of the **Jobs and workers** paragraph: "A job that asks a question is asking you:
  answer it with `job_message` when you can, and ask the user only for what only they can decide or provide. Before
  telling the user a job is progressing, check it with `job_list` or `job_transcript`."

- [ ] **Step 2: Verify nothing still says to end the turn with a question**

Run: `rg -n -i "end (your|its|the) turn|ends its turn" workers skills src`
Expected: no output.

- [ ] **Step 3: Full suite and typecheck**

Run: `npx vitest --run && npm run typecheck`
Expected: PASS (profile and skill loading tests parse the edited files).

- [ ] **Step 4: Commit**

```bash
git add src/kernel/jobs/worker.ts src/kernel/identity.md workers skills
git commit -m "docs(jobs): workers ask with job_ask; the CoS answers its jobs' questions itself"
```
