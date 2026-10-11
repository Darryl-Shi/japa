# japa: conversation window, recall, profile and scratchpad

Date: 2026-10-11
Status: Draft for review
Extends: `2026-10-08-japa-stateless-cos-design.md`. This spec replaces that spec's carry-over (§2, "last
exchange") and its memory model (§4–§5: facts and episodes). The per-run reset stays.

## 1. Why

On hermes (8–11 Oct, 2,352 root entries, 224 user messages) the CoS lost the thread again and again:

- **Automated inputs replace the user's thread.** The carry-over holds one exchange, and a job report, schedule
  firing, extension event or secret confirmation counts as one. In 57 of the 224 user messages (25%), the user was
  replying within 30 minutes of their last message, but the CoS could only see an automated exchange. Examples:
  - **WhatsApp number.** The user sent their number, then a `[whatsapp] unlinked` event arrived, then the user said
    "new code pls". The CoS replied: "I need your WhatsApp number … I don't have it saved."
  - **Server cleanup.** The user said "jellyfin and maria can go", then job 68's report arrived, then the user asked
    "what's wrong with mariadb and jellyfin". The CoS invented an answer: "you said earlier this month that you'd
    stopped using them". Reflection then saved that invention into an episode.
- **One exchange is too short.** Multi-turn discussions drift after a few turns: Superpowers, then "not asking for
  testing", then the design gaps.
- **Recent turns can't be recalled.** `memory_search` covers only reflected episodes and job results. Reflection
  runs after 5 turns or 15 quiet minutes, so the last few turns are never searchable. The raw transcript is not
  searchable at all.

The memory also drifted from the user to operations. About half of the 18 facts are project or system state:
installed extensions, factory settings, repo commits, file paths, home-lab IPs, the brief schedule. The 78 episodes
read like job logs.

### Goal

The CoS should behave like a long-time human assistant:

- It picks up any thread ("back to the solver", "what did Aung say") without being told.
- It knows the person.
- Each turn stays snappy and clean: open jobs, the conversation at hand and what's relevant, not a polluted rolling
  context.

Success:

- Every replayed failure in §1 resolves: the number is in view, the user's earlier instruction is in view, and the
  complaint is found by recall.
- The CoS never states what the user said or decided unless it can see it or found it.
- The profile holds only things about the user. Project state lives in the scratchpad, and both are capped.
- No model call is added to the turn path.

## 2. The turn context

```
system   identity · capabilities · about-you (profile) · scratchpad (index) · jobs · schedules · waiting-on-you · skills
user     [Conversation so far] … [From earlier] …      ← injected, built once per run
user     the run's input(s)
…        the run's own tool traffic
```

**The reset stays.** When a run settles, `resetRoot` appends a `ResetEntry` (`head: "self"`) as today, with the
same checks: the root is idle, nothing is queued, and the newest entry is the one seen. The `ResetEntry` now carries
**no model content**. `lastExchange` is removed.

**The injected message.** A `beforeRequest` hook on the root's `GenerationTask` (next to the existing tool-result
cap in `cos.ts`) prepends one user message to the run's messages. It is built once per generation task and memoized
with `api.memo("context", …)`, so retries and resumed runs see the same text and the cached prefix stays stable
within a run. It has two blocks, the window (§2.1) and recall (§3). If both are empty, nothing is prepended.

### 2.1 The window: "[Conversation so far]"

**Source.** The root transcript before the run's first input, read across earlier resets. It comes from the
in-process transcript mirror (§3.1), not from the context view.

**Messages.**

- Each user entry is one message. If it starts with an automated label, it is an automated arrival instead. The
  labels are `[job `, `[schedule `, `[secret `, `[japa]` and `[<extension>]`, as reflection already recognises them.
- Each run's assistant text is one `you:` message: the text parts of every assistant message in the run, in order,
  because the user saw all of them.
- Thinking, tool calls, tool results and compaction summaries are left out.

**Boundary: the current conversation.**

- **Current conversation.** It runs back from the run's first input to the first gap of more than **30 minutes**
  between consecutive **user** (`you`) messages, and includes every japa reply and automated arrival after the
  earliest included user message. Automated arrivals never extend or open a conversation. Times come from each
  message's `timestamp`. A message without one takes the time of the input before it.
- **Previous exchange.** If the current conversation is empty (the input arrives after a pause), the window shows
  the last exchange that contains a user message, plus any later automated arrivals as headlines, marked with their
  ages. That way "yes" or "back to that" still resolves after a break, even if a schedule fired in between.
