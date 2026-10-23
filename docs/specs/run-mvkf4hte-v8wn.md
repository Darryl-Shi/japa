# japa: files in and out of the web UI

Status: approved for build. This is an incremental change to the `webui` surface, plus one small additive change to the kernel's surface contract (`InputSource`). The builder folds it into `docs/spec.md` (the `webui` section, the surface contract and the "files in and out" section), the README's Web UI section and PROGRESS.md.

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
