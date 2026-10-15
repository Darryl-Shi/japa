# japa: job reports and kernel notes are no longer shown as user messages

Status: to build. This is an incremental change to the kernel's surface contract (`SurfaceContext.root.events`), the `webui` surface and the `gateway` surface (`japa chat`). The builder folds it into `docs/spec.md` (the `webui` section and the surface contract) and the README's Web UI section where it describes the transcript.

## 1. Problem

When a background job finishes, the kernel posts its report into the root conversation as an ordinary user input. The content is `[job <id> "<title>" <status>] <text>`, with the publish outcome line appended, and the requestId is `report:<jobId>:<seq>`. The web UI's transcript projection (`extensions/webui/transcript.ts`) turns every `role: "user"` model message into a `user` line. So a job report shows up as a right-aligned grey bubble, as if the person had typed it.

Other inputs the kernel posts take the same path and have the same problem:
- schedule and other trigger wakes (`[<extension>] …`, requestId `trigger:…`);
- `[secret X provided]` / `[secret X declined]` notes;
- `[japa] …` notes: rollback, safe mode, the memory upgrade note;
- sign-in (`connect`) outcome reports.

`japa chat` (the gateway) has the same bug: it prints these lines with the `› ` user prefix.

**Out of scope:**
- What the CoS sees. The model still gets these inputs as user messages with exactly today's content.
- Reply routing (`replies.ts`, `originOf`).
- Telegram. It never echoes inputs.
- The Jobs panel.

## 2. Key technical decisions

### 2.1 The kernel tags each root user entry with its source

The kernel already knows where every root input came from: its submission's requestId. `replies.ts` uses this today to route replies. This change exposes that knowledge to surfaces through the existing events stream. It is an **additive SDK contract change**, so existing listeners keep working unchanged.

- **New exported type in `japa/sdk`** (`src/kernel/contracts.ts`): `InputSource`, one of:
  - `{ type: "person"; surface: string; chat?: string }`. An input submitted by a surface on behalf of a person: a requestId of the form `surface:…`, or no requestId, which is the gateway as in `originOf`.
  - `{ type: "job_report"; jobId: string; title: string; status: string; text: string }`. A job report: requestId `report:<jobId>:<seq>[:<attempt>]`.
    - `title` and `status` come from the report's own header, which the kernel wrote with `reportText`. History therefore stays correct after the job is cleared from the jobs doc.
    - `text` is the report body without the `[job …]` header. It includes the appended publish outcome line, if any.
  - `{ type: "note"; from?: string }`. Any other kernel-posted input: triggers (`from` = the extension name), secret notes, `[japa]` notes, connect reports and any future kernel requestId. The surface shows the entry's text as-is.
- **Classification lives in one kernel function**, next to `originOf` in `src/kernel/origin.ts`. It maps a requestId plus the entry content to an `InputSource`. A `report:` requestId whose content doesn't parse as a report header falls back to `note`.
  - **Header parsing.** It is the inverse of `reportText`. The job title may contain quotes or brackets, so parsing must not break on them. The job id comes from the requestId, not from the text.
  - **Human text is never parsed.** A message a person types that starts with `[job …` is still a `person` input.
- **Delivery.** `SurfaceContext.root.events`' listener gains a second argument: `sources: ReadonlyMap<EntryId, InputSource>`. It holds the source of every root user entry (`UserEntry.kind`) in that batch, whether in a `snapshot` (including the prepended history) or a live `message_end`.
  - A user entry's source is in the **same batch** as the entry. Surfaces never see a user entry first and its source later, so nothing flickers from a bubble to a report block.
  - The kernel resolves sources from submissions, using the commit stream and the submission scan as `watchReplies` does. A user entry with no submission record found counts as `person`.
  - The old one-argument listeners are unaffected.

### 2.2 Web UI

- **Protocol** (`app/src/lib/protocol.ts`). `Line` gains two kinds, and every existing kind keeps its meaning:
  - `{ kind: "report"; jobId; title; status; text }`
  - `{ kind: "note"; text }`

  `kind: "user"` is now produced **only** for `person` sources.