- **Automated runs.** A run whose inputs are all automated gets a window capped at 2,000 tokens instead of 8,000.

**Rendering.** One message per line group, with the role, a relative time and the entry id:

```
[Conversation so far]
you · 41 min ago · #11765: jellyfin and maria can go. it's 192.168.0.32 btw
japa · 41 min ago: I've passed both changes to the server cleanup: …
  did: job_message 68
job 68 report · 38 min ago · #11784: Server 1 cleanup is done: disk use went from 74 GB to 45 GB … (full: job_transcript 68)
japa · 38 min ago: The server cleanup is back, but it only did part of what you asked …
  did: schedule_add (schedule 10)
```

- **Automated arrivals** render as one headline: the first line, up to 200 characters, plus a pointer to the full
  text (`job_transcript <id>` for job reports, `history_read <entry>` otherwise).
- **`did:` lines.** Each `you:` message is followed by a `did:` line listing the run's tool calls that change
  something, as `name` plus the short identifier from its arguments or result: a job id, schedule id, page title or
  change id. Read-only calls are omitted: `read`, `*_list`, `*_get`, `job_transcript`, `history_*`, `page_read` and
  `memory_facts`. The line is capped at 160 characters.

**Budget: 8,000 tokens**, at 4 characters per token.

1. **Newest exchange.** The newest exchange (the last input and the reply after it) is kept up to 2,000 tokens. Its
   longest part is cut in the middle with `[…]`, as `lastExchange` does today.
2. **Older messages.** If the window is still over budget, older messages are shortened, oldest first, to their
   first line (at most 200 characters).
3. **Dropping.** If it is still over budget, the oldest messages are dropped and replaced by one line:
   `[N messages not shown: history_read <first id>]`. The user's first message in the window is dropped last: it
   stays above that line, as its headline if need be. Recall treats only the messages the window renders as in view.

### 2.2 Sections

- **`about-you`.** Renders the profile (§4).
- **`scratchpad` (new).** One line per active page: `- <title> (updated 2 h ago)`.
- **`jobs`, `schedules`, `waiting-on-you`, `skills`, `capabilities`, `identity`.** Unchanged.

## 3. Recall

### 3.1 The transcript mirror and index

`src/kernel/memory/history.ts` keeps an in-process mirror of the root transcript, holding text only:

- user inputs;
- run replies;
- job results from `JobsDoc`;
- scratchpad pages, active and archived;
- legacy episodes (§7).

On top of the mirror sits a BM25 keyword index over the same normalised words `nearDuplicate` uses. It is built by
scanning the stored entries at boot. It is brought up to date with the entries added since the last update before
each run's context is built and before each `history_*` call. Nothing new is stored; it is derived data.

### 3.2 Automatic recall: "[From earlier]"

This is built once per run, together with the window (§2), with no model call.

**Query.** The run's inputs, plus the user messages in the window.

**Candidates.**

- **Corpus.** Everything in the mirror except:
  - entries already shown in the window;
  - the run's own inputs.

  Pages are always candidates: the `scratchpad` section shows only their titles.
- **Scoring.** BM25, multiplied by a recency factor (halving every 14 days). A page hit gets a 1.5× bonus, because
  pages are denser than single messages.

**Job reports.** When an input is a job report or job question, the first hit is always the conversation message
that started that job (`Job.origin`, §3.4), labelled `you asked · <age>`. This needs no search.

**Output.** At most **5 hits within 1,500 tokens**:

```
[From earlier: found by search; may be incomplete]
page "Software factory" · updated 1 d ago: <first 600 characters> (page_read "Software factory")
you · 10 Oct 11:42 · #9846: yeah it's basically that because too much ceremony. spec and discovery …
```

- **Messages** show up to 400 characters around the best-matching passage.
- **Pages** show their first 600 characters.
- **Empty block.** If there are no hits, the block is omitted.

### 3.3 Tools

These replace `memory_search`.

- **`history_search({ query, since?, until? })`.** Up to 10 hits from the whole mirror, ranked as in §3.2 but
  without the window exclusion. Each hit has its date, its kind (`you`, `japa`, job report, page or episode) and
  its id.
- **`history_read({ id, before?, after? })`.** The messages around entry `id`, by default 4 before and 4 after,
  rendered as in §2.1 but with full text, capped at 4,000 tokens.

### 3.4 Job origin

- **`Job.origin?: EntryId`.** `job_start` records the id of the newest root user entry at the time of the call.
  That is the input of the run that started the job.
