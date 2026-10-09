# japa — explicit job outcomes: `job_complete` and `job_ask`

Date: 2026-10-09
Status: Draft for review
Amends: `2026-10-07-japa-design.md` (the "design spec") §6.4 and §6.5; `2026-10-08-japa-computer-use-design.md`
§ operator instructions (asking the user to finish something in the desktop)

## 1. Purpose

A job's run ends in one of two ways today (design spec §6.4): it calls `job_complete`, and the job is `done`; or it
doesn't, and the job is `needs_input` with the run's last message as its question (`decide()` in
`src/kernel/jobs/run.ts`). The second rule is a guess, and on 2026-10-09 it went wrong on hermes in three ways:

- **Empty questions.** The worker model sometimes ends a turn with no content at all (0 output tokens, finish
  `stop`). Each became a report `[job 11 "…" needs_input] ` with nothing after it: six times across jobs 10, 11 and
  13. Jobs 11 and 13 never did any work; the CoS kept nudging them and told the user they were progressing.
- **Answers taken for questions.** Job 15, already `done`, was steered by the CoS; its reply ("No user input is
  needed now") didn't call `job_complete`, so the job went back to `needs_input`.
- **"Needs input" the user can't act on.** The user saw jobs waiting for input that only the CoS could answer
  (`which directory?`), and the CoS relayed them instead of answering.

Reports themselves are delivered reliably: every report reached the CoS and was answered. The fix is in how a run's
end is classified, not in delivery.

## 2. Behaviour

**States** (`JobStatus`) are unchanged: `queued`, `running`, `needs_input`, `done`, `failed`, `cancelled`.
`needs_input` keeps its meaning elsewhere: a job in it keeps the desktop lock (`extensions/desktop/lock.ts`), is
never pruned, and shows `❓` in `/jobs` and the CoS's jobs board.

**Worker tools** decide how a run ends:

| The run… | The job becomes | Report |
|---|---|---|
| calls `job_complete({ summary })` | `done`, `result` = summary | `[job N "T" done] <summary>` |
| calls `job_ask({ question })` | `needs_input`, `result` = question | `[job N "T" needs_input] <question>` |
| calls `job_progress({ note })` | unchanged (`progress` = note) | none |
| ends with neither `job_complete` nor `job_ask` | stays `running`; the kernel nudges once (§4.2) | none |
| a nudged run ends with neither, with text | `done`, `result` = the text | `[job N "T" done] <text>` |
| a nudged run ends with neither, empty | `failed`, `result` = `the worker ended its turn without a reply` | `[job N "T" failed] …` |

So `needs_input` is set only when a worker explicitly asks. The CoS's `job_message` moves a `needs_input` or `done`
job back to `running`, as it does today.

## 3. Worker tools (`src/kernel/jobs/worker.ts`)

`WorkerExtension` gains `job_ask`, next to `job_progress` and `job_complete`:

- `job_ask({ question: string })` — "Ask the chief of staff one clear question you need answered to continue, and
  end your turn. It answers with a follow-up message." Sets `status = "needs_input"`, `result = question`, and the
  new `asked = true` (§4.1); returns `Asked.` with `control: { terminate: true }`, like `job_complete`.
- A cancelled job is left alone, as `job_complete` already does.
- **One ending per run.** If the run already called `job_complete` or `job_ask` (`completed` or `asked` is set),
  a second ending call changes nothing and returns `This turn already ended with job_complete.` (or `job_ask`). Two
  ending calls in one message are thus resolved by the first.

**Only workers get these tools.** `WorkerExtension` is configured only on job conversations (`agentOf()` in
`src/kernel/jobs/cos.ts`); `registry.install(WorkerExtension)` in `src/kernel/boot.ts` registers its definitions for
durable restore and offers nothing to the CoS. Profiles can't remove the job tools (their `tools.remove` lists only
`CodingTools`). The existing test "the CoS and jobs are offered their own tools" (`test/jobs.test.ts`) asserts
`job_ask` is offered to a job and not to the root, alongside `job_progress` and `job_complete`.

## 4. Kernel (`src/kernel/jobs/run.ts`, `state.ts`)

### 4.1 Data

- `Job` gains `asked?: boolean`: `job_ask` was called in the run not yet reported. It mirrors `completed` (which
  stays as is, including its role in `prune`). Both are cleared when the run's answer is decided.
- `JobRunInput` gains `nudge?: true`: this run delivers the kernel's nudge. Optional, so `JobRun` tasks persisted
  before the change still load; the task's name and version are unchanged.

