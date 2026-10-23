# japa: current changes

This file carries eight specs, each the contract for its ticket: files in and out of the web UI (run-mvkf4hte-v8wn), job reports and kernel notes no longer shown as user messages (run-mv99v71i-371c), the Web UI section in `japa setup`, web UI Settings, Desktop view and no Status sheet (run-mv82kuec-kxa9), the installer menu (Install / Update / Uninstall, JAPA-4), the `webui` browser chat surface (JAPA-2, since extended with password users, JAPA-5), files in and out (JAPA-1), and Docker hosting (JAPA-3).

# japa: files in and out of the web UI

Status: built. This is an incremental change to the `webui` surface, plus one small additive change to the kernel's surface contract (`InputSource`). The builder folds it into `docs/spec.md` (the `webui` section, the surface contract and the "files in and out" section), the README's Web UI section and PROGRESS.md.

## 1. Problem

The web UI only sends text. Two things are missing:

- **Inbound.** You can't attach a file, even though the kernel's shared conversion (`SurfaceContext.input()`) already handles them. It saves each file under `~/.japa/attachments/<date>/`, extracts PDF text and inlines images when the model has vision. Telegram uses it today.
- **Outbound.** A file the CoS sends with `send_file` shows only as a `📎 <path>` tool line. The browser can't download it.

The display is also wrong. A user entry that carried files holds the kernel's notes in its text: `[file saved to …]`, `[image saved to …]`, inlined PDF text and `(this model cannot see images)`. The web UI shows all of that verbatim in the user bubble, including for files sent from Telegram.

**Out of scope:**
- What the CoS sees. The note format, PDF extraction, image inlining and `send_file`'s behaviour and limits stay as they are.
- Telegram.
- `japa chat`'s rendering. It may ignore the new fields.
- Browsing `outbox/` or `attachments/` as a file manager.
- Reply routing.

## 2. Key technical decisions

### 2.1 Kernel: a person's input carries its typed text and files (additive SDK change)

- **New exported type in `japa/sdk`:** `AttachedFile = { path: string; name: string; mimeType?: string; size?: number }`.
- **`InputSource`'s `person` variant gains two fields:** `{ type: "person"; surface; chat?; text: string; files: AttachedFile[] }`.
  - `text` is what the person typed, with the kernel's file notes, inlined PDF text and the `(this model cannot see images)` line removed.
  - `files` lists the files the kernel saved for that input, in order. It is empty for a plain text input.
  - The existing fields are unchanged. Listeners that ignore the new fields keep working.
- **Where it's computed.** The classifier next to `sourceOf` in `src/kernel/origin.ts` works this out from the entry's content. It is the exact inverse of the notes that `inputOf` (`src/kernel/messaging/attachments.ts`) writes, the same way the job-report header is parsed. The writer and parser live side by side and are tested as a round trip.
  - **Notes.** `[file saved to <path> (<mime>, <size>)]` gives the path, MIME type and size. `[image saved to <path>]` gives the path, with the MIME type guessed from its extension.
  - **PDF text.** The `[PDF text, N pages]` block and its `[Truncated; …]` line belong to the preceding PDF's note and are dropped from `text`. So are the `[PDF has no extractable text]` and `[PDF text could not be extracted: …]` lines.
  - **Failed saves.** A `[file could not be saved: <reason>]` line stays in `text`, so the person sees it.
  - **`name`.** The original (sanitised) name: the saved file name without the kernel's `<message id>-` prefix and any `-<n>` collision suffix. An unnamed file keeps its saved name.
  - **Safety.** A note is recognised only in the trailing note block, where the kernel writes notes. Its path must be absolute and inside `<home>/attachments/`. Anything else typed by a person (e.g. a fake `[file saved to /etc/passwd …]`) stays plain text and produces no file.
  - **Images.** Image parts in the content (vision models) are not themselves listed. Their `[image saved to …]` notes are.
- Delivery is unchanged: the same `sources` map on `root.events`, in the same batch as the entry.

### 2.2 Web UI: sending files

- **Composer.** A paperclip button opens the file picker, which allows several files. Files can also be dropped anywhere on the chat page (with a visible drop overlay) or pasted from the clipboard (e.g. a screenshot).
  - Chosen files show as removable chips above the text field, each with its name and size, and a thumbnail for images.
  - A message may be files only. Send is enabled when there is text or at least one file.
