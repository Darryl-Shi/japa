# Progress: files in and out (docs/spec.md)

## Done
- Contracts: IncomingFile, Incoming.files (images deprecated), OutgoingFile, Reply.file, SurfaceContext.input,
  MessagingAdapter.sendFile/maxFileBytes (optional, type-checked when present). Docs string updated.
- Inbound: `src/kernel/messaging/attachments.ts` async `inputOf` (save w/ sanitised names, notes, PDF text via unpdf
  with 30 s bound, `.txt` beside PDFs). `boot.ts` exposes it as `surface.input`; messaging surface uses it.
- Outbound: `send_file` tool (root only), `replies.ts` yields file replies on the same cursor, messaging `deliver`
  sends via `sendFile` or the 📎 fallback line; `~/.japa/outbox` created, ignored, mounted rw into jobs.
- Gateway transcript `📎 <path>` line. Telegram inbound kinds + outbound multipart sendFile.
- Prompt text (identity.md, WORKER_TEXT, writing-job-briefs), README, AGENTS.md, scripts/setup.sh, scripts/run.sh.

## Decisions
- PDF lib: `unpdf` (pure-JS pdf.js build). Timeout is a Promise.race (pdf.js runs on the main thread).
- Only jpeg/png/gif/webp images go inline to the model; other image types are saved and noted.
- Page header always `[PDF text, N pages]` as the spec writes it.
- A file of e.g. 50 MB + 1 B reports its exact byte count in "Too large" so it doesn't read "50 MB (max 50 MB)".
- No CI workflow: the spec doesn't ask for one, and sandbox tests need bubblewrap.