### 4.2 Deciding a settled run (`decide()`)

Unchanged: a cancelled job or an aborted run reports nothing; an unanswered run sets `failed` and reports; an answer
already in `reported` is skipped, and the answer is pushed to `reported`.

Then, in order:

1. `completed` → clear it; report `done` with `result` (as today).
2. `asked` → clear it; report `needs_input` with `result`.
3. The run was not a nudge → if the job's conversation already has another run or a queued input (`pi.live`'s
   `run`, or a non-write `pi.inbox` item), nothing: that message's turn is decided on its own, and a nudge would
   reach the worker after it. Otherwise **nudge**: in the same commit, create a `JobRun` with
   `{ text: NUDGE, mode: "followUp", nudge: true }`; the job is `running` (a follow-up queued before the previous
   run's `job_complete` or `job_ask` starts with the job `done` or `needs_input`); nothing is reported.
4. The run was a nudge → the answer's text (its text blocks joined, then trimmed) is non-empty: `status = "done"`,
   `result` = the text; empty: `status = "failed"`, `result = "the worker ended its turn without a reply"`. Report.

`NUDGE` = "Your turn ended without job_complete or job_ask. If the job is finished, call job_complete with your
summary. If you need an answer to continue, call job_ask with one clear question. Otherwise, carry on with the job."

Because the nudge task is created in the same commit that records the answer as reported, a restart neither
re-decides the answer nor nudges twice. A message the CoS sends while a nudge is queued or running is a separate
`JobRun` and is decided on its own, as today.

### 4.3 Report text

`reportText()` and the `report:<jobId>:<seq>` request ids are unchanged; `seq` advances only when something is
reported, so a nudge doesn't consume one.

## 5. Instructions

Every place that tells a worker to "end your turn with a question" says to call `job_ask` instead:

- `WORKER_TEXT` (`src/kernel/jobs/worker.ts`): "When finished, call job_complete with a short summary. If you need an
  answer to continue, call job_ask with one clear question."
- `workers/coder.md` (asking for the directory), `workers/general.md` ("ask when you are blocked"),
  `workers/researcher.md` (both search tools need a key), `workers/operator.md` (MFA, CAPTCHAs, anything only the user
  can do).
- `skills/building-workers/SKILL.md` (every worker gets `job_progress`, `job_complete`, `job_ask` and `skill_read`;
  to ask, a worker calls `job_ask`) and `skills/research/SKILL.md` (a worker asks with `job_ask`).

The CoS's identity (`src/kernel/identity.md`, **Jobs and workers**) gains: "A job that asks a question is asking you:
answer it with `job_message` when you can, and ask the user only for what only they can decide or provide. Before
telling the user a job is progressing, check it with `job_list` or `job_transcript`."

## 6. Out of scope

- **The `sudocode` provider's finish reasons.** Its `stopReason()` maps unknown finish reasons (e.g.
  `content_filter`) to `stop`. It is a user-built extension in hermes's workspace (`~/.japa/extensions/sudocode`),
  not in this repo; fix it there separately.
- **Retrying a failed chat send.** `deliver()` in `src/kernel/messaging/surface.ts` saves the cursor past a reply it
  couldn't send. Not seen in this incident; a separate change.
- **Google sign-in from chat.** Separate work.

## 7. Testing (`test/jobs.test.ts`, faux provider)

- `job_ask` → one `needs_input` report with the question; a follow-up that calls `job_complete` → `done`.
- A run that ends with text and no ending tool → no report; the job receives `NUDGE`; then:
  - the nudged run calls `job_complete` → `done` with its summary;
  - the nudged run calls `job_ask` → `needs_input` with its question;
  - the nudged run ends with text → `done` with that text;
  - the nudged run ends empty (an assistant message with no content) → `failed`, `the worker ended its turn without a
    reply`.
- An empty first run is nudged, not reported.
- A `done` job followed up by the CoS that answers with text and no ending tool is nudged, never set to
  `needs_input` (the job 15 case).
- `job_complete` and `job_ask` in one message → the first wins; one report.
- `job_ask` on a cancelled job → still `cancelled`, nothing reported.
- A restart after the nudge is created and before it settles → one nudge, one report.
- The CoS isn't offered `job_ask`; jobs are.
- Existing tests that end a worker's turn with a plain question (`Which repo?`, `Which part?`) switch to `job_ask`.