- **Projection** (`extensions/webui/transcript.ts`, via `live.ts`). The projection takes the sources map alongside the events and maps each user entry by its source:
  - `person` → `user` line;
  - `job_report` → `report` line;
  - `note` → `note` line.

  The snapshot/`lines`/`transcript` live updates carry the new kinds unchanged.
- **Rendering** (`Transcript.svelte`).
  - **Job report.** A left-aligned block, clearly distinct from both the user bubble and the assistant's text: a hairline-bordered rounded card in the existing monochrome theme.
    - Its header reads "Job report", then the job title, then a status pill styled like the Jobs panel's (done / failed / needs input / cancelled …).
    - Its body is the report text rendered as markdown, with the same renderer and sanitising as assistant text.
    - A body taller than about 12 lines is clipped, with a keyboard-accessible **Show more** / **Show less** toggle.
  - **Note.** A muted inline note, styled like the existing `info` lines.
- **Optimistic bubbles.** Pending (optimistic) bubbles are settled only against `user` lines, as today. A report or note with the same text never settles a pending message.
- **Empty-state text** ("Replies, tool calls and job reports show up here") is unchanged.

### 2.3 `japa chat` (gateway)

- The gateway surface forwards the sources with the events over its socket protocol (`extensions/gateway/protocol.ts`). Its client-side projection (`extensions/gateway/transcript.ts`) applies the same mapping, and `chat.ts` renders it.
- **Rendering.**
  - A job report prints as a header line `◆ job "<title>" <status>`, followed by its text, without the `› ` prefix.
  - A note prints with a muted `· ` prefix.
  - Only person inputs keep `› `.
- The webui and gateway projections stay independent copies, as today. Extensions don't import each other.

### 2.4 Unchanged

- Submission requestIds and the report text the CoS receives.
- Reply routing.
- Telegram.
- The Jobs panel.
- Sign-in, Host/Origin checks, the CSP.
- Workspace surfaces that ignore the new argument.

## 3. Docs

- `docs/spec.md`:
  - the surface contract (`events` sources, `InputSource`);
  - the webui section's projection and transcript rules: user / assistant / tool / info / **report** / **note** lines, and how each looks.
- The README's Web UI section line about the transcript.
- PROGRESS.md.

## Acceptance behaviours

1. In the web UI, asking the CoS to start a background job and waiting for it to finish shows the report as a left-aligned "Job report" card. The card shows the job's title, a status pill and the report rendered as markdown. No right-aligned grey bubble appears for it. The CoS's reply to the report follows as normal assistant text.
2. Reloading the page (fresh snapshot) shows the same report as the same card, not a bubble. This includes reports older than the active context, and those of jobs since cleared.
3. A message the user types still appears as a right-aligned grey bubble. This holds even when it starts with `[job abc "x" done]`.
4. A message sent from Telegram (or `japa chat`) appears in the web UI as a user bubble, as before.
5. A schedule firing (e.g. a one-off reminder created by asking the CoS) shows its wake text as a muted note, not a bubble. So does providing a requested secret through the secret card (`[secret … provided]`).
6. A report longer than about 12 lines is clipped with **Show more**, which expands it, and **Show less**, which collapses it again. Both work with the keyboard.
7. A failed or stopped job's report card shows that status in its pill. A report whose job's changes went live includes the outcome line in its body.
8. In `japa chat`, the same job report prints as `◆ job "<title>" <status>` followed by its text, with no `› ` prefix. A schedule wake prints with `· `, and typed messages keep `› `.
9. The CoS's behaviour is unchanged: it still receives and answers job reports and notes as before. Telegram's chat shows no new messages.
10. `npm test`, `npm run typecheck` (including `svelte-check`), `japa check extension webui` and `japa check extension gateway` pass. New tests cover:
    - the kernel's source classification (person / job report / note, a human `[job …` text, a title with quotes);
    - the sources map on snapshot and live batches;
    - both projections.
