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
