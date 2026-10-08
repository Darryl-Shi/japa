# japa — the stateless CoS: event-driven context reset

Date: 2026-10-08
Status: Draft for review
Extends: `2026-10-07-japa-design.md` (the "main spec"), replacing its context-reset and
consolidation design.

## 1. Purpose

The CoS should not need to remember anything in its model context. When it
"leaves" — its run settles — its context is cleared at once, and the next turn
starts from durable state: facts, jobs, schedules, pending secret requests and
searchable history. Today the context resets only when a 60 s timer finds the
CoS idle and its window over 20k tokens or quiet for 2 h, and each reset costs
an LLM call (reflection plus a handoff note).

Success:

- Every settled turn ends with a reset; no LLM call on that path.
- Nothing the CoS needs lives only in its context: every commitment is backed
  by a mechanism, and every fact or episode is written by a background task
  over the stored transcript.
- A short follow-up ("yes, do that") still works.

### Changes to the main spec

- The consolidation trigger, the handoff note, the `open loops` memory and the
  `context.resetTokens` / `context.idleResetHours` settings are removed (§6).
- Memory becomes facts and episodes only; reflection runs in the background (§4).
- The identity text and the `choosing-a-mechanism` and `writing-job-briefs`
  skills gain the promise rule (§3).
- The messaging spec (`2026-10-08-japa-messaging-telegram-design.md`) drops
  `/new` and `root.reset`: every turn already starts fresh.

## 2. The reset

**Event.** The kernel watches the root conversation's `LiveDoc`. When a run
settles (`run` becomes undefined), it commits the reset.

**Commit.** One commit, no model call, which first re-checks that the root is
still idle, that no input submission is queued, and that the newest entry is
the one the watcher saw. If any check fails, it does nothing: the next settle
resets instead. Otherwise it appends a `ResetEntry` (`head: "self"`) whose
model content is the **last exchange**:

```
[Your last exchange]
<inputs>: the input(s) of the run that just settled (user, trigger or report), text only;
          images become their saved-path notes
<you>:    the CoS's final assistant text of that run
```

Tool calls and tool results are dropped. If the exchange exceeds 2,000 tokens
(estimated at 4 characters per token), the middle of the longest part is cut
and marked `[…]`. Steered and follow-up inputs join the run they joined, so a
chain of quick messages resets once, after the chain.

**Next turn.** The model sees the sections (§3), the last exchange and the new
input. Proactive turns (trigger events, job reports, secret confirmations,
rollback and safe-mode notices) reset the same way.

**Long single turns.** Only a single turn with many tool calls can now
overflow. Pi Durable compaction is enabled on the root conversation with its
model-relative threshold (`contextWindow − reserveTokens`), so it scales with
whichever model the CoS uses; the existing tool-result cap
(`context.toolResultTokens`) stays. Compaction summaries are dropped by the
next reset like everything else.

## 3. What the CoS reads from

All derived from mechanisms; the CoS maintains no ledger.

| Section | Source | Content |
|---------|--------|---------|
| `about-you` | kernel memory | facts (unchanged) |
| `jobs` | `JobsDoc` | active jobs (queued, running, needs_input) plus jobs finished in the last 24 h, each with id, title, status and the first line of its progress or result |
| `schedules` | `schedule` extension | unchanged |
| `waiting-on-you` | `SecretRequestsDoc` | one line per pending secret request (new) |

Plus `memory_search` (episodes and job results) and the job tools for full
results.

**The promise rule** (identity text, `choosing-a-mechanism`,
`writing-job-briefs`): *Never promise anything you have not backed with a
mechanism: a job for work now, a schedule for anything later — including
following up on something you are waiting for ("check in about Bob's reply on
Thursday") — or a trigger for "when X happens". Your context is cleared after
every reply; anything not backed this way is forgotten.*

## 4. Reflection

`Consolidate` becomes `Reflect` (`src/kernel/memory/reflect.ts`), a
background task on the root conversation, live at most once.

- **Input.** The stored root entries after `MemoryDoc.reflectedThrough` (an
  entry id; absent means from the start), rendered as text lines as today, plus
  the current facts. Input from automated sources (`[job …]`, `[<extension>]`)
  is labelled as such.
- **Output.** One `save` call: fact operations (add / update / delete, with
  today's 50-word, near-duplicate, shorten and merge rules) and one episode
  summarising those turns. The fact rules in today's prompt stay; the loops and
  handoff parts go.
- **Commit.** Applies the facts, appends the episode and sets
  `reflectedThrough` to the newest entry it read. It never touches the root's
  context, so it doesn't need the root to be idle.
- **When.** After a reset, if at least 5 turns are unreflected; otherwise 15
  minutes after the last reset if any are unreflected (an in-process timer,
  re-armed on every reset); and at boot if any are unreflected. A turn here
  is one reset since `reflectedThrough`.
- **Failure.** A failed or aborted reflection leaves `reflectedThrough`
  unchanged; the next trigger retries the same range, chunked to the
  consolidation model's context window, oldest first.

## 5. State changes

`MemoryDoc` (`japa.memory`, version 2):

```ts
type Memory = {
  nextId: number;
  facts: Fact[];
  episodes: Episode[];
  reflectedThrough?: EntryId;
  reflecting?: TaskId;   // the latest Reflect task, live unless terminal
};
```

Migration from version 1: drop `loops`, `lastResetAt`, `previousResetAt` and
`consolidating`; set `reflectedThrough` to the newest root entry (history
before the upgrade is already consolidated). Open loops from version 1 are
dropped; the upgrade's first CoS turn gets a one-time notice listing them, so
the CoS can turn any that still matter into schedules.

## 6. Removed

- The 60 s `checkConsolidation` timer in `boot.ts`, `Daemon.checkConsolidation`
  and `src/kernel/memory/trigger.ts`.
- The handoff note and `[Notes from before your context was refreshed]`.
- Loops: the `open-loops` section, `Memory.loops`, `LoopOp`, `applyLoopOps`,
  `renderLoops`.
- Settings `context.resetTokens` and `context.idleResetHours` (unknown keys in
  an existing `settings.json` are ignored with a startup notice).
- `board(jobs, since)`'s `previousResetAt` window, replaced by the 24 h rule.

`Daemon.consolidate()` becomes `Daemon.reflect()` (runs Reflect now and waits),
used by tests and `japa check`.

## 7. Testing

vitest with the faux model and in-memory storage, as today.

- **Reset:** happens when a run settles; not mid-run; not while an input is
  queued; a steer or follow-up delays it until the chain settles; a commit
  racing a new input does nothing; the carry-over is exactly the last exchange
  (inputs and final text, no tool calls, image path notes); the 2,000-token
  cut; proactive turns reset; the next turn's model context is sections + last
  exchange + new input.
- **Compaction:** enabled on the root with a model-relative threshold.
- **Reflect:** reads only after `reflectedThrough` and advances it; fires at 5
  turns, after 15 quiet minutes and at boot; a failure leaves the cursor and is
  retried; chunking over a long range; never changes the root context; facts
  rules unchanged (existing tests carried over).
- **Sections:** the `jobs` 24 h window; `waiting-on-you`; no `open-loops`.
- **Migration:** a version 1 `MemoryDoc` upgrades, and the loops notice is
  delivered once.
- **Content:** the identity text and the two skills state the promise rule.