- **Limits.**
  - At most 10 files per message.
  - At most 50 MB in total per message (matching `send_file`'s outbound cap).
  - The client checks both before uploading and says which limit was hit. The server enforces them again.
- **Transport.** A file message is one `multipart/form-data` `POST /api/submit` with fields `text`, `mode` and `id` (as today) and one `file` part per file. Each part's file name and `Content-Type` become the `IncomingFile`'s `name` and `mimeType`, with `application/octet-stream` when absent.
  - **Where it's handled.** The surface's own request pipeline (`extensions/webui/server.ts`) handles it, after the Host/Origin checks and the session gate and ahead of SvelteKit. adapter-node's default 512 KB body limit would otherwise refuse it.
  - **Body reading.** The body is streamed with a hard cap. A `Content-Length` over the cap, or a body that exceeds it, gets 413 with a short message.
  - **Errors.** Malformed multipart, too many files and a bad `mode`/`id` get 400.
  - **Text-only messages** keep today's JSON body, with no behaviour change.
- **Conversion and submit.** The surface calls `ctx.input([{ id, text, files }])`, then `ctx.root.submit(input, mode, { surface: "webui", chat: "web", id })`. The client's message id therefore names the saved files.
  - **Retries.** A retry with an id the surface has already accepted (remembered in memory for the process's lifetime) returns success without saving the files again.
  - **Mode.** Steer while busy and follow-up otherwise, as for text.
- **Feedback.** While uploading, the composer shows progress (bytes sent) and Send is disabled. A failed upload puts the text and the file chips back and shows the error as an info line.
- **Optimistic bubble.** It shows the typed text plus the file chips. It settles against the `user` line with the same text and the same file names in order.

### 2.3 Web UI: showing and downloading files

- **Protocol** (`app/src/lib/protocol.ts`):
  - New `FileView = { id: string; name: string; mimeType: string; size?: number }`. `id` is an opaque, stable reference: the entry id plus the file's index. **The host path never reaches the browser.**
  - The `user` line gains `files?: FileView[]`. Its `text` is the source's typed `text`.
  - New line `{ kind: "file"; file: FileView; caption?: string }` for each successful `send_file` result. It replaces today's `📎 <path>` tool line. The `⚙ send_file` chip stays.
- **Projection.** `transcript.ts` / `live.ts` build these lines.
  - **Lookup table.** The hub keeps a server-side table from each `FileView.id` to its host path, MIME type and name. The table covers the files in its current projection: a person's input's `files`, and each successful `send_file` result's recorded `OutgoingFile`.
  - A snapshot rebuilds the table.
  - A user entry without a source, or with an older-style source without files, projects as today.
- **Download endpoint:** `GET /api/files/<id>` (session required, like every other `/api/*`).
  - **Lookup.** It resolves `<id>` only through the hub's table. An unknown id gets 404.
  - **Reading.** The file is read from disk at request time and streamed.
  - **Upload paths.** Paths of a person's uploads must still resolve, via realpath, inside `<home>/attachments/`, or the response is 404.
  - **Missing files.** A file that no longer exists gets 404 with `<name> no longer exists on japa's host`.
  - **Headers.** Every response sends `X-Content-Type-Options: nosniff`, the strict default CSP (`default-src 'none'`) and `Content-Disposition` with the name (RFC 5987 `filename*`, plus an ASCII fallback). `Cache-Control: private`.
  - **Inline types.** Only raster images (jpeg, png, gif, webp) and `application/pdf` are served with their MIME type and `inline`. `?download=1` forces `attachment`.
  - **Everything else** (including HTML, SVG, XML and JavaScript) is always `attachment`, as `application/octet-stream`, so no uploaded or sent file can run script on the web UI's origin.
- **Rendering** (`Transcript.svelte` and a shared file-chip component, in the existing monochrome theme):
  - **User bubble.** The typed text, then one chip per file: an icon by type, the name and size, as a link that downloads it. Image files show a small thumbnail (`<img src="/api/files/<id>">`, allowed by the existing `img-src 'self'`).
  - **A file the CoS sent.** A left-aligned hairline card with an icon (or an image preview, capped in height), the name and size, the caption rendered as markdown (same renderer and sanitising as assistant text), and a **Download** button. Images and PDFs also get **Open**, which opens them in a new tab.
  - **A failed download** (404) shows the server's message as an info line rather than navigating away.
  - **The same files everywhere.** Files from any surface appear the same way: Telegram uploads show as chips in the web UI, and every `send_file` result shows as a card whatever the turn's origin. Telegram delivery of `send_file` is unchanged.
- **Unchanged:**
  - sign-in and sessions, Host/Origin checks and the page CSP;
  - the live stream's shape for existing line kinds;
  - the gateway and Telegram;
  - `send_file`'s limits and the `replies` stream (the web UI shows files from the transcript, not from `replies`).

## 3. Docs

- `docs/spec.md`:
  - the surface contract (`InputSource.person`'s `text`/`files`, `AttachedFile`);
  - the webui section (composer attachments, limits, `POST /api/submit` multipart, `GET /api/files/<id>` and its serving rules, the new line kinds);
  - the files-in-and-out section's "japa chat"/surfaces paragraph.
- README Web UI section: attaching files (button, drag-and-drop, paste, limits) and downloading files the CoS sends.
- PROGRESS.md.

## Acceptance behaviours

1. In the web UI, attaching a PDF with the paperclip, typing "summarise this" and pressing Enter shows a right-aligned bubble reading "summarise this" with a chip naming the PDF and its size. The bubble contains no `[file saved to …]` or PDF text. The file is saved under `~/.japa/attachments/<today>/` and the CoS answers about its contents.
2. Dropping an image onto the page, or pasting a screenshot, adds a chip with a thumbnail. Sending it with no text works: the bubble shows the image thumbnail, and a vision model describes the image.
3. Clicking a chip in a user bubble downloads the original file with its original name. The bytes are identical to what was uploaded.
4. Selecting 11 files, or files totalling over 50 MB, is refused in the composer with a message naming the limit. A crafted request over the cap gets 413 and nothing is saved or submitted.
5. Asking the CoS to send a file (e.g. "make me a CSV of … and send it to me") shows a file card with its name, size, caption and a Download button. Download saves the file with the right name. No `📎 <path>` line appears.
6. A file the CoS sends that is an image shows a preview in its card. A PDF opens in a new tab with Open.
7. A sent `.html` or `.svg` file downloads as an attachment and never renders on the web UI's origin. The response has `Content-Type: application/octet-stream`, `Content-Disposition: attachment` and `nosniff`.
8. Deleting a sent file on the host and then clicking Download shows "<name> no longer exists on japa's host" as an info line.
9. `GET /api/files/<id>` without a session gets 401. An id not in the transcript gets 404. No API response or page contains a host path for a file.
10. Typing `[file saved to /etc/passwd (text/plain, 1 KB)]` as a message shows it as plain text in the bubble, with no chip and no downloadable file.
11. A document sent from Telegram appears live in an open web tab as a user bubble with a downloadable chip, not as raw note text. Reloading the page shows the same.
12. Two open tabs both show an upload and a sent-file card live. After a daemon restart, the cards and chips are still there and still download.
13. Sending a text-only message behaves exactly as before. Retrying a file upload with the same message id doesn't create a second submission or save duplicate files.
14. `npm test`, `npm run typecheck` (including `svelte-check`) and `japa check extension webui` pass. New tests cover:
    - the note writer/parser round trip (names, collisions, unnamed files, PDFs with inlined/truncated text, failed saves, the no-vision line, a forged note);
    - the multipart endpoint (limits, 413, retries);
    - the download endpoint's lookup and headers;
    - the projection's new lines.

## Implementation notes (builder)

- **Parser**: `parseNotes(home, text, messageId?)` in `src/kernel/messaging/attachments.ts`, beside `inputOf`;
  `sourceOf(requestId, text, home)` calls it for a person's input (the message id from the `surface:…:<id>` requestId);
  `watchSources(harness, storage, home)`. The note block is found as the earliest line from which the rest of the text
  parses entirely as notes (a file note with optional PDF tail, an image note, a failed save), then the optional
  no-vision line; only notes whose path is absolute, normalised and inside `<home>/attachments/` start an item. A
  `-<n>` collision suffix is stripped from the name only when the un-suffixed sibling exists, so `draft-2.docx`
  keeps its name; a name of digits only (`7-2.txt`) reads as unnamed. Sizes from notes are the rounded human size;
  the web UI reads an upload's exact size from disk.
- **Web UI daemon side**: `extensions/webui/files.ts` (`serveFile`, `submitMultipart`, `contentDisposition`), called
  from `server.ts`'s pipeline after the session gate. The multipart body cap is 50 MB + 1 MB of framing; it is
  buffered (≤ 51 MB) and parsed with undici's `Request.formData()`. A refused body is drained for up to 5 s so the
  client reads the 413. Accepted ids are remembered per process (module level). The hub's file table
  (`Transcript.files`, `FileView.id` = `<entry id>-<index>`) is rebuilt by every snapshot.
- **App**: `lib/files.ts` (pure helpers, tested against the kernel's `humanSize`/`sanitiseName`), `lib/download.ts`
  (HEAD check, then a temporary `<a download>`; Open opens the tab inside the click), `FileChip`, `FileCard`,
  `FileIcon`; uploads go by `XMLHttpRequest` for progress. The page CSP's `img-src` gains `blob:` for local thumbnails.

---

# japa: job reports and kernel notes are no longer shown as user messages

Status: built. This is an incremental change to the kernel's surface contract (`SurfaceContext.root.events`), the `webui` surface and the `gateway` surface (`japa chat`). The builder folds it into `docs/spec.md` (the `webui` section and the surface contract) and the README's Web UI section where it describes the transcript.

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
  - `{ type: "person"; surface: string; chat?: string; text: string; files: AttachedFile[] }`. An input submitted by a surface on behalf of a person: a requestId of the form `surface:…`, or no requestId, which is the gateway as in `originOf`. `text` is what the person typed (the kernel's file notes, inlined PDF text and the no-vision line removed; a failed save's line kept) and `files` the files saved for it (`AttachedFile = { path; name; mimeType?; size? }`), parsed from the trailing note block by `parseNotes`, the inverse of `inputOf` (added by the files-in-and-out-of-the-web-UI spec above).
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

## Implementation notes (builder)

- **Classification:** `sourceOf(requestId, text)` in `src/kernel/origin.ts`. A `report:` header is parsed after the
  prefix `[job <jobId> "` (the id from the requestId) up to the first `" <status>]` followed by a space or the end,
  with `<status>` one of the job statuses; a title holding `" done] ` itself would therefore split early (accepted:
  titles are short labels). `trigger:<extension>:…` gives `from`. Anything unparsed is a `note`.
- **Delivery:** `src/kernel/sources.ts` (`watchSources`): one per `root.events` call. It records the root's input
  submissions from the commit stream after a scan, and when a batch holds a user entry it hasn't seen, it re-reads the
  submissions once before delivering that batch (so the source is always in the entry's batch). An entry still
  without a record is a person's (`sourceOf(undefined)`: the gateway, as `originOf`).
- **Web UI:** `JobReport.svelte` (card, clipping past 12 lines plus one line of slack; tabbing into a clipped link
  expands it), `StatusPill.svelte` (the Jobs panel's pill, now shared), `lib/jobs.ts` (status labels; an unknown
  status shows with `_` as spaces). Notes reuse the `info` line style.
- **Gateway:** the `events` socket message gains `sources` as `[entryId, source]` pairs (optional, so an old client
  or server degrades to today's lines). `lineText` in `extensions/gateway/transcript.ts` renders a line; a note is
  dimmed with ANSI `2m`.
- Tests: `test/sources.test.ts` (classification; sources on snapshot and live batches through a real daemon),
  `test/webui-live.test.ts` and `test/transcript.test.ts` (both projections, the gateway end to end),
  `test/webui-app-jobs.test.ts`.

---

# japa: a "Web UI" section in `japa setup`

Status: built. An incremental change to japa's `japa setup` rerun menu.

## 1. Purpose

The web UI (`webui` extension) is on by default and ships with japa. It has several settings: whether it's on, the address it listens on, its port, and extra host names. Today none of these has a home in `japa setup`. Every `extensions.webui` setting is optional and its only secret is generated, so `configurable()` leaves it out of the Integrations step. You can only change them by editing `settings.json`, through Telegram `/settings` → Extensions, or by asking the CoS.

This change adds a dedicated, top-level **Web UI** section to `japa setup`'s rerun menu. It shows how the web UI is currently set up and lets you change each setting with guided choices instead of raw values.

**Out of scope:**
- **Authentication.** The `webui.token` secret, sign-in and sessions are being replaced by user auth in another ticket. This section neither shows nor regenerates the token, and must not depend on the token mechanism.
- **Other settings surfaces.** Telegram `/settings` keeps exactly its current behaviour, and so do the web UI app and the CoS's settings tools.
- **The `webui` extension.** Its manifest, settings schema, defaults, runtime behaviour and status line are unchanged.
- **Non-interactive setup.** `--non-interactive` gets no new env vars.

## 2. Key technical decisions

### 2.1 Where it lives
- **Rerun menu.** The `japa setup` rerun menu (`models.cos` already set) gains an item, **Web UI**, with the hint "the browser chat: on/off, address, port, host names". It goes after "Integrations" and before "Background service". The order becomes: Model and sign-in, Integrations, Web UI, Background service, Done.
- **First run is unchanged.** Its closing summary already prints `japa status`, which includes the `webui` line with the URL. There is no new first-run step.
- **Integrations and `--whats-new` are unchanged.** `webui` still doesn't appear in the Integrations multiselect, because it has nothing to set up.
- **Code location.** The section lives in `src/cli/` as its own module (e.g. `webui-step.ts`), next to `models-step.ts`. It drives the existing `Prompter`, so the existing fake-prompter tests can script it.
- **Missing extension.** If no extension named `webui` is loaded in the setup context (for example, removed from a fork), the item still shows. Choosing it prints `The web UI extension isn't installed.` and returns to the menu.

### 2.2 What the section does
- **Overview.** On entry it shows an overview box with:
  - the state (`on` / `off`);
  - the address(es) to open (§2.3);
  - `bind`, `port` and `hosts`, each with `(default)` when unset;
  - a one-line note: "In a Docker instance, the host port and address are set by the installer (`--webui-port`, `--webui-bind`); keep these at their defaults there."

  This note is plain text shown everywhere. There is no container detection: the no-container-code-paths rule holds.
- **Menu.** A select loop follows, offering:
  - **Turn off** / **Turn on**, depending on the current state;
  - **Listen address**;
  - **Port**;
  - **Host names**;
  - **Reset to defaults**;
  - **Done**.

  Each change is saved straight away. The overview is shown again after every change, and Done returns to the rerun menu.
- **Turn off** writes `extensions.webui.enabled: false`. **Turn on** removes the `enabled` key. The other items stay available while it's off.
- **Listen address** is a select:
  - "This machine only" → `127.0.0.1`, the default. Choosing it removes `bind`.
  - One entry per non-internal IPv4 address from `os.networkInterfaces()`, labelled with its interface. An address in `100.64.0.0/10`, or on an interface named `tailscale*`, is labelled "Tailscale".
  - "All addresses (0.0.0.0)". Choosing it first asks for confirmation with a warning that the UI is plain HTTP, so it should only be exposed on trusted networks.
  - "Other…": a text prompt that accepts an IP literal (`node:net` `isIP`), re-asking otherwise.

  The current value is preselected. A current value that isn't in the list appears as its own entry.
- **Port** is a text prompt, prefilled with the current value or 7337. It accepts an integer from 1 to 65535 and re-asks otherwise. A blank answer, or 7337, removes `port`.
- **Host names** is a text prompt: a comma-separated list, prefilled with the current names. Each entry is trimmed and lower-cased. It must be a DNS name with no scheme, port, path or spaces, and must not be an IP literal (IPs are always accepted anyway). Any invalid entry re-asks and names it. Duplicates are dropped. A blank answer removes `hosts`.
- **Reset to defaults** asks for confirmation, then removes `bind`, `port`, `hosts` and `enabled` from `extensions.webui`.
- **Saving.**
  - Every write goes through the user settings file (`readUserSettings` / `setPath` / `saveSettings`). It touches only `extensions.webui`, and keeps any other keys there.
  - It is validated with `validateExtensionSettings` against the extension's own schema, as `configureExtension` does.
  - Removing the last key leaves `extensions.webui` as `{}` or removes it; either is fine.
- **Restart.** A change counts as "saved" for the rerun loop. As with the other items, if the service is active when setup finishes, the rerun's existing "Restarting japa to apply the changes." step restarts it. No other restart logic is added.

### 2.3 The address shown
This is a pure function of the settings and the network interfaces, computed by the wizard. It doesn't need the daemon.
- **Off:** `off — turn it on to use it`.
- **Bound to a specific address:** `http://<bind>:<port>`, with IPv6 in brackets.
- **Bound to `0.0.0.0` (or `::`):** `http://127.0.0.1:<port>`, plus `http://<addr>:<port>` for each detected non-internal IPv4 address.
- **Host names:** each name in `hosts` adds `http://<name>:<port>`.

## 3. Docs
- **README.**
  - The Web UI section's Settings bullet says you can change them with `japa setup` → Web UI, besides `settings.json`, `/settings` and the CoS.
  - The setup paragraph ("The wizard covers models, sign-in, integrations and the service") mentions the Web UI section.
- **`docs/spec.md` and PROGRESS.md** are updated.

## Acceptance behaviours

1. With a configured japa (`models.cos` set), `japa setup` shows the menu items in this order: Model and sign-in, Integrations, Web UI, Background service, Done.
2. Choosing Web UI on a fresh settings file shows `on`, `http://127.0.0.1:7337`, and `bind`/`port`/`hosts` marked as defaults, plus the Docker note. The token is not shown anywhere in the section.
3. Choosing Port and entering `8080` writes `"port": 8080` under `extensions.webui` in `~/.japa/settings.json`. The overview then shows `http://127.0.0.1:8080`. Entering `70000` or `abc` re-asks without saving.
4. Choosing Listen address lists "This machine only", each detected LAN/Tailscale IPv4 address with its interface, "All addresses (0.0.0.0)" and "Other…".
   - Picking a LAN address writes `bind` to it.
   - Picking "All addresses" warns about plain HTTP and asks for confirmation first, and the overview then lists `127.0.0.1` and every detected address.
   - Under "Other…", `not-an-ip` is refused.
5. Entering `Japa.Example.Corp, foo.lan` under Host names writes `"hosts": ["japa.example.corp", "foo.lan"]`. `http://x:1`, `10.0.0.1` and `a b` are each refused by name. A blank answer removes `hosts`.
6. Turn off writes `"enabled": false`, and the overview shows the web UI as off. Turn on removes the key. After the restart, `japa status` shows the `webui` line, or doesn't, to match.
7. Reset to defaults, once confirmed, removes `bind`, `port`, `hosts` and `enabled`, and leaves every other setting in `settings.json` untouched.
8. With the service active, changing the port and then choosing Done prints "Restarting japa to apply the changes.". Afterwards the web UI answers on the new port, and `japa status` shows the new URL.
9. Entering the section and choosing Done without changes writes nothing and doesn't restart the service.
10. First-run setup, `--non-interactive` and `--whats-new` behave as before, and the Integrations step still doesn't list `webui`.
11. `npm test` and `npm run typecheck` pass. New tests drive the section through the fake prompter.

## Implementation notes (builder)

- Code: `src/cli/webui-step.ts` (`webuiStep`, plus pure helpers `webuiAddresses`, `localAddresses`, `parsePort`,
  `parseHosts`); `src/cli/setup.ts` adds the menu item. `SetupOptions.interfaces` injects `os.networkInterfaces()`
  for tests. Tests: `test/setup-webui.test.ts`.
- The overview is one `Prompter.box` titled "Web UI": `State`, `Open` (one or more URLs), `bind`, `port`, `hosts`
  (each `(default)` when unset), then the Docker note.
- Choosing a value equal to the current one writes nothing (and so doesn't count as saved for the restart).
- Saving validates `extensions.webui` against `settingsSchema(e)` (the extension's schema plus `enabled`), like
  `configureExtension`; an invalid hand-edited key there is reported and nothing is saved.
- Removing the last key leaves `extensions.webui` as `{}`.
- Host names: each comma-separated entry must be dot-separated DNS labels (`[a-z0-9]`, inner `-`, up to 63
  characters, 253 in all), after trimming and lower-casing; empty entries are ignored. Reset's confirmation
  defaults to No, as does the 0.0.0.0 warning.
- The listen-address select labels each detected address with its interface in the label itself, e.g.
  `192.168.1.20 (eth0)` or `100.101.102.103 (Tailscale, tailscale0)` (clack only shows hints under the cursor).
- Typing `0.0.0.0` or `::` under "Other…" asks the same plain-HTTP confirmation as "All addresses".

---

# japa: web UI Settings, a live Desktop view, and no Status sheet

Status: built. This is an incremental change to the `webui` surface (see the `webui` spec in `docs/spec.md`), with one small kernel seam and one small addition to the `desktop` extension. The builder folds it into `docs/spec.md` (in the `webui` section) and the README's Web UI section.

## 1. Purpose

The web UI is a chat app with a Jobs panel and a Status sheet. This change makes it the consumer's control panel:

1. **Settings.** A full Settings area in the web UI. It covers what a re-run of `japa setup` covers (model and provider sign-in, integrations) and what Telegram's `/settings` and `/update` cover (models, extensions, schedules, general settings, recent changes, update).
2. **No Status sheet.** The Status sheet and its top-bar button are removed. Settings now carries that information: the model, each extension's state and status line, and errors.
3. **Live desktop view.** A Desktop panel shows japa's desktop live. It is view-only by default, with a **Take control** toggle for mouse, keyboard and clipboard.

First-run setup is **out of scope**. The daemon still needs `models.cos` to boot, and `japa setup` in a terminal (or `--non-interactive`) remains the only first-run path. The web UI's Settings acts on a running, already set-up japa. `japa setup`, `japa status`, Telegram's `/status`, `/settings` and `/update`, and `japa chat` are unchanged.

## 2. Key technical decisions

### 2.1 Kernel seam: an admin context for packaged surfaces

A surface gets only `SurfaceContext` today, which can't change settings. The kernel's settings operations already exist as the kernel-internal `MessagingContext` that drives Telegram's menus. This change exposes a subset of them, plus provider and extension sign-in, as a new optional member:

- `SurfaceContext.admin?: AdminContext`, exported from `japa/sdk`. It is set **only for surfaces of packaged extensions** (those shipped in japa's checkout, `extensions/`). Workspace surfaces (written by jobs) get `undefined`.
- `AdminContext` uses the same code paths as the Telegram menu and the CoS's tools, so validation, change logging, availability recomputation and live reload behave identically:
  - `settings()`: the live merged settings, read-only.
  - `setSetting(path, value)`: as `MessagingContext.setSetting`. Returns the reply, `Not changed: …` when the value is invalid.
  - `extensions()`: the `ExtensionInfo` list (state, status line, error, secrets set or not, schema, values).
  - `setSecret(extension, name, value)`: as `MessagingContext.setSecret`.
  - `rollback(extension)`, `changes()`, `undoChange(id)`, `clearFinishedJobs()`.
  - `tool(name, args)`: for the schedule tools, as `MessagingContext.tool`.
  - `update`: `check`, `current`, `start`, `state`, as `MessagingContext.update`.
  - **Providers.**
    - `providers()`: each provider with models, giving its id, name, whether a credential is stored (`oauth` / `api_key` / none), whether it offers sign-in (label, subscription or not), and whether it takes an API key.
    - `models(provider)`: the models it can use, refreshed when the provider supports it, as setup's model step does.
    - `login(provider, "oauth" | "api_key", interaction: AuthInteraction)`: runs pi-ai's login on the daemon's `models` and stores the credential in the secrets store exactly as `japa setup` does.
  - `authorize(extension, interaction: AuthInteraction)`: runs an extension's `authorize` hook (e.g. Google) with the given interaction, then recomputes availability. It returns the outcome text.
- **Concurrency.** One sign-in at a time per provider and per extension. Starting a second one is refused with a message.
- Nothing else in the kernel changes. In particular, boot still requires `models.cos`.

### 2.2 Web UI server: Settings API

- **Bridge and endpoints.** The `WebuiBridge` (`app/src/lib/protocol.ts`, the surface↔app contract) gains the Settings operations. They are backed by `ctx.admin` and exposed as same-origin JSON endpoints under `/api/settings/…`, `/api/update/…` and `/api/signin/…`.
  - The session gate, Host check and Origin check apply as for every other endpoint.
  - Invalid input gets a 4xx with `{ error }`. A kernel reply such as `Not changed: …` is returned to the UI and shown inline.
  - If `ctx.admin` is missing, the Settings endpoints answer 503 and the UI says Settings is unavailable.
- **Sign-in flows (provider login and extension authorize)** are server-side flow objects. Each is an id, the events so far (`auth_url`, `device_code`, `info`, `progress`), the current prompt if any (`select` with options, `text`, `secret`, `manual_code`, with message and placeholder), and finally the outcome.
  - The tab that started a flow follows it live. It shows links (opened in a new tab, `rel="noopener noreferrer"`), device codes and notes, and renders each prompt as a form. `secret` prompts use a password field.
  - **Answers, cancel and timeout.** Answers are POSTed. Cancel aborts the flow's signal, which stops pi-ai's local callback server. A flow with no answer for 10 minutes is cancelled.
  - **Remote browsers.** When the browser isn't on japa's host, the OAuth loopback callback can't reach japa. The UI then always offers the paste-the-redirect-URL/code field (pi-ai's `manual_code`), as over SSH today.
  - **Privacy.** Answers to `secret` prompts and typed secret values are sent once in a POST body. They are never echoed, logged, kept in client state after submit, or put in the transcript.
- **No live sync for Settings.** Settings data is fetched when a screen opens and again after each action. Other tabs see changes the next time they open the screen. The chat, Jobs and secret prompts stay live as today.

### 2.3 Settings area (UI)

The **Settings** area is opened from a gear button in the top bar. On wide screens it is a full-page view with a section list on the left. On narrow screens it is a full-screen sheet with a list that drills into sections, with Back. Its sections:

- **Overview** (the landing section).
  - The CoS model.
  - Any errors (what the Status sheet showed under errors), each naming its extension.
  - A one-line count of extensions on, off and not set up.
- **Models.**
  - CoS, Worker and Memory upkeep (`models.cos`, `models.worker`, `models.consolidation`). Worker and Memory read "same as CoS" when unset and offer "Use CoS model".
  - Each is changed by picking a provider (only connected providers that have models), then a model. The current choice is ticked.
  - Job thinking (`jobs.thinking`) is picked from the thinking levels.
- **Providers (sign-in).**
  - Every provider with models, featured ones first (the same order as setup), each marked connected (sign-in or API key) or not.
  - Per provider: **Sign in with …** when it offers sign-in (a flow, §2.2), **Enter API key** when it takes one (a masked field), and **Replace** when one is already stored.
  - A model can only be picked for a provider that is connected. The Models picker links here when the wanted provider isn't connected.
- **Extensions (integrations).**
  - Every extension, showing name, summary, a state pill (on / off / not set up / error), its status line and any error. This replaces the Status sheet's extension list.
  - Each extension's screen offers:
    - its declared secrets, each "set" / "not set", with a masked field to set one;
    - **Sign in** for extensions with an `authorize` hook (a flow);
    - its settings, generated from its schema:
      - boolean → switch;
      - enum / `anyOf` consts → select;
      - integer / number → number field;
      - string → text field;
      - arrays and objects → a JSON field;
      - `owner` shown read-only;
    - **Turn off / Turn on**;
    - **Roll back to last known good** for workspace extensions, behind a confirmation.
  - Each change shows the kernel's reply inline.
  - Turning **webui** itself off, or changing its `bind`/`port`, first asks for confirmation, warning that this page may stop working.
- **Schedules.** The list (paused ones marked), each schedule's text, its repeat (cron) or once time, and its next run. Pause / Resume, and Remove with confirmation. "No schedules." when empty.
- **General.** The same settings as Telegram's General screen, each an editable field showing its current value:
  - `jobs.maxConcurrent`, `jobs.keepFinishedDays`;
  - `memory.maxFacts`, `memory.maxTokens`;
  - `safety.toolErrorThreshold`, `safety.goodAfterMinutes`;
  - `context.toolResultTokens`.

  There is also **Clear finished jobs**, with confirmation.
- **Recent changes.** The newest 10 logged changes (title, age), each with its detail and **Undo** behind confirmation.
- **Update.**
  - **Check.** **Check for updates** shows "up to date (sha)", or the incoming commits (the newest 20 and a count of the rest) with the number of active jobs.
  - **Update now.** Starts the update, after a confirmation saying japa will restart. The update is started with chat `{ adapter: "webui", chat: "web" }`.
  - **Restart.** The page goes to its existing "reconnecting…" state while japa restarts.
  - **Outcome.** The section always shows the last recorded update: running (since when), updated, up to date, or failed with its summary and output. A finished, non-rollback update offers **Roll back** to its `from` commit, behind a confirmation.
  - **While running.** While an update runs, starting another is refused with the kernel's message.

Theme, motion, accessibility and responsiveness follow the existing web UI rules (monochrome, hairline borders, rounded, keyboard-accessible, phone width, reduced motion).

### 2.4 Removing Status

- `StatusSheet`, the top bar's Status button, `GET /api/status` and `WebuiBridge.status` are removed.
- Its information now lives in Settings: the model and errors in Overview, extension states and status lines in Extensions.
- `japa status` and Telegram `/status` are unchanged.
- The top bar now has: the `japa` wordmark, the connection/busy indicator, **Jobs**, **Desktop** and **Settings**.

### 2.5 Live desktop view

**Proxy, not a direct link.**
- The web UI server proxies the desktop's noVNC websocket. The browser connects to a same-origin websocket endpoint (e.g. `/api/desktop/ws`).
- The server checks the session cookie, the Host header, and that the `Origin` matches (the defence against cross-site websocket hijacking). It then opens a connection to the desktop's websockify (port 6080 on the desktop's bind address, `127.0.0.1` when that is `0.0.0.0` or unset) and pipes bytes both ways.
- This works wherever the web UI works (SSH tunnel, Tailscale, a Docker instance's published web UI port) without exposing 6080. In a Docker instance the desktop's noVNC is on the container's loopback, so there is no container-specific code.
- Closing the panel, signing out, or the surface stopping closes the proxied connections.

**Desktop → webui handoff.**
- The `desktop` extension publishes a small process-global handle at `Symbol.for("japa.desktop.view")`, the same pattern as the webui bridge. It is set in `setup` and cleared on dispose.
- The handle provides:
  - the noVNC target (host, port);
  - the VNC password (the `desktop.vncPassword` secret);
  - a status (ready, or starting/building/failed with the desktop's status text);
  - `start()`, which calls `ready(true)` in the background.
- The webui reads the handle per request and imports nothing from `desktop`. With no handle (desktop off or not loaded), the panel says the desktop isn't available and points to Settings → Extensions.

**Password.** An authenticated, `Cache-Control: no-store` endpoint gives the panel the VNC password and status when it opens. The user never types the password.

**Client.**
- A bundled noVNC client (`@novnc/novnc`, a root dependency; nothing is loaded from other origins), scaled to fit the panel.
- It connects only while the Desktop panel is open, and reconnects on its own after a drop or a daemon restart.
- The CSP's `connect-src` allows the same-origin websocket.
- x11vnc already runs `-shared`, so several tabs, and the CoS's own tools, can use the desktop at once.

**Interaction.**
- The panel opens **view-only**: no mouse or keyboard events are sent.
- A **Take control** toggle enables mouse, keyboard and scrolling. While on, the panel is clearly marked "You're in control", and the toggle reads **Stop controlling**. Toggling is per tab, and resets to view-only whenever the panel is reopened.
- In control mode, a **Paste** field sends text to the desktop's clipboard, and text copied on the desktop is shown for copying.
- There is no locking against the CoS: the user and the CoS can act at the same time, as with noVNC today.

**Layout.**
- On wide screens the Desktop panel docks to the right of the chat, which stays usable (the chat column narrows).
- On narrow screens it is a full-screen sheet.
- A **Full screen** button uses the browser's fullscreen API.
- When the desktop isn't ready, the panel shows its status text (e.g. "Building the desktop's image…", or the Docker error), and a **Start desktop** button when it isn't running.

### 2.6 Unchanged

The following stay as they are:
- the chat, Jobs panel, secret card, sign-in, sessions, Host/Origin rules and CSP (beyond the websocket allowance);
- Telegram's menus;
- `japa setup`;
- the desktop container and its noVNC on port 6080;
- the installer and the Docker instance layout.

## 3. Docs

- **README Web UI section.** Covers the Settings area and what it covers (and that first-run setup is still `japa setup`), the Desktop panel (view-only, Take control, works through the web UI's address) and the removal of the Status sheet.
- **README Desktop section.** Mentions the web UI's Desktop panel next to the noVNC URL.
- **`docs/spec.md`.** The builder updates the `webui` section, including the new endpoints in `protocol.ts`, the `AdminContext` seam and the desktop view handle.

## Acceptance behaviours

1. The web UI's top bar shows Jobs, Desktop and Settings, and no Status button. `GET /api/status` no longer exists (404). `japa status` and Telegram `/status` still work as before.
2. Settings → Overview shows the current CoS model. With an extension failing to load, its error appears there, naming the extension.
3. Settings → Models: changing the CoS model to another connected provider's model takes effect for the next chat message without a restart. The change appears in Settings → Recent changes and in `~/.japa/settings.json`. Undo there restores the previous model.
4. Settings → Providers: entering an API key for an unconnected provider marks it connected, and its models become pickable in Models. The key never appears in the page, the transcript or the logs.
5. Settings → Providers → "Sign in with …" for an OAuth provider shows a link (and a code, for device-code providers). Completing sign-in in another tab, or pasting the redirect URL/code into the field shown, marks the provider connected. Cancel stops the flow, and a second concurrent sign-in for the same provider is refused.
6. Settings → Extensions lists every extension with its state and status line (what the Status sheet used to show). Setting Telegram's bot token there brings Telegram to "on" without a terminal. Turning an extension off hides it from the CoS, and turning it back on restores it.
7. An invalid setting value (e.g. a string for `jobs.maxConcurrent`) is shown as `Not changed: …` inline, and nothing changes in `settings.json`.
8. Turning off `webui` from its own Extensions screen first asks for confirmation that warns the page may stop working.
9. Settings → Schedules shows a schedule created by asking the CoS. Pausing it shows it as paused, and Remove (after confirmation) removes it. Settings → General edits `jobs.maxConcurrent` and the new value shows.
10. Settings → Update shows "up to date (sha)" on an up-to-date checkout. With incoming commits it lists them. Update now (after confirmation) restarts japa, the page shows "reconnecting…" and recovers, and the section then shows the update's outcome with a Roll back button.
11. With the desktop running, opening Desktop shows the live desktop within a few seconds without asking for a password. While view-only, clicking and typing in it has no effect on the desktop.
12. Turning on Take control lets the user click, type and paste text into the desktop. The panel is marked "You're in control". Closing and reopening the panel returns it to view-only.
13. Asking the CoS to open a website shows the browser moving in the open Desktop panel live.
14. The Desktop panel works when the web UI is reached through an SSH tunnel to port 7337 only, or through a Docker instance's published web UI port, with port 6080 not reachable from the browser.
15. Without a session cookie, the desktop websocket endpoint and the password endpoint are refused (401). A websocket upgrade with a foreign `Origin` is refused.
16. With the desktop extension turned off, the Desktop panel says the desktop isn't available and points to Settings. While the desktop image is building, the panel shows the building status instead of an error.
17. On a phone-width screen, Settings and Desktop open as full-screen sheets and are usable. The browser's network tab shows no requests to other origins.
18. `npm test`, `npm run typecheck` (including `svelte-check`) and `japa check extension webui` pass, and `japa check extension desktop` still passes.

## Implementation notes (builder)

- **Kernel**: `AdminContext`, `ProviderInfo`, `ModelInfo` in `src/kernel/contracts.ts` (exported from `japa/sdk`, with
  `ExtensionInfo`, `Change`, `UpdateCheck`, `UpdateState`, `liveness`); built by `src/kernel/admin.ts` over the same
  `MessagingContext` the Telegram menu uses. `kernel(extension)` gives it to a surface unless the extension was loaded
  from the workspace (`<home>/extensions`); extensions handed to `boot` in code (tests) count as packaged.
  `admin.tool` runs only `schedule_*` tools. `ExtensionInfo` gained `signIn` (has an `authorize` hook). Setup's
  provider order (`FEATURED`), `deviceId` and error `describe` moved to `src/kernel/credentials.ts`, shared with
  `japa setup`. Sign-ins to an extension from Settings and from the CoS's `connect` tool share one lock.
- **`japa check extension <packaged>`** run in japa's checkout loads the extension in place (its relative imports of
  `src/` resolve only there); others still load from a fresh cached copy.
- **webui server**: `extensions/webui/settings.ts` (the `SettingsBridge` over `ctx.admin`), `flows.ts` (sign-in flows:
  the newest open prompt is shown, so pi-ai's `manual_code` paste field is always visible during an OAuth sign-in; a
  typed API key answers the login's first `secret` prompt and is never in the view; 10 min idle → cancelled; finished
  flows kept 5 min), endpoints under `app/src/routes/api/{settings,update,signin,desktop}` (all `no-store`).
  The full endpoint list is in `protocol.ts`. `GET /api/status` and `WebuiBridge.status` are gone.
- **Desktop proxy** (`server.ts` `desktopProxy`, the HTTP server's `upgrade` listener): `/api/desktop/ws` only; Host
  (403), same `Origin` (403), session (401), desktop loaded (503); then it forwards the upgrade to
  `<target>/websockify` without the cookie, Origin or Referer and pipes bytes. Open connections are closed when the
  surface stops, when the panel's socket closes, and when their session stops being valid (rechecked every 30 s,
  against the current users and session key, so `passwd`, `remove` or a new session key ends them). The page CSP's `connect-src` gets `ws://<host>` added by
  `hooks.server.ts`.
- **Desktop handle** (`extensions/desktop/index.ts`): turning the desktop off (`extensions.desktop.enabled: false`)
  hides it from the CoS but doesn't unload it, so the handle has `enabled()`; the web UI treats a turned-off desktop as
  absent (`{ available: false }`, Start 404, the websocket 503), and its `start()` does nothing. `state()` is building / failed / ready (the last start
  succeeded) / starting (a start in flight) / stopped. `GET /api/desktop` generates the VNC password if it's unset.
- **UI**: `Settings.svelte` + `components/settings/*` (one per section, `SchemaField`, `SignInFlow`),
  `DesktopPanel.svelte` (noVNC loaded on open, view-only by default, reconnect with backoff), `ConfirmDialog.svelte`.
  Settings is a full page from 760 px, a sheet below; the Desktop panel docks from 1000 px. While reconnecting, the
  page probes `GET /api/update` to tell a lost session (401) from a restarting daemon. Leaving a sign-in screen
  mid-flow cancels the flow.
- An update started from Settings is recorded with chat `{ adapter: "webui", chat: "web" }`; no messaging adapter
  reports it, the Update section shows its outcome.
- Signing out (the top bar's Sign out) clears that browser's cookie; `japa webui users passwd`/`remove` end a user's
  sessions, and a new session key ends everyone's.
- `scripts/run.sh` (the dev run script, not the product) writes a starter `settings.json` (the CoS on
  `anthropic/claude-sonnet-4-5`, no credentials) when the home has none, so a fresh checkout boots and a provider can be
  connected from Settings. The kernel still refuses to boot without `models.cos`.

---

# japa: installer menu with Install / Update / Uninstall

Status: built. This is an incremental change to japa's bootstrap installer (`install.sh`).

## 1. Purpose

Today `curl -fsSL …/install.sh | sh` installs japa, or upgrades an install that's already there. The only way to remove japa is `japa uninstall [--purge]`, which needs a working `japa` on the PATH.

With this change, running the installer in a terminal first shows a menu: **Install**, **Update**, **Uninstall** (plus Quit). You choose the action there, not with a command-line flag. Uninstall works whether the install is healthy or broken: half-finished, a missing or wrong Node, broken `node_modules`, or no launcher.

`japa uninstall` itself is unchanged.

## 2. Key technical decisions

### 2.1 The first menu
The menu is plain POSIX sh. Node may not exist yet, so it can't use clack. It is drawn on the terminal and read from `/dev/tty`, so it works under `curl | sh`. It appears after the platform check and before anything else happens. Install-specific steps (the prerequisites check, cloning, Node) run only after **Install** or **Update** is chosen.

```
==> japa installer (<dir>)
  1) Install
  2) Update
  3) Uninstall
  4) Quit
Choose [N]:
```

- **Header.** It names the install dir: `--dir` / `JAPA_INSTALL_DIR`, default `~/.local/share/japa`, canonicalised as today. When japa is already installed there (`<dir>/app` is a japa checkout), the header also says `installed`.
- **Default.** Enter picks the default: **Update** when installed, **Install** otherwise.
- **Input.**
  - Any input other than 1–4 or Enter re-asks.
  - EOF or Ctrl-C quits with nothing done and exit status 0. Ctrl-C at the menu exits 130.
  - **Quit** exits 0 with nothing done.
- **Actions that don't fit the install's state.** These print a line and show the menu again:
  - **Install** when already installed: `japa is already installed at <dir>; choose Update`.
  - **Update** when not installed: `no japa install at <dir>; choose Install`.
  - **Uninstall** when nothing at all is there (no `app/`, no japa `node/`, no launcher pointing at `<dir>/app`): `no japa install at <dir>`.
- **A foreign `app/`.** If `<dir>/app` exists but isn't a japa checkout, the existing refusal (`… isn't a japa checkout; remove it or choose another --dir`, exit 1) happens before the menu, and nothing is touched.

**When there's no menu.** The menu appears only when a controlling terminal can be opened (the existing `has_tty` probe) and `--non-interactive` isn't given. Otherwise the script behaves exactly as today: a fresh install, or the upgrade path when already installed. Scripted and CI installs keep working, and uninstall is never chosen without a person at the terminal.

**Flags.** No action flag is added. The existing flags keep their meanings:
- `--dir` chooses the install the menu acts on;
- `--branch` and `--repo` apply to Install and Update;
- `--no-service` and `--skip-setup` apply to Install;
- `--non-interactive` now also means "no menu".

### 2.2 Install and Update
- **Install** runs today's fresh-install path unchanged: prerequisites, clone, node, dependencies, build, launcher, then setup, with the same cleanup-on-failure trap and messages.
- **Update** runs today's upgrade path unchanged: write the launcher first if it's missing or points elsewhere, then `japa update`, forwarding `--branch` only when it was given, and exit with its status.

### 2.3 Uninstall
After **Uninstall** is chosen:

1. **Removal prompt.** The script prints what will be removed (the service, the launcher if it points here, `<dir>/app`, japa's `node/`) and asks `Uninstall japa from <dir>? [y/N]`. Anything but `y`/`yes` returns to the menu.
2. **Data prompt.** It asks `Also delete your data in <home> (settings, secrets, memory)? [y/N]`, where `<home>` is `$JAPA_HOME`, or `~/.japa` when that's unset. A yes means purge. The typed `delete` confirmation that follows comes from whichever mode runs in step 3 (`japa uninstall --purge`'s own prompt, or install.sh's equivalent). Any other answer there keeps everything: `purge cancelled; nothing was removed`, exit 0.
3. **Mode.** The script then delegates to the installed japa when it can, and falls back to removing things in shell when it can't (see below). There is one source of truth for the removal rules, `src/cli/uninstall.ts`. install.sh only re-implements them for the fallback.

**The probe: can the checkout run?** This is decided once, before anything is removed:
1. `<dir>/app` must be a japa checkout (the existing `is_japa_checkout` check).
2. A runner must be found, tried in this order:
   - the launcher, when it points at `<dir>/app` (`launcher_points_here`);
   - otherwise `<dir>/node/bin/node`, when it carries `.japa-node` and is Node ≥ 24;
   - otherwise a system `node` ≥ 24.

   A Node runner is used as `<node> --disable-warning=ExperimentalWarning <dir>/app/src/cli/main.ts`, exactly what the launcher execs.
3. `<runner> --version` must exit 0. This loads `main.ts`'s whole import graph, so it also catches broken dependencies.

**Delegated mode.** When the probe passes, the script prints `==> Uninstalling with japa uninstall` and runs `<runner> uninstall`, adding `--purge` if you chose to delete data.
- stdin comes from `/dev/tty`, and the environment is passed through unchanged.
- The script exits with that command's status. It never runs the fallback after a delegated run, so nothing is acted on twice.

**Fallback mode.** When the probe fails, the script prints `==> japa can't run from <dir>; removing it directly`, then mirrors `uninstall.ts`, in order:
1. **Purge confirmation.** Only if you chose to delete data: `Type "delete" to permanently remove <home>`. Any other answer prints `purge cancelled; nothing was removed` and exits 0.
2. **Service.** If `systemctl` exists, it runs `systemctl --user disable --now japa` and ignores failure. It removes `${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/japa.service`, then runs `systemctl --user daemon-reload` and ignores failure.
3. **Launcher.** `~/.local/bin/japa` is removed only if it points at `<dir>/app`.
4. **Install dir.** It removes `<dir>/app` and `<dir>/node`, but `node/` only if it carries `.japa-node`. It removes `<dir>` only if it is then empty.
5. **Data.** If purging, it removes `<home>` and prints `removed <home>`. Otherwise it prints `kept <home>`.
6. **PATH line.** It names any of `~/.bashrc`, `~/.zshrc` or `~/.config/fish/config.fish` that still holds install.sh's PATH line, and never edits them.

In fallback mode, the steps after the confirmation are best-effort. A failed step is reported, the remaining steps still run, and the exit status is non-zero if any step failed.

**Safety in uninstall.**
- The prerequisites check (git, tar, curl/wget) is skipped, since uninstalling needs none of them.
- The install `cleanup` trap is not armed.
- The script stays wrapped in `main()` (truncated-download safety), and `sh -n` must accept it.

### 2.4 Tests
- **Where.** `test/install-sh.test.ts` drives the menu against the mini-japa fixture. It gives the script a pseudo-terminal, or an overridable tty path used only by tests (in the same spirit as `JAPA_NODE_DIST`), so answers can be scripted. It uses a temporary `HOME`/`XDG_CONFIG_HOME`/`JAPA_HOME` and a fake `systemctl` on PATH that records its calls.
- **Delegated mode.** It's observed through the fixture's `main.ts` `uninstall` stand-in. The real `uninstall.ts` stays covered by `test/uninstall.test.ts`.
- **Fallback mode.** It's exercised by breaking the probe, for example by removing `node_modules`.
- **No-terminal path.** The existing tests keep passing unchanged.

## 3. Docs
- **README Install section.** It describes the menu: what each choice does, the default, and that there's no menu without a terminal or with `--non-interactive`.
- **README Updating and Uninstall sections.** They mention re-running the installer and choosing Update or Uninstall, next to `japa update` / `japa uninstall`. They also note that the installer's Uninstall works even when japa itself can't run.
- **Script and specs.** The install.sh header comment, `docs/spec.md` and `PROGRESS.md` are updated.

## Acceptance behaviours

1. **Menu on a fresh machine.** Running `curl -fsSL …/install.sh | sh` in a terminal shows a menu with Install, Update, Uninstall and Quit, naming the install dir, with Install as the default. Pressing Enter installs japa exactly as before, including setup.
2. **Menu on an installed machine.** Running it again on that machine shows the menu marked `installed`, with Update as the default. Enter runs `japa update`.
3. **Mismatched choices.** On a fresh machine, choosing Update says `no japa install at <dir>; choose Install` and shows the menu again. On an installed one, choosing Install says it's already installed and shows the menu again.
4. **Quit.** Choosing Quit, or closing input, exits without changing anything.
5. **Uninstall on a healthy install.** Choose Uninstall, answer `y`, then `N` to deleting data. It prints `Uninstalling with japa uninstall`. The service is disabled and its unit file removed, and `~/.local/bin/japa`, `<dir>/app` and japa's `<dir>/node` are gone, along with `<dir>` once it's empty. `~/.japa` remains, and the output says it was kept.
6. **Declined removal.** Choose Uninstall and answer `N` to the removal prompt: the menu returns and nothing is removed.
7. **Uninstall with data.** Choose Uninstall, answer `y` to both prompts, then type `delete`: `~/.japa` (or `$JAPA_HOME`) is also removed. Typing anything other than `delete` prints `purge cancelled; nothing was removed`, and everything is still there.
8. **Broken install.** With `<dir>/app/node_modules` deleted, or no usable Node 24, Uninstall prints `japa can't run from <dir>; removing it directly` and still removes the service unit, the launcher pointing here, `app/` and the marked `node/`. It keeps `~/.japa` and exits 0.
9. **Other people's files survive.** A launcher pointing at another install, an `npm link` symlink, a `node/` without `.japa-node`, and extra files under `<dir>` are all left untouched, and `<dir>` is then kept.
10. **Foreign `app/`.** If `<dir>/app` isn't a japa checkout, the script refuses before the menu, exits 1 and touches nothing.
11. **PATH line named.** If install.sh had added a PATH line to `~/.bashrc`, the uninstall output names that file and leaves it unchanged.
12. **No terminal.** Without a terminal (CI, `curl | sh` with no tty), or with `--non-interactive`, no menu appears. The script installs fresh, or updates an existing install, exactly as before, and never uninstalls.
13. **Checks pass.** `sh -n install.sh`, `npm test` and `npm run typecheck` pass.

## Implementation notes (builder)

Decisions made while building, within the spec above:

- **Tty override for tests**: the undocumented env var `JAPA_INSTALL_TTY` (default `/dev/tty`). It is opened once on
  fd 3 and used for the menu, the uninstall prompts, and the stdin of `japa setup` and the delegated `japa uninstall`.
- **Menu header** when installed reads `==> japa installer (<dir>, installed)`.
- **Foreign `app/`**: the refusal now happens right after the platform check, before the prerequisites check, in all
  modes (menu or not).
- **EOF at any uninstall prompt** (removal, data, `delete`) counts as "no".
- **Fixture**: the mini-japa fixture gained a local `file:` dependency (`mini-dep`) that `main.ts` imports, so deleting
  `node_modules` breaks the probe, and an `uninstall` stand-in in `main.ts` for observing delegated mode. `mini-dep.d.ts` types it for `npm run typecheck`.
- **Setup's stdin** after a menu Install is the same fd 3 (setup only runs when the menu could be shown).
- **With Docker hosting (JAPA-3).** The menu comes first, before the Docker/native question. "Installed" means a
  native install at `<dir>` (unless `--mode docker`) or, failing that, the Docker instance `<name>` (unless `--mode
  native`); with only an instance the header reads `==> japa installer (<dir>; Docker instance <name> installed)`.
  **Install** then asks the mode question (unless `--mode` is given; Enter: Docker), **Update** upgrades the existing
  install in its own mode (§4.1/§4.4), and **Uninstall** acts on the native install at `<dir>` only (a Docker instance
  is removed with `japa --instance <name> uninstall`, which the menu mentions). The foreign-`app/` refusal is skipped
  with `--mode docker` (which ignores `--dir`); there the menu's Uninstall still only ever acts on an `app/` that is a
  japa checkout, so a foreign one is never touched. The menu and its prompts are written to the terminal (fd 4 on
  `/dev/tty`), so they stay visible with stdout redirected. The "replace the Docker launcher?" question is asked only after a
  native Install/Update is chosen, never before the menu. After the menu, every terminal read (mode, Sysbox and
  launcher questions, setup in either mode) goes through fd 3. The fallback removes the launcher only when it is
  `~/.local/bin/japa`, as `uninstall.ts` does.

---

# japa: `webui`, a browser chat surface

Status: approved for build. This is an incremental change to japa. The builder folds it into `docs/spec.md` and the README.

## 1. Purpose

Right now you can talk to japa through `japa chat`, a terminal UI (the `gateway` surface), or through a messaging adapter (Telegram). This change adds a third way, on by default: a **web UI**. It is a packaged extension, `webui`, that serves a minimal, clean chat app from the daemon. Its look borrows from openui.com: monochrome, airy and rounded.

The change is theme only. It uses no generative UI and no OpenUI Lang, and the CoS's prompt and behaviour don't change. The web UI is a peer of `japa chat` and replaces nothing: the gateway, Telegram and every other extension behave exactly as before.

## 2. Key technical decisions

### 2.1 A `surface`, running inside the daemon
- `webui` is a packaged extension at `extensions/webui/`. Its manifest `name` is `webui`, its summary is "Chat with japa in your browser", and it provides one `surface`.
- It is a surface rather than a messaging adapter, for the same reason the gateway is. It shows the whole root conversation: user turns from any surface, the CoS's replies streamed token by token, tool-call markers, proactive messages and job reports. It also shows the live jobs list and pending secret requests, takes Stop, and shows status.
- It uses only `SurfaceContext` (`root.submit/abort/events`, `jobs`, `secrets.pending/fulfil/decline`, `status`) plus the `KernelContext` it gets in `setup` (`settings()`, `secret()`). It imports only from `japa/sdk`, and needs no kernel change.
- Inputs are submitted with origin `{ surface: "webui", chat: "web" }`. The kernel routes replies the way it already does, so a web turn's reply does not go to Telegram. Each submission carries a unique `id` (generated by the client and kept across retries), so a resubmission is a no-op. While the CoS is busy, Enter sends with mode `steer`; otherwise it sends with `followUp`, as `japa chat` does.
- The HTTP server is the surface's own Node `http` server, started in `start()` and closed by its dispose. The dispose also ends every open live stream. Nothing runs as a separate process.

### 2.2 Framework: SvelteKit with adapter-node, mounted in-process
- The app is a SvelteKit project in `extensions/webui/app/`. It uses Svelte 5 and `@sveltejs/adapter-node`.
- Its build output goes to `extensions/webui/build/`, which is git-ignored.
- The surface imports the build's exported `handler` on `start()`, never at module top level, and mounts it on its HTTP server. This keeps the extension's `index.ts` importable, and so passing `japa check` and the loader's validation, in a checkout or sandbox with no build.
- The surface hands its live context to the app through a process-global bridge, keyed by a well-known `Symbol.for(...)`. It sets this on every `start()`, so a reload rebinds it. In SvelteKit, a `hooks.server.ts` reads the bridge into `event.locals`; server `load`s and `+server.ts` endpoints use only that.
- **Live updates use Server-Sent Events:** one `GET` stream per tab, with no WebSockets.
  - On connect it sends a full snapshot (the transcript, busy flag, jobs, pending secret requests, connection state), then incremental updates.
  - The server projects pi-durable events into a simple transcript model, the same rules as `extensions/gateway/transcript.ts`: user / assistant / tool / info / report / note lines plus the streaming text. Each root user entry is mapped by its source, which the kernel delivers with the events (`SurfaceContext.root.events`' second argument, `InputSource`): a person's input is a `user` line (its typed `text`, and `files` as `FileView`s with opaque ids, served by `GET /api/files/<id>`), each successful `send_file` result a `file` line (a card with Download, and Open for images and PDFs), a background job's report a `report` line (job id, title, status, body), and any other kernel-posted input (schedule wakes, secret notes, `[japa]` notes, sign-in reports) a `note` line. Reset handoffs and compaction summaries are hidden. The browser never receives raw model entries.
  - The client reconnects automatically. A reconnect gets a fresh snapshot.
- **Actions are same-origin `POST` endpoints:** submit, abort, fulfil secret, decline secret, and status (`GET`). Invalid input gets a 4xx with a short message, which the UI shows as an info line.
- **Building:**
  - SvelteKit, Vite, Svelte and the adapter go in the root `package.json` and lockfile; there is still one `npm ci`.
  - `npm run build` builds the app, and the root `prepare` script runs it, so `npm install` / `npm ci` in a checkout builds it.
  - `install.sh` and `japa update` both run the build explicitly after installing dependencies, `japa update` on every update even when the lockfile didn't change. A failed build fails the step, so install cleans up and update rolls back as it already does for failed steps.
  - `npm run typecheck` also runs `svelte-check` on the app. The root `tsc` excludes `extensions/webui/app/`.

### 2.3 Network exposure and access
- **Settings:** `extensions.webui` holds:
  - `bind`: the address the server listens on. Default `"127.0.0.1"`; set it to a Tailscale address to reach it from a phone.
  - `port`: default `7337`.
  - `hosts`: extra DNS names (no port) the server answers to, compared case-insensitively, e.g. `["japa.example.corp"]` for a name on a VPN. Default none.
  - `enabled`: the kernel's standard key. `false` turns the extension off.

  A change takes effect when the surface next starts (a daemon restart or extension reload). The extension needs nothing to be set up, so it is **available by default**, and `japa setup`'s first run and Integrations step don't ask about it; a rerun's **Web UI** section (see "japa: a Web UI section in `japa setup`" above) shows and changes these settings.
- **Web UI users** (password users; this replaced the original single access token `webui.token`, which is no longer declared or read — a leftover `secrets/webui.token` is ignored and may be deleted). All users see the same single conversation, jobs, status and secret requests: they are separate logins, not separate workspaces.
  - **CLI:** `japa webui users add <name> [--password-stdin]` (asks for the password twice, masked, via the clack prompter; refuses an existing name), `passwd <name> [--password-stdin]` (new password; ends all that user's sessions), `remove <name>` (ends all that user's sessions), `list` (one line per user: name and creation time, never hashes; `no web UI users` plus how to add one when empty). `--password-stdin` reads the first line of stdin, without confirmation; with no terminal and no `--password-stdin`, `add` and `passwd` fail with a clear message. Names: 1–32 characters matching `[a-z0-9][a-z0-9._-]*`, lower-cased on input (case-insensitive). Passwords: 8–1024 characters. Mismatched confirmations, invalid names or passwords, and unknown names for `passwd`/`remove` exit 1 with a message. It works on the japa home directly (no daemon needed); the running daemon sees changes on its next request. For a Docker instance: `japa --instance <n> webui users add <name>`.
  - **Storage:** `<home>/webui/users.json` (dir mode 700, file mode 600), `/webui/` in the home's ignored `.gitignore` lines, so it's never in git, job clones or their sandboxes. Each record: name, creation time, an scrypt hash (Node `crypto.scrypt`, per-user random 16-byte salt, parameters stored per record, N=2^15, r=8, p=1) and a random per-user session stamp that `passwd` regenerates. Writes are atomic (temp file + rename, mode 600); the CLI refuses to modify a file it can't parse. The daemon reads the file on sign-in and session checks (cached by mtime/size), with async scrypt. A missing file is no users; a malformed one means nobody can sign in.
  - **Sign-in:** `/login` shows username and password fields (`autocomplete="username"` / `"current-password"`), or, with no users, says to run `japa webui users add <name>` on the machine running japa. `POST /login` (form fields `username`, `password`; 4 KB body limit; Origin-checked) sets the session cookie and 303s to `/`, or 303s to `/login?error=1`, which shows one generic "Wrong username or password." An unknown name is checked against a dummy scrypt hash so timing doesn't reveal names. Failed sign-ins are throttled in memory per client address: after 10 failures in a rolling minute, `POST /login` gets 429 until the window passes; a success clears the count. `?token=` is an ordinary query parameter.
  - **Sessions:** the cookie `japa_webui_session` (`HttpOnly; SameSite=Strict; Path=/`, 30 days, stateless) is `<name>.<expiry>.<mac>`, `mac = HMAC-SHA256(sessionKey, "webui-session:<name>:<expiry>:<stamp>")`. Valid only while the user exists, the expiry is in the future and the MAC matches the user's current stamp: `remove` and `passwd` end that user's sessions at once, others are unaffected, and sessions survive restarts. The session key is a generated secret `webui.session-key` (`generated: true`, 32 random bytes, created on first start if unset); changing or deleting it and restarting signs everyone out. Old two-part cookies are invalid.
  - **Sign out:** `POST /logout` (Origin-checked, session required) clears the cookie and 303s to `/login`. The top bar shows the signed-in username and a Sign out button; it clears only that browser's cookie.
  - The session gate hands the signed-in username to the app (`event.locals.user`). Every request other than the sign-in page and its static assets needs a valid session cookie. Submissions keep the origin `{ surface: "webui", chat: "web" }`.
- **Request checks:**
  - Requests are refused unless their `Host` header names this server, which defends against DNS rebinding: `localhost`, `127.0.0.1`, the bound address or a name in `hosts`, or any IP literal (IPv4, or IPv6 in brackets). The port isn't checked (any port, or none), so an SSH tunnel to another local port and a port published by Docker work. IP literals are safe to accept because DNS rebinding always arrives with the attacker's domain name in `Host`, never a bare address; that also lets a LAN or VPN address reach a server that doesn't know it (a Docker instance's published port). A missing `Host`, a foreign name, and a name that merely starts with an address (`10.1.2.3.evil.example`) are refused.
  - State-changing requests must carry a matching `Origin`: `http://` followed by the `Host` header as sent.
  - Responses send a strict Content-Security-Policy: self only, no inline script beyond what SvelteKit's own CSP support hashes, and no third-party origins.
  - The page makes **no external network requests**: no CDNs and no web fonts fetched from the internet.
- **Status line:** the extension's `status()` line, shown under `webui` in `japa status` and Telegram's `/status`, is one of:
  - `http://<bind>:<port> — sign in as a web UI user (N users)`
  - `http://<bind>:<port> — no users yet: run japa webui users add <name>`
  - `http://<bind>:<port> — can't read ~/.japa/webui/users.json: <reason>` (the home written with `~`)
  - `not built — run npm run build in <app dir>`
  - `can't listen on <bind>:<port>: <reason>`

  In the last two cases the surface stays down and the daemon and other surfaces keep running. The line follows the users file without a restart, and never contains a password, hash, stamp or session key.

### 2.4 Rendering and safety
- Assistant text is rendered as markdown with `marked` (already a dependency): headings, lists, task lists, code blocks (monospace, horizontally scrollable, with a copy button), tables, quotes and links.
- **Raw HTML in markdown is never rendered**; it is shown as text. Links are allowed only for `http(s):` and `mailto:` and open in a new tab with `rel="noopener noreferrer"`. This matters because the CoS repeats content from the web and email.
- User messages are shown as plain text with line breaks kept.
- Secret values are typed into a password-type field, sent once in a POST body, and never echoed, logged, kept in client state after submit, or put in the transcript.

### 2.5 Theme (inspired by openui.com)
- **Monochrome palette.** Light mode uses white / near-white backgrounds, near-black text and a scale of neutral greys. Dark mode is its mirror (near-black background, off-white text) and follows `prefers-color-scheme`. One restrained accent, near-black or white, is used for primary actions only.
- **Type.** The system UI font stack, Inter first when installed locally, with generous line height. Monospace is used for code. Sizes stay on a small, consistent scale.
- **Shapes and depth.** Hairline 1px borders, soft large radii (about 12–16px on cards and inputs, fully rounded pills on buttons and chips), very subtle shadows, and lots of whitespace.
- **Layout:**
  - A centred reading column, about 720px wide.
  - A slim top bar: the `japa` wordmark, a connection/busy indicator (a small dot plus "thinking…"), and buttons for Jobs and Status.
  - A pill-shaped, auto-growing composer pinned to the bottom. Enter sends and Shift+Enter adds a newline. A send button becomes Stop while the CoS is busy, and Esc also stops.
  - User turns (a person's input only) appear as soft grey bubbles aligned right. Assistant turns are unboxed text aligned left. Tool calls are small muted chips (`⚙ tool_name`), and info and errors are muted inline notes, as are kernel notes (schedule wakes, `[secret … provided]`, `[japa] …`). A job report is a left-aligned, hairline-bordered rounded card: "Job report", the job's title and a status pill like the Jobs panel's, then the report as markdown (rendered like assistant text), clipped past about 12 lines with a keyboard-accessible Show more / Show less. Optimistic bubbles settle only against user lines.
  - The empty state is a quiet centred greeting.
- **Jobs panel.** A slide-over panel on the right, a full-screen sheet on narrow screens. Active jobs (queued / running / needs input) come first, then recent finished ones. Each row shows the id, title, a status pill and a one-line progress / question / result; it expands to show the brief and the full detail. It updates live.
- **Status view.** A sheet showing the model, each extension with its summary, state and status line, and errors.
- **Secret prompts.** When requests are pending, a card above the composer shows the first one, giving its name and why. It has a masked field with Submit and Decline buttons, plus a count when there are more. It can be dismissed until the pending list changes. This matches the semantics of `japa chat`.
- **Responsiveness and motion.** Usable down to phone width. Motion is limited to short fades and slides, and is disabled under `prefers-reduced-motion`. Keyboard-accessible, with visible focus rings and semantic landmarks and labels.

### 2.6 Multiple tabs and robustness
- Any number of tabs or devices can be open. They all see the same live state, and an action in one shows up in all.
- If the daemon restarts, the page shows a "reconnecting…" state and recovers on its own.
- An expired or invalid session sends the page back to the sign-in screen.

## 3. Docs
- The README gains a **Web UI** section covering the URL, signing in (web UI users and the `japa webui users` commands), the `bind` / `port` settings, SSH tunnelling (`ssh -L 7337:localhost:7337 <server>`) and Tailscale; the command table lists `japa webui users …`, and the Docker instances paragraph uses `japa --instance <name> webui users add <name>`.
- The Development section adds `npm run build`, and the "Where state lives" section notes `webui/users.json`, `secrets/webui.session-key`, and that `webui.token` is obsolete.
- `install.sh`'s Docker install message (and its upgrade message) point at `japa --instance <name> webui users add <name>`.
- `docs/spec.md` is updated to describe the `webui` surface.

## Acceptance behaviours

1. With a fresh `npm ci` and a running daemon, `japa status` lists `webui` with `http://127.0.0.1:7337 — no users yet: run japa webui users add <name>`, the sign-in page says the same, and no `secrets/webui.token` is created.
2. `japa webui users add alice` asks for the password twice (mismatches rejected); `list` then shows `alice` and `japa status` reports 1 user without a restart. `~/.japa/webui/users.json` is mode 600, holds no plaintext password, and is ignored by git. `echo 'secret123' | japa webui users add carol --password-stdin` works without a terminal; without `--password-stdin` and with no terminal, it fails with a clear message.
2a. Signing in as `alice` lands on the chat with `alice` in the top bar; reloading keeps you signed in. A wrong password or unknown user shows "Wrong username or password.". After 10 failures within a minute from one address, the next attempt gets 429, even with the right password, until the minute passes. `/?token=<anything>` without a session redirects to sign-in. Sign out returns to sign-in, and `/api/status` then gives 401 in that browser.
2b. `japa webui users passwd alice` sends every alice browser back to sign-in on its next request or reconnect, while bob stays signed in; the new password works, the old one doesn't. `remove bob` ends bob's session the same way. Unknown names exit 1. Restarting the daemon keeps users signed in. Two users signed in at once share the same live conversation and jobs. For a Docker instance, `japa --instance <n> webui users add <name>` creates a user that signs in at the instance's web UI URL.
3. Requests to the API or live stream without a session cookie get 401. A request with a foreign `Host` header (a DNS name not in `hosts`) is refused, one addressed to an IP literal on any port is served, and a POST (including to `/login` or `/logout`) with a foreign `Origin` is refused.
4. Typing a message and pressing Enter shows it as a right-aligned grey bubble. The CoS's reply streams in token by token as rendered markdown, and the busy indicator shows "thinking…" until it finishes.
5. While a reply streams, the send button reads Stop. Clicking it, or pressing Esc, stops the reply. Sending another message mid-reply steers it.
6. A message sent from `japa chat` or Telegram, and its reply, appear live in an open web tab, and vice versa. A reply to a web message is not sent to Telegram.
7. Asking the CoS for something that starts a background job makes the job appear in the Jobs panel within seconds. Its status pill and progress update live, and its report appears in the transcript when it finishes.
8. When an extension requests a secret, a card appears with its name and reason. Submitting a value stores it, the card disappears, and the value appears nowhere in the page or transcript. Decline tells the CoS you said no.
9. An assistant reply containing `<img src=x onerror=alert(1)>` or a `javascript:` link displays as inert text, and no script runs.
10. The UI is monochrome and minimal in light mode, switches to dark when the OS does, works at phone width, and makes no requests to any origin other than its own (check the browser's network tab).
11. Two tabs open at once both update live. Restarting the daemon shows "reconnecting…", after which both tabs recover without a manual reload.
12. Setting `extensions.webui.port` to another value and restarting moves the UI there. Setting `extensions.webui.enabled` to `false` and restarting stops it, while `japa chat` keeps working.
13. With the build folder deleted, the daemon still starts, `japa chat` works, and `japa status` shows `webui`'s line as `not built — run npm run build …`. If the port is already in use, the line names the conflict instead.
14. `npm test` and `npm run typecheck` (including `svelte-check`) pass, and `japa check extension webui` passes in a checkout without a build.
15. A `japa update` that changes only the UI's source rebuilds it, and an update whose UI build fails is rolled back with the build named as the failed step.

## Implementation notes (builder)

Decisions made while building, within the spec above:

- **SvelteKit 2** (`@sveltejs/kit` 2.70, `@sveltejs/adapter-node` 5, Svelte 5, Vite 8), configured in
  `extensions/webui/app/svelte.config.js`. The app has its own tiny `package.json` (no dependencies; a `build` script
  so the status line's `npm run build in <app dir>` works); all dependencies live in the root `package.json`.
- **TypeScript**: svelte-check and SvelteKit need the TypeScript 5/6 JS API, which TypeScript 7 doesn't ship. Following
  svelte-check's own guidance, the root `typescript` dev dependency is 6 and TypeScript 7 is installed as
  `@typescript/native` (`npm:typescript@^7`); the root typecheck and `japa check` call its `tsc` explicitly.
- **Request pipeline** (`extensions/webui/server.ts`), in front of the SvelteKit handler: the Host check
  (`acceptedHost`: the name from `name[:port]` or `[v6][:port]`, then `node:net`'s `isIP`, else the name list), the Origin
  check on every non-GET/HEAD request, default security headers (a `default-src 'none'` CSP that SvelteKit's pages
  replace with their own hashed one, `nosniff`, `same-origin` referrer, `DENY` framing), sign-in (`POST /login`,
  throttled), the session gate (401 JSON for `/api/*`, a redirect to `/login` for pages), and `POST /logout`.
- **Users** (`extensions/webui/users.ts`): the file format (`{ version: 1, users: [...] }`), validation, scrypt
  hashing (`maxmem` raised to fit N=2^15, r=8), atomic writes, and `userStore` (async `load()` for requests,
  `loadSync()` for the synchronous `status()` line; both re-read only when the file's inode/size/mtime/ctime change).
  A malformed file is reported as `not valid JSON` without the parser's message, which would quote the hashes.
  The CLI is `src/cli/webui-users.ts` (`webuiCommand`, with an injectable I/O for tests); before writing it runs
  `ensureWorkspace` so the home's `.gitignore` has `/webui/` (anchored, so a component's `extensions/webui/` isn't
  ignored).
- **Throttle**: a failure slot is reserved before the password check (`Throttle.reserve`), so parallel guesses still-being-hashed count; a success clears the address. The dummy hash is made when the pipeline is created.
- **Sessions** (`extensions/webui/auth.ts`) are stateless: the cookie `japa_webui_session` is
  `<name>.<expiry>.<HMAC-SHA256(sessionKey, "webui-session:<name>:<expiry>:<stamp>")>`, valid 30 days. The throttle
  (`Throttle`) keeps failure timestamps per `req.socket.remoteAddress` (behind Docker's port publishing that is the
  bridge's address, so an instance's failures are counted together).
- **Username to the app**: the pipeline sets `req[Symbol.for("japa.webui.request")] = { user?, users }`
  (`REQUEST_KEY` in protocol.ts); adapter-node passes the Node request as `event.platform.req`, and
  `hooks.server.ts` copies it to `event.locals.user` / `.users`. The chat page's `+page.server.ts` returns
  `{ user }` (fetched as `__data.json`, since the page is client-rendered); the sign-in page's returns `{ users }`.
- **API** (`extensions/webui/app/src/lib/protocol.ts`): `GET /api/events` (SSE: a snapshot, then `lines`, `delta`,
  `streaming`, `busy`, `transcript`, `jobs`, `secrets`), `POST /api/submit|abort|secrets/fulfil|secrets/decline`
  (`POST /api/submit` also takes multipart/form-data with files, and `GET /api/files/<id>` serves transcript files:
  both handled by the surface's own server, see the files-in-and-out-of-the-web-UI spec)
  (`GET /api/status` was removed by the Settings change above; Settings, update, sign-in and desktop endpoints added).
- **CSP**: `style-src 'self'`, plus SvelteKit's route announcer's one inline style attribute, allowed by its hash
  (`style-src-attr 'unsafe-hashes' 'sha256-…'`).
- **Tests**: vitest sets `JAPA_WEBUI_AUTOSTART=0` so the suite's many daemons don't bind 7337. The webui tests turn it
  back on and use port 0. `japa check`'s throwaway daemon runs webui on port 0.
- `japa update` runs `npm run build` as its own step, `build`, after dependencies, and a rollback rebuilds the old UI.
  `install.sh` has a `build` step after `dependencies`.

---

# Spec: files in and out (multi-modal input and output)

## Context

japa's CoS is reached through **surfaces**: the `messaging` contract (Telegram is the default adapter, and the kernel's `startMessaging` does routing, merging, menus and secrets) and the lower-level `surface` contract (the `gateway`, i.e. `japa chat`). Inbound images already work: `Incoming.images` → `inputOf()` saves each one under `~/.japa/attachments/<date>/` → it goes inline as an `image` part when the CoS model has vision. Nothing else can come in, and the CoS has no way to send a file out.

This change does two things:

1. **Inbound:** any file reaches the agent (images, PDFs, audio and voice notes, video, documents, archives…).
2. **Outbound:** the CoS can send a file from the host back to the user's chat.

The contracts expose both, and the Telegram extension implements both.

**Constraint:** pi-ai 1.0.4 only accepts `text` and `image` content (`UserMessage.content`, `model.input`). PDFs and audio therefore never go to the model natively. They are saved to disk and described to the CoS. PDFs also get their text extracted. Audio is not transcribed by the kernel: the CoS hands it to a job if it needs it.

## Inbound files

### Contract (`src/kernel/contracts.ts`, exported from `japa/sdk`)

- New type `IncomingFile = { data: Uint8Array; mimeType: string; name?: string }`. `name` is the original file name when the platform has one.
- `Incoming` gains `files?: IncomingFile[]`.
- `Incoming.images` stays accepted for existing workspace adapters but is deprecated. The kernel treats each image exactly like a file (no name).
- The `messaging` contract's `docs` string says japa provides "commands, settings, secrets, routing and files (in and out)".
- `SurfaceContext` gains `input(messages: { id: string; text?: string; files?: IncomingFile[] }[]): Promise<UserInput>`. It is the kernel's shared conversion (below), so a plain `surface` can submit files the same way messaging does. The messaging surface uses it. `japa chat` gets no file-input UI in this change: a terminal user can just give a path.

### Kernel conversion (replaces `inputOf` in `src/kernel/messaging/attachments.ts`; now async)

For the messages merged into one input (the existing `MERGE_MS` merge now also triggers on messages that carry only files):

- **Saving.** Each file is saved to `<home>/attachments/<YYYY-MM-DD>/<messageId>-<name>`.
  - `name` is the original name, sanitised: basename only, no path separators, control characters or leading dots, and capped in length.
  - With no name: `<messageId>[-<n>].<ext>`, the extension derived from the MIME type (falling back to `bin`).
  - A name collision gets a numeric suffix.
  - The location is persistent, not a temp dir. It is git-ignored and mounted read-only into jobs (both already true).
- **Notes.** Texts are joined as today, then one note line per file:
  - images keep `[image saved to <path>]`;
  - every other file gets `[file saved to <path> (<mimeType>, <human size>)]`;
  - a failed save gets `[file could not be saved: <reason>]`.
- **Images.** Unchanged. Saved images go inline as `image` parts when the CoS model's `input` includes `image`; otherwise the existing "(this model cannot see images)" note is added.
- **PDFs** (`application/pdf`, or a `.pdf` name with a generic MIME type):
  - The text is extracted in-process with a pure-JS PDF library added as a dependency. No system binaries are used.
  - The full text is written next to the file as `<path>.txt`.
  - The first `context.toolResultTokens × 4` characters are inlined after the file's note as `[PDF text, <pages> pages]` followed by the text.
  - If the text was cut, a line follows: `[Truncated; full text at <path>.txt]`, so the CoS can page through it with `read`.
  - No extractable text (a scan) → `[PDF has no extractable text]`. An encrypted, corrupt or timed-out extraction (bounded, ~30 s) → `[PDF text could not be extracted: <reason>]`. The file stays saved either way.
- **Everything else** (audio, voice, video, docx, zip, text…) is saved and noted only. The CoS reads text-like files with its `read` tool, or starts a job for the rest (e.g. transcription). Its identity/capabilities text says so.

The submitted input has the same shape as today (`string`, or text plus image parts), so history, recall and memory are unaffected.

## Outbound files

### The `send_file` tool (CoS root conversation only; jobs don't get it)

- Parameters: `{ path: string; caption?: string }`.
  - `path` is absolute, or starts with `~/`, on the japa host.
  - `caption` is markdown.
- Validation happens at call time:
  - missing → `No file at <path>.`;
  - not a regular file → `Not a file: <path>.`;
  - unreadable → the error;
  - over the kernel cap of 50 MB → `Too large: <size> (max 50 MB).`
- On success it records the file (resolved path, name, MIME type guessed from the extension, size and caption) in the tool result's details and replies `Sending <name> (<size>).`
- The tool does not send anything itself.

### Delivery through the reply stream

- `Reply` becomes `{ cursor; origin; text; file?: OutgoingFile }`.
- `OutgoingFile = { path; name; mimeType; size; caption?: string }`, exported from the SDK.
- `root.replies` now yields, in transcript order:
  - each finished assistant message with text (as today);
  - each successful `send_file` result, as a reply whose `file` is set and whose `text` is the caption or `""`.
- Text the CoS wrote before calling the tool is therefore delivered before the file.
- The same cursor covers both kinds, so a file not yet delivered when the daemon stops is delivered after the restart. A delivered file is not sent again.
- Routing is unchanged: to the chat the turn came from, and proactive turns (job reports, schedules) to the owner on each messaging adapter.
- The file is read from disk at delivery time. If it's gone by then, the chat gets `Couldn't send <name>: it no longer exists at <path>.`

### Messaging adapter contract

- `MessagingAdapter` gains two optional members:
  - `sendFile?(chat: string, f: OutgoingFile): Promise<string>`, which returns the message id;
  - `maxFileBytes?: number`.
- Validation accepts adapters without them.
- The messaging surface calls `sendFile` for a file reply.
- **Fallback.** When the adapter has no `sendFile`, the file exceeds `maxFileBytes`, or `sendFile` throws, it sends the text `📎 <name> (<size>) is at <path> on japa's host` plus the reason when there is one, then the caption if any. Errors are logged.

### Job hand-off: `~/.japa/outbox/`

- A new real directory `~/.japa/outbox/`:
  - created at boot;
  - git-ignored (added to the workspace's ignore lines);
  - mounted **read-write** into every job sandbox, like `desktop/shared`, and subject to the same secret-path check.
- A job's `/tmp` is private and its clone may be deleted, so deliverables meant for the user go in `~/.japa/outbox/` (by convention `~/.japa/outbox/<job id>/`). The job's report names those paths.
- Only the CoS sends: it calls `send_file` on the outbox paths.
- The job system prompt / `writing-job-briefs` skill and the CoS capabilities text describe this.
- The outbox is not pruned automatically.

### `japa chat`

The gateway transcript shows a line `📎 <path>` for each `send_file` call (the file is already local). There is no other change.

The web UI (see the files-in-and-out-of-the-web-UI spec) attaches files from the composer (paperclip, drag-and-drop, paste; ≤ 10 files and 50 MB a message) through `SurfaceContext.input`, shows a person's files from any surface as chips (the kernel's notes stripped, via `InputSource.person.files`) and each `send_file` result as a downloadable card instead of a `📎 <path>` line. `japa chat` ignores the new source fields.

## Telegram extension

### Inbound (`extensions/telegram/updates.ts`)

- Accepted message kinds:
  - `photo` (largest size);
  - `document` (any MIME, with `file_name`);
  - `audio` (with `file_name` / MIME);
  - `voice` (`audio/ogg`, named `voice.ogg`);
  - `video`;
  - `video_note` (`video/mp4`);
  - `animation`.
- Each is downloaded via `getFile` and returned as `Incoming.files`, with the caption as `text`.
- Albums arrive as separate updates and are merged by the kernel's `MERGE_MS` window.
- The 20 MB Bot API download limit stays: an oversized file gets the existing "too large" reply.
- Unsupported kinds (sticker, location, contact, poll, …) get `I can read text and files here.`

### Outbound

- `maxFileBytes = 50 MB`.
- `sendFile` uploads the file as `multipart/form-data`, so `api.ts` gains a multipart call path with the same retry and 401 handling. It picks the method by MIME type:
  - `image/jpeg|png|webp` up to 10 MB → `sendPhoto`, falling back to `sendDocument` if Telegram rejects the photo;
  - `audio/ogg` → `sendVoice`;
  - `audio/mpeg|mp4|m4a|x-m4a|aac|flac` → `sendAudio`;
  - `video/mp4` → `sendVideo`;
  - everything else, gif included → `sendDocument`, keeping the file name.
- **Captions** are rendered to HTML like messages, with a plain-text fallback. A caption that renders over Telegram's 1024-character limit is sent as a separate message right after the file.
- While uploading, the chat action shows the matching `upload_*` status.

## Docs

- `README.md`: the Telegram section covers files in and out; "Where state lives" lists `attachments/` (every received file, plus `.txt` for PDFs) and `outbox/`; the Jobs section notes that `outbox/` is mounted writable.
- The builder records this design in `docs/spec.md`, or the specs directory in use.

## Acceptance behaviours

1. Sending the Telegram bot a PDF with a caption "summarise this":
   - the file appears under `~/.japa/attachments/<today>/` with its original name, plus a `.txt` beside it;
   - the CoS answers with a summary drawn from the PDF's text.
2. Sending a PDF longer than the inline cap: the CoS's input says it was truncated and names the `.txt`. Asked about the last page, the CoS can read it from that file.
3. Sending a scanned (image-only) PDF: it's saved, and the CoS says it has no extractable text instead of erroring.
4. Sending a voice note: it's saved as `…voice.ogg`, the CoS is told its path and type, and it can start a job to transcribe it. Nothing crashes, and no "I can only read text and images" reply appears.
5. Sending a `.zip` or `.docx` document: it's saved under its original name, and the CoS acknowledges the path.
6. Sending a photo still works as before: inline for a vision model, with the "cannot see images" note otherwise.
7. Sending a sticker gets the reply `I can read text and files here.`
8. Sending a file over 20 MB gets the "too large" reply, and nothing is submitted to the CoS.
9. Asking the CoS on Telegram "send me ~/notes/todo.md":
   - the bot sends it as a document with that file name;
   - any text the CoS wrote before the call arrives first.
10. Asking for a `.png` returns a photo, an `.mp3` an audio message, and a `.ogg` voice note a voice message.
11. Asking for a missing path gets an answer saying it doesn't exist, and nothing is sent. Asking for a file over 50 MB gets an answer saying it's too large.
12. Asking a job to produce a file (e.g. "make me a CSV of …"):
    - the job writes it under `~/.japa/outbox/`;
    - its report names the path;
    - the CoS sends the file to the Telegram chat, including when the job's report arrives proactively.
13. If the daemon restarts after `send_file` ran but before the file was delivered, the file arrives once after the restart, and is not sent twice.
14. In `japa chat`, asking the CoS to send a file shows a `📎 <path>` line.
15. A messaging adapter without `sendFile` still loads. A file the CoS sends there arrives as a text line naming its path on the host.
16. `npm test` and `npm run typecheck` pass.

---

# japa — Docker hosting (Sysbox system containers, named instances)

Status: spec for an incremental change to the existing japa product (repo `Darryl-Shi/japa`). The builder records the outcome in `docs/spec.md` and in the README (Install, Running, Where state lives, Uninstall).

## 1. Purpose

japa currently installs only "natively": a git checkout under `~/.local/share/japa`, a `~/.local/bin/japa` launcher, `~/.japa` data, a systemd user service, bubblewrap for jobs, and the host's Docker for the desktop. This change adds **Docker hosting**:

- **One installer, two modes.** `install.sh` asks whether to install natively or via Docker. Docker is the default.
- **Docker is a hosting backend, not a code path.** Each japa runs in its own Sysbox system container. That container is a small Linux machine with systemd as init, its own private dockerd and working bubblewrap. Inside it, japa is installed and runs exactly as it does natively today, with the same code, layout, service, update, sandbox and desktop. The kernel, the extensions, the CLI commands and the SDK contracts don't know or care whether they run in a container. There are no docker-specific adapters or branches in `src/` or `extensions/`.
- **Nothing outside the container.** A Docker instance keeps all of its state (app checkout, `~/.japa`, the user's home, the inner Docker's images and containers) in named Docker volumes. It never bind-mounts host paths and never talks to the host's Docker socket. Only two things exist on the host: the container with its volumes and network, and a host-side launcher script.
- **Multitenancy.** One operator can run several independent japas on one machine, one per tenant, each a named instance with its own container, volumes, network, settings, secrets, models, Telegram bot and desktop.

## 2. Key decisions

| Question | Decision |
|---|---|
| Container runtime | **Sysbox** (`--runtime=sysbox-runc`), never `--privileged` and never the host's docker.sock. Each instance is unprivileged and isolated from the host and from the other instances. |
| What runs inside | A system container image with systemd as PID 1, plus Node 24, git, tar, curl, bubblewrap, Docker Engine and the japa desktop's requirements. A non-root user `japa` (uid 1000) is in the inner `docker` group and has systemd lingering enabled. |
| How japa is installed inside | By the **native** install path of the same `install.sh`, run as user `japa` inside the container (git clone into `/home/japa/.local/share/japa/app`, launcher at `/home/japa/.local/bin/japa`, data in `/home/japa/.japa`). |
| Service | The existing `japa service` systemd **user** unit, running under the container's own systemd. The container uses `--restart unless-stopped`, so japa comes back after a host reboot. |
| Updates | Unchanged: `japa update` and Telegram `/update` (git fast-forward, validate, roll back, restart through `systemd-run --user`) run inside the container. |
| Jobs sandbox | Unchanged bubblewrap, which works inside a Sysbox container. The inner `/var/run/docker.sock` is masked from jobs by the existing rules. |
| Desktop | Unchanged desktop extension, using the **inner** dockerd. Its image, build cache, container and home volume live in the instance's docker volume. |
| Tenancy model | **Operator-managed named instances.** One admin with host Docker access creates and manages instances. Tenants reach their japa through Telegram, or through a shell the admin opens for them in their own container. |
| Image source | Built locally on the host from the repo's `docker/` directory at the installed branch, using a git build context. No registry dependency. |

## 3. Host-side shape of a Docker instance

For an instance named `<name>`:

| Thing | Name / value |
|---|---|
| Container | `japa-<name>`, labels `japa.instance=<name>`, `japa.branch=<branch>`, `japa.desktopPort=<port>`, `japa.webuiPort=<port>`, `japa.webuiBind=<address>` |
| Volumes | `japa-<name>-home` → `/home/japa` (app checkout, `~/.japa`, the rest of the home); `japa-<name>-docker` → `/var/lib/docker` (inner images, build cache and containers, including the desktop and its home volume; the image keeps the inner Docker off the containerd image store so they all live here) |
| Network | `japa-<name>-net`, a user-defined bridge used by that instance only, so instances can't reach each other's ports |
| Image | `japa-host:<branch>`, built from `docker/` in the repo |
| Ports | Two host ports: `127.0.0.1:<desktop port>`, forwarded to the instance's noVNC, and `<web UI address>:<web UI port>` (`127.0.0.1` by default), forwarded to its web UI. Nothing else is published. |

- **Instance names** match `[a-z0-9][a-z0-9-]*`. The default is the host `$USER`, lower-cased and sanitised. The installer refuses to create an instance whose name is already used by a container that is not a japa instance.
- **Desktop port.** The default is the first free port from 6080 upward that no other japa instance has claimed (`--desktop-port <n>` overrides it). It is recorded in the container label.
  - Inside the container, the image forwards that published port to the desktop's noVNC on the container's loopback. japa's own `extensions.desktop` settings and defaults are not changed.
  - To reach it from another machine: `ssh -L <port>:localhost:<port> <server>`.
- **Web UI port and address.** The default port is the first free one from 7337 upward that no other japa instance has claimed (desktop or web UI) and that isn't this instance's desktop port (`--webui-port <n>` overrides it). The default address is `127.0.0.1`; `--webui-bind <IPv4>` publishes it on a LAN or VPN address instead, or on every address with `0.0.0.0`. Both are recorded in container labels.
  - Inside the container the web UI keeps its defaults (`127.0.0.1:7337`); the image forwards the published port to it. It accepts the host's address because it accepts any IP-literal `Host` (webui §2.3); a DNS name for it goes in the instance's `extensions.webui.hosts`.
- **Persistence across recreation.** Recreating the container from a newer image keeps both volumes. Software installed with apt in the container's root filesystem is lost, everything under `/home/japa` and the inner Docker state are kept. This mirrors the desktop's existing contract.

## 4. The installer (`install.sh`)

### 4.1 Mode choice

- **New flag** `--mode <docker|native>`, with env var `JAPA_INSTALL_MODE`.
- **Without the flag, on a fresh install:**
  - With a terminal, the installer asks "Install japa via Docker (recommended) or natively?" and Enter picks Docker.
  - Without a terminal it uses Docker.
- **An existing native install** at `--dir` is upgraded natively, exactly as today, without asking.
- **An existing Docker instance** of the chosen name is upgraded (§4.4), without asking.
- **Native mode** is today's installer, byte-for-byte in behaviour, plus the new flag parsing.

### 4.2 Docker mode prerequisites

Checked in order. Each failure names the problem and how to fix it.

1. **Linux on x64 or arm64**, as today.
2. **Docker present and usable** by the invoking user (`docker info` succeeds). If not, the installer prints the existing guidance: install Docker, or `sudo usermod -aG docker $USER` and log in again.
3. **The Sysbox runtime is registered** with the host's Docker (`sysbox-runc` appears in `docker info`'s runtimes).
   - If it's missing on a supported distro (Ubuntu or Debian, with the Sysbox `.deb` available for the architecture), the installer offers to install it.
     - This needs sudo, so the installer asks first.
     - It warns that installing Sysbox restarts the host's Docker daemon, which briefly stops running containers.
     - Enter means yes in a terminal. Without a terminal it only installs Sysbox with `--install-sysbox`.
   - Otherwise (unsupported distro, declined, or a failed install) it explains what's missing and links Sysbox's install docs.
     - In a terminal it then offers to install natively instead.
     - Without a terminal it exits non-zero.

### 4.3 Docker mode fresh install

1. **Build the host image** `japa-host:<branch>` from the repo's `docker/` directory at `--branch`, using a git build context (`--repo` and `--branch` are honoured).
2. **Create the instance resources:** the network and the two volumes, then start `japa-<name>` with `--runtime=sysbox-runc`, `--restart unless-stopped`, the hostname `japa-<name>`, the desktop port and the web UI's port and address. The installer waits for the container's systemd to reach a running state.
3. **Install japa inside.** Run the native install inside the container as user `japa` with `--mode native --skip-setup` (same `--repo` and `--branch`). This clones, runs `npm ci` and writes the inner launcher.
4. **Write the host launcher** to `~/.local/bin/japa` (§5). Add the PATH line exactly as today. A native launcher already there is not overwritten without asking (§5.3).
5. **Setup.** The installer prints the desktop's and the web UI's URLs. With a terminal, run `japa --instance <name> setup` through the host launcher, so the wizard runs inside the container and installs the service there. Without a terminal, or with `--skip-setup` or `--non-interactive`, it prints `run \`japa --instance <name> setup\` to finish`.

If any step fails or is interrupted, the installer names the step. It removes the container, volumes, network and launcher entry that this run created, and nothing that existed before.

### 4.4 Re-running on an existing instance

Re-running `install.sh --mode docker [--instance <name>]` on an existing instance upgrades it:

- **Base image.** It rebuilds `japa-host:<branch>`. If the image changed, it recreates the container with the same name, volumes, network, labels and ports. The volumes are kept.
- **Ports.** The recorded desktop port and web UI port and address are kept unless their flags are given. A `--desktop-port`, `--webui-port` or `--webui-bind` that differs from the recorded value recreates the container, as does an instance created before the web UI was published (no `japa.webuiPort` label), which gets the defaults.
- **Host launcher.** It always rewrites the Docker launcher (§5) with this installer's version — `~/.local/bin/japa`, or `japa-docker` when that's the one kept beside a native launcher — so launcher changes reach hosts that only ever upgrade.
- **japa itself.** It then runs `japa update` inside, exactly as a native re-run does.

### 4.5 New flags

| Flag | Env | Default | What it does |
|---|---|---|---|
| `--mode <docker\|native>` | `JAPA_INSTALL_MODE` | `docker` (asked in a terminal) | How to install |
| `--instance <name>` | `JAPA_INSTANCE` | `$USER` (sanitised) | Docker instance to create or upgrade |
| `--desktop-port <n>` | | first free from 6080 | Host port for the instance's noVNC |
| `--webui-port <n>` | | first free from 7337 | Host port for the instance's web UI |
| `--webui-bind <IPv4>` | | `127.0.0.1` | Host address the web UI is published on (`0.0.0.0`: all) |
| `--install-sysbox` | | off | Allow installing Sysbox without asking (needs sudo) |

The existing flags (`--dir`, `--branch`, `--repo`, `--non-interactive`, `--no-service`, `--skip-setup`) keep their meaning. In Docker mode, `--dir` is ignored (a note is printed), and `--no-service` and `--non-interactive` are passed through to the setup inside the container.

## 5. The host launcher in Docker mode

### 5.1 Forwarding

`~/.local/bin/japa` becomes a small POSIX sh script that forwards commands into an instance.

- **Command:** `docker exec` as user `japa`, with `-i` always and `-t` when stdin is a terminal, into `japa-<instance>`, running the inner launcher with the same arguments.
- **Environment it sets:** `XDG_RUNTIME_DIR` and `DBUS_SESSION_BUS_ADDRESS` for uid 1000, so that `systemctl --user`, `japa service *`, `systemd-run --user` and `/update` all work. It also passes `TERM`, `LANG` and `TZ` through.
- **Exit status:** the inner command's exit status is the launcher's.

So `japa chat`, `japa setup`, `japa status`, `japa service logs`, `japa update`, `japa check`, `japa rollback`, `japa safe-mode` and `japa --version` all behave as they do natively. The masked secret prompts, the TUI and Ctrl-C/Esc handling work over the TTY.

### 5.2 Choosing the instance

The launcher picks the instance in this order:

1. `--instance <name>` as the first argument (stripped before forwarding).
2. `JAPA_INSTANCE`.
3. The only japa instance on the host, found by the container label `japa.instance`.
4. The instance named after `$USER`.

If none of these applies, it lists the instances and asks for `--instance`. If the chosen container exists but is stopped, it is started first. If it doesn't exist, the launcher says so and lists the existing instances.

### 5.3 Host-only subcommands

These are handled by the launcher and never forwarded:

| Command | What it does |
|---|---|
| `japa instances` | Lists each instance: name, state (running or stopped), branch, inner japa version (`japa --version` when running), its noVNC URL `http://127.0.0.1:<port>/vnc.html` and its web UI URL `http://<web UI address>:<web UI port>` (`127.0.0.1` for `0.0.0.0`; `-` for an instance created before the web UI was published) |
| `japa [--instance n] shell` | An interactive login shell as `japa` inside the container. This is how an admin hands a tenant a shell, or inspects `~/.japa` |
| `japa [--instance n] uninstall [--purge]` | Stops and removes the container and network. Prints that the data is kept in the two named volumes. With `--purge`, it deletes the volumes once the admin types the instance name to confirm. The launcher is removed when no instances remain. |

### 5.4 Native and Docker installs on the same machine

Native and Docker installs can coexist on one host, but only one owns `~/.local/bin/japa`.

- A Docker install over a native launcher asks before replacing it. If declined, the Docker launcher is written as `~/.local/bin/japa-docker` instead.
- A native install leaves an existing Docker launcher alone in the same way.

## 6. Inside the container

- **No source changes for container awareness.** `src/kernel`, `extensions/*` and the CLI commands have none. Existing behaviour that depends on the environment (the bwrap probe, the desktop's Docker checks, the systemd availability check in setup, update launch via `systemd-run`, and service detection) simply finds a normal Linux machine.
- **The image** (`docker/Dockerfile` plus its support files) provides:
  - systemd as init;
  - dockerd enabled as a system service, with `/etc/docker/daemon.json` turning off the containerd image store (`{"features":{"containerd-snapshotter":false}}`), so the inner Docker uses the classic overlay2 store and keeps its images, layers and build cache under `/var/lib/docker` (the docker volume) rather than `/var/lib/containerd`, in the container's writable layer, which a recreate loses;
  - the `japa` user with lingering;
  - Node 24 on PATH, so the native installer uses it rather than downloading a private Node;
  - bubblewrap, git, tar and curl;
  - the noVNC and web UI port forwards (§3).
- **Google sign-in** uses the existing paste-the-redirect-URL fallback, because the OAuth loopback isn't reachable from the host browser. This is the same as over SSH today.
- **Inner Docker state stays in the instance.** The desktop's image builds and its home volume live in the inner Docker, so they are per instance and survive container recreation through `japa-<name>-docker`.
- **The desktop recovers from lost Docker state.** This is generic desktop behaviour, not a container code path: a current desktop container that fails to start is removed (`docker rm -f`) and created afresh, rebuilding its image first if it's gone; a fresh container that fails to run has its image removed and rebuilt; a failed image build prunes the build cache (`docker builder prune -af`) and is retried. Each recovery happens at most once until the desktop next comes up, so a lasting failure is reported as before. The desktop's home volume is never removed, and when a container is lost this way the chief of staff is told that software installed with apt is gone.

## 7. Out of scope

- Rootless Docker on the host, Podman, Kubernetes and macOS hosts.
- A `--privileged` fallback.
- Publishing images to a registry.
- Per-instance CPU or memory limits for the outer container.
- Tenants managing their own instances without host Docker access.
- Migrating an existing native install's `~/.japa` into a container.

## 8. Testing

- **Unit tests** (`vitest`, always run) cover the installer's mode selection, flags and refusal paths, and the host launcher's instance resolution and argument forwarding. Both are exercised with a fake `docker` on PATH.
- **End-to-end tests** create real Sysbox instances. They are gated behind `JAPA_SYSBOX_TESTS=1` and need Sysbox on the host, as the existing desktop Docker tests are gated behind `JAPA_DOCKER_TESTS=1`.

## Acceptance behaviours

1. On a Linux host with Docker and Sysbox, `curl -fsSL …/install.sh | sh` in a terminal asks native or Docker. Pressing Enter installs via Docker, runs the setup wizard, and leaves `japa chat` answering. `docker ps` shows `japa-$USER` running with runtime `sysbox-runc`, and no japa-related file or directory was created on the host other than `~/.local/bin/japa` (and the PATH line in the shell rc, if needed).
2. `docker inspect japa-$USER` shows no bind mounts and no host docker.sock: only the volumes `japa-$USER-home` and `japa-$USER-docker`, the network `japa-$USER-net`, and two published ports on `127.0.0.1` (the desktop and the web UI).
3. Inside a Docker instance, `japa status` shows the model and extensions. `japa service status` reports the systemd user service as active. A job started by the CoS runs under bubblewrap, and `japa status` reports no "Jobs can't run" error.
4. Asking the CoS to use the desktop works in a Docker instance: the desktop image builds in the instance's own dockerd, and `http://127.0.0.1:<desktop port>/vnc.html` on the host shows it. On the host, `docker ps` does not list a desktop container.
5. `install.sh --mode docker --instance alice` followed by `--instance bob` creates two instances. Each has its own setup, secrets, Telegram bot and desktop port. `japa instances` lists both. `japa --instance alice chat` talks only to alice's japa, and a secret set in bob is absent from alice's `japa --instance alice shell` view of `~/.japa/secrets`.
6. With exactly one instance on the host, plain `japa chat` reaches it. With two instances and no `$USER` match, `JAPA_INSTANCE`, or `--instance`, `japa chat` exits non-zero and lists the instance names.
7. `docker restart japa-alice` (or a host reboot) brings alice's japa back up answering `japa --instance alice chat`, with its conversation history intact.
8. `/update` from Telegram in a Docker instance updates japa inside the container, restarts its service, and reports the result in the chat, the same as natively. `japa --instance alice update --check` lists incoming commits.
9. Re-running the installer for an existing instance after the image definition changes recreates the container. Settings, secrets, history, jobs' workspace changes and the desktop's browser logins are all kept.
10. `japa --instance alice uninstall` removes alice's container and network but keeps both volumes, and says so. Re-running the installer for `alice` brings it back with its data. `uninstall --purge` (after typing `alice`) removes the volumes too.
11. Without Sysbox and without a terminal, `install.sh` (default Docker mode) exits non-zero with a message naming Sysbox and how to install it. In a terminal, declining the Sysbox install offers the native install instead.
12. `install.sh --mode native` behaves exactly as the installer did before this change. Re-running the installer over an existing native install upgrades it natively without asking about the mode.
13. `git grep -n -i "docker\|sysbox\|container"` in `src/` shows no new code paths that branch on running inside a container; only the pre-existing bwrap docker-socket masking appears.

## Outcome

Built as specified, with no container-aware code in `src/` or `extensions/`. What exists and the decisions taken:

**Files.** `install.sh` gained `--mode`/`JAPA_INSTALL_MODE`, `--instance`/`JAPA_INSTANCE`, `--desktop-port` and `--install-sysbox`, the Docker-mode functions (prerequisites, image build, instance creation, upgrade, cleanup) and the host launcher, embedded as `docker_launcher_text()`. `docker/Dockerfile` (Ubuntu 24.04, systemd as `/sbin/init`, Docker CE from Docker's apt repo, Node 24 from NodeSource, bubblewrap, git, socat; the `japa` user, uid 1000, in the `docker` group with lingering; udev/console units masked and journald not reading `/dev/kmsg`) and `docker/japa-novnc-forward.service`. README: Requirements, Install (Native install, Docker install, Installer flags), Non-interactive setup, Running → Docker instances, Updating, Uninstall, Where state lives → Docker instances, Development.

**Decisions.**

| Topic | Decision |
|---|---|
| Desktop port forward | The container publishes `127.0.0.1:<port>` → container port **16080**, where `japa-novnc-forward.service` (`socat TCP-LISTEN:16080,fork,reuseaddr TCP:127.0.0.1:6080`) forwards to the desktop noVNC the inner dockerd publishes on the container's loopback at japa's default 6080. `extensions.desktop` is unchanged. |
| Default desktop port | First port from 6080 up that no other instance claims (`japa.desktopPort` and `japa.webuiPort` labels), nothing listens on (read from `/proc/net/tcp{,6}`) and isn't `--webui-port`. An explicit `--desktop-port` claimed by another instance is refused. A re-run keeps the recorded port unless `--desktop-port` is given. |
| Web UI publish | The container publishes `<bind>:<port>` → container port **17337**, where `japa-webui-forward.service` (`socat TCP-LISTEN:17337,fork,reuseaddr TCP:127.0.0.1:7337`) forwards to the web UI on the container's loopback; `extensions.webui` is unchanged. The port defaults to the first from 7337 up that no other instance claims, nothing listens on and isn't the desktop's; the bind to `127.0.0.1`. `--webui-port` (1-65535) and `--webui-bind` (an IPv4 dotted quad) are validated before anything is built; a `--webui-port` claimed by another instance, or equal to the desktop port, is refused. Labels `japa.webuiPort`, `japa.webuiBind`. |
| Booted check | `systemctl is-system-running` inside the container may report `running` **or `degraded`** (some unit failed, e.g. one that can't work in a container); both count as booted. Timeout 180 s in the installer, 120 s when the launcher starts a stopped instance. |
| `--repo` in Docker mode | Must be a URL (`http(s)://`, `git://`, `ssh://`, `git@`): the image is built from a git build context `<repo>#<branch>:docker` and the container clones the repo itself, so neither can use a host path. Anything else is refused before changes are made. |
| Install inside | `docker exec -u japa` into the container clones `install.sh`'s repo at `--branch` into a temp dir and runs `install.sh --mode native --skip-setup --repo <repo> [--branch <b>]`; `--branch` is forwarded on a fresh install or when given explicitly. On a re-run the same command takes the native upgrade path (`japa update`). |
| Instance detection | An instance "exists" if its container carries `japa.instance=<name>` or its `japa-<name>-home` volume exists (so an instance removed by `japa uninstall` is re-created with its data by a re-run). Without `--mode`, an existing native `<dir>/app` wins, then an existing instance, then the question (tty) or Docker (no tty). |
| Upgrade | Rebuild the image; recreate the container only if the image id, the branch label or a requested port or web UI address changed, the container has no `japa.webuiPort` label (it predates the web UI publish), or the container is gone; else just start it if stopped. Recorded ports and address carry over to the recreated container. The branch defaults to the container's `japa.branch` label, not `main`. An upgrade failure names the step but removes nothing. |
| Fresh-install cleanup | An EXIT trap (with INT/TERM/HUP turned into exits) removes only the container, `-home`/`-docker` volumes, network and launcher file this run created, then reports `install failed at: <step>` (steps: image, instance, install japa inside, launcher). Setup failing afterwards doesn't undo the install. |
| Image tag | `japa-host:<branch>` with every character outside `A-Za-z0-9_.-` replaced by `-` (e.g. `feat/x` → `japa-host:feat-x`). The image is shared by instances on that branch and isn't removed by uninstall. |
| Instance name | `[a-z0-9][a-z0-9-]*`; the default is `$USER` lower-cased, other characters → `-`, leading `-` stripped (`japa` if empty). The same sanitisation picks the `$USER` instance in the launcher. |
| Launcher coexistence | The Docker launcher is marked by the line `# japa-docker-launcher`. Docker over a native launcher asks `[y/N]` (**default no**); declined or without a tty, the Docker launcher is `~/.local/bin/japa-docker`. Native over a Docker launcher asks `[y/N]` (default no); otherwise `~/.local/bin/japa-native`. Existing `japa-docker`/`japa-native` launchers are reused on re-runs. Native `japa uninstall` only removes `~/.local/bin/japa`, so a `japa-native` launcher is left for the user to remove. |
| Launcher environment | `docker exec -i [-t when stdin is a tty] -u japa -w /home/japa` with `HOME`, `USER`, `XDG_RUNTIME_DIR=/run/user/1000`, `DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus`, and `TERM`, `LANG`, `TZ` passed through; nothing else. Non-interactive setup therefore sets `JAPA_PROVIDER`/`JAPA_MODEL`/`JAPA_API_KEY` inside via `japa --instance <n> shell -c '…'` (`shell` passes its arguments to `bash -l`). |
| Launcher uninstall | `japa [--instance n] uninstall [--purge]`: removes the container and `japa-<n>-net`, reports the kept volumes; `--purge` needs a tty and the typed instance name. The launcher deletes itself when no instance containers remain (and only if it carries the marker). |
| `--non-interactive`, `--no-service`, `--dir` | In Docker mode `--non-interactive` (like `--skip-setup` or no tty) skips setup and prints `run \`japa --instance <n> setup\` to finish`; `--no-service` is passed to the setup run inside; `--dir` is ignored with a printed note. |
| Sysbox | Offered on Ubuntu/Debian (by `ID`/`ID_LIKE` in `/etc/os-release`, with `apt-get`) as the **Sysbox CE 0.7.1** `.deb` from the nestybox GitHub release, verified against a **pinned sha256** per arch (amd64, arm64), installed with `sudo apt-get install -y`, then re-checked in `docker info`'s runtimes. In a tty: warning that Docker restarts, `[Y/n]`; without one only with `--install-sysbox`, else exit non-zero naming Sysbox, `--install-sysbox` and the install docs. When still missing, a tty user is offered the native install `[Y/n]`. |
| Native mode | Unchanged apart from flag parsing and the launcher-coexistence check. The fresh default became Docker, so the existing installer tests set `JAPA_INSTALL_MODE=native`. |
| Tests | Unit tests with a fake `docker` on PATH (`test/install-docker.test.ts`, using the undocumented `JAPA_OS_RELEASE`, `JAPA_PROC_NET`, `JAPA_SYSBOX_BASE_URL` overrides); end to end `JAPA_SYSBOX_TESTS=1 npx vitest --run test/sysbox.test.ts`, against `JAPA_SYSBOX_TEST_REPO`/`JAPA_SYSBOX_TEST_BRANCH` (default the GitHub repo, `main`). |