- **Older jobs.** Jobs created before this change have no origin and skip the deterministic hit.

### 3.5 The rule

`identity.md` "The thread" is rewritten:

> You see the current conversation, and what search found for it. Your context is cleared after every reply.
> Before you say what the user said, decided or prefers, find it: in view, in "From earlier", or with
> `history_search`. If you can't find it, say so. Never reconstruct it.

The promise rule is unchanged.

## 4. The profile ("About you")

**What it is.** A free-form list of short items about the **user**, with no fixed sections:

- who they are;
- people in their life;
- what they're working toward, and why;
- life and interests;
- taste;
- how they like to work with the CoS.

**What stays out:**

- japa's own setup: extensions, models, settings, schedules, jobs;
- file paths, repos, commits, hosts and IPs;
- credentials and contact numbers;
- task status and one-off events;
- a project's internals, which belong in the scratchpad.

**Limits, enforced in `applyProfileOps`:**

- **Item length.** At most 30 words per item, down from 50. Longer items get today's shorten pass.
- **Total size.** `settings.memory.maxFacts` (30) and `settings.memory.maxTokens`, whose default goes from 1,500 to
  **1,000**. Over the cap, today's merge pass runs, then `truncateToCap`.
- **Operational filter.** An add or update is rejected if its text matches any of:
  - a path: `/\S+/\S+` or `~/`;
  - a hex string of 7 or more characters;
  - an IPv4 address;
  - a URL;
  - `\bjob \d+`.

  The rejection says why, so the CoS can rephrase it or put it on a page.

**Writers.**

- **Reflection (§6).** Every reflection add or update on the profile must carry `evidence`: a verbatim quote of at least 3 words
  from a non-automated `user:` line in the batch. The kernel checks that the quote appears and rejects the op if it
  doesn't. A model can then only record what the user actually said.
- **`memory_remember`.** The CoS uses it when the user asks, or when something is clearly lasting about the user. It
  needs no evidence, but the filter and limits apply. `memory_forget` and `memory_facts` are unchanged.

**History.** The profile keeps `updatedAt` on each item. The reflection prompt shows each item's age, so it can
revise stale ones.

## 5. The scratchpad

**Pages.** One page per project or topic:

- Each page has a **title** (its handle, e.g. "Software factory", "Home servers", "LM07") and a **text** in free-form
  markdown.
- The text holds the current state: what it is, decisions and why, where it lives (repos, paths, hosts), what's
  open.
- A page is not a log; the transcript is the log.

**State.** `ScratchpadDoc` (`japa.scratchpad`, on the root):

```ts
type Page = { id: string; title: string; text: string; updatedAt: number; archivedAt?: number };
type Scratchpad = { nextId: number; pages: Page[] };
```

**Tools:**

- **`page_read({ title })`.** Exact title match, case-insensitive. If there is no exact match, it falls back to the
  best `history_search` hit among pages.
- **`page_write({ title, text })`.** Creates the page, or replaces its text. Writing to an archived page makes it
  active again.

**Caps, enforced in code:**

- **Page size: 1,500 tokens.** A write over the cap is refused with "Page too long (N tokens; max 1,500): condense it
  to the current state and write it again."
- **At most 15 active pages.** Creating a 16th archives the active page that was updated longest ago.
- **14 days untouched.** A page not written for 14 days is archived. This is checked at boot and hourly, on the
  existing prune interval in `boot.ts`.
- **90 days archived.** A page archived for 90 days is deleted, on the same check.

**Writers.**

- **The CoS.** It writes during the turn. The identity text tells it to keep a page for any piece of work that spans
  turns, and to update it when a decision is made or the state changes.
- **Reflection (§6).** It fills in what the CoS missed.

## 6. Reflection

**What stays.** `Reflect` keeps its task, its cursor (`reflectedThrough`), its schedule (5 turns, 15 quiet minutes,
boot), its chunking and its failure handling.

**Input:**

- the batch's lines, with automated inputs labelled as today;
- the profile with item ages;
- the active pages in full (at most 15 × 1,500 tokens).

**Output.** One `save` call:

```ts
{
  profile: Array<
    | { op: "add"; text: string; evidence: string }
    | { op: "update"; id: string; text: string; evidence: string }
    | { op: "delete"; id: string }
  >;
  pages: Array<{ title: string; text: string; basedOn?: number }>; // basedOn: the page's updatedAt it was shown
}
```

**Prompt.** It states the profile scope and exclusions from §4, with good and bad examples taken from hermes'
current facts:

- **Good:** "protective of his Claude limits".
- **Bad:** "Factory settings: global defaults plus per-project overrides…".

It also says:

- If the user corrected the CoS later in the batch, the correction is what's recorded.
- Pages record the state the batch reached, not how it got there.

**Commit.** One commit:

- **Profile ops.** Applied with the evidence check (§4).
- **Page writes.** A write whose `basedOn` no longer matches the page's `updatedAt` is skipped, so the CoS's own
  edit made during reflection wins. Writes over the size cap get one shorten pass, as facts do today, and are
  dropped if they're still too long.
- **Episodes.** No episode is written.

## 7. Migration

**`MemoryDoc` version 3:**

```ts
type Memory = {
  nextId: number;
  facts: Fact[];                 // the profile; name kept
  legacyEpisodes?: Episode[];    // v2 episodes, searchable until `legacyUntil`
  legacyUntil?: number;          // the upgrade time + 90 days; the hourly check deletes them after it
  reflectedThrough?: EntryId;
  reflecting?: TaskId;
  sorting?: TaskId;              // the one-time Sort task, live unless terminal
  sorted?: true;
};
```

**From version 2:**

- `episodes` moves to `legacyEpisodes`.
- `upgraded` (the v1 loops notice) is kept if present.

**Sort, a one-time background task, run at boot until `sorted`.** One model call is given the current facts and the
legacy episodes, newest first, fitted to half the consolidation model's context window. It returns:

- **profile ops** under the §4 rules. The evidence check is waived for this pass, because the source is earlier
  facts, not transcript lines.
- **at most 15 pages**, the current state of each project found.

The commit applies the profile ops to `MemoryDoc`, writes the pages to `ScratchpadDoc`, then sets `sorted`. A failure leaves `sorted` unset, and the task runs again at the next
boot.

**Search.** The mirror and index are built from the stored transcript at boot, so the 3 days already on hermes can be
recalled at once.

## 8. Removed

- `lastExchange` and the carry-over in `ResetEntry`.
- `memory_search` and `search()` in `state.ts`; `history_search` replaces them.
- Episodes as written by reflection, and the episode field of `save`.
- The "key people and projects" wording in the reflection prompt.

## 9. Testing

vitest with the faux model and in-memory storage.

**Window:**

- The 30-minute boundary.
- The previous exchange with its age.
- Automated headlines with pointers.
- `did:` lines, with read-only calls omitted.
- The 8k budget: newest exchange kept, older messages shortened before any are dropped, and the dropped-messages
  line.
- Built once per run: the same text on retry, and when a steer joins the run.
- The `ResetEntry` carries nothing.

**Replays of the hermes failures, as fixtures:**

- The WhatsApp number is in view after a `[whatsapp]` event.
- "jellyfin and maria can go" is in view above job 68's report.
- "my complaint about superpowers" is recalled from 10 Oct.

**Recall:**

- Window entries excluded.
- Recency factor and page bonus.
- 5 hits within 1,500 tokens.
- A job report brings `Job.origin`.
- `history_search` with `since` and `until`.
- `history_read` bounds.
- The index catches up on new entries.

**Profile:**

- The operational filter, with each pattern.
- The 30-word limit.
- The 1,000-token cap.
- Evidence check: an invented quote is rejected; a quote from an automated line is rejected.

**Scratchpad:**

- Size refusal.
- The 16th page archives the one updated longest ago.
- 14-day archiving.
- 90-day deletion.
- Writing to an archived page reactivates it.
- A reflection write is skipped when `basedOn` is stale.

**Reflection.** The new `save` shape, with no episodes. Existing cursor, chunking and failure tests carry over.

**Migration:**

- v2 to v3.
- Sort runs once and retries after a failure.
- Legacy episodes are searchable, then deleted after 90 days.

**Content.** The identity text contains the §3.5 rule, the profile/scratchpad split and the page guidance.

## 10. Out of scope

These were seen on hermes and are left for separate fixes.

- **Silent runs on `anthropic-sub`.** The model's turn ended expecting a tool call but held only empty thinking.
  The run settled with no reply and the reset hid it. This happened with "keep an eye on it…" (3 times), "double
  check 400k" and "yo". It is a fix in the workspace extension.
- **The jobs section updating mid-run.** It is recomputed during a run, so the CoS saw job 27, which it had just
  started, as "already running … you'd asked earlier".
- **Jobs have no access to memory.** Job 69 asked the CoS to "look up job 68 in memory". Workers have no recall
  tools.
