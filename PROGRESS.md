# Progress — webui (run-mv45hubi-rq4k)

- [x] Deps: kit 2.70 + adapter-node 5 + svelte 5 + vite 8 + svelte-check; typescript 6 + @typescript/native (7). cookie override ^0.7.2 (audit clean).
- [x] App scaffold + protocol (extensions/webui/app/src/lib/protocol.ts)
- [x] Daemon side: index.ts / server.ts / auth.ts / live.ts / transcript.ts + tests (helper A)
- [x] App UI: routes, components, markdown, live client + markdown tests (helper B)
- [x] install.sh build step + test; japa update build step (+ rollback rebuild) + tests; mini-japa fixture build script
- [x] README, AGENTS.md, docs/spec.md implementation notes, scripts/setup.sh, scripts/run.sh
- [x] Manual e2e with curl against a real daemon (status line, 303/401/403, cookie, CSP, submit, SSE)

Decisions: see docs/spec.md "Implementation notes". "not built" line names the app dir (app/package.json has a build script).
No CI workflow: the repo has none and the spec doesn't ask for one.
- [x] Round 2: F1 referrer same-origin (form POST Origin), F2 default CSP never on 304s / only when app sets none, F3 drop stale steer bubbles, F4 entity decoding, F5 message_start text. Verified in headless Chromium (sign-in paste, reload, second tab).

---

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

---

# Progress (Docker hosting build)

- docker/Dockerfile + japa-novnc-forward.service: system container image (systemd, dockerd, Node 24, bwrap, socat 16080->127.0.0.1:6080).
- install.sh: --mode/--instance/--desktop-port/--install-sysbox; docker mode functions + embedded host launcher (docker_launcher_text).
- Decisions:
  - Docker mode requires a URL --repo (git build context + clone inside the container can't use host paths).
  - Container publishes 127.0.0.1:<port> -> 16080 (socat in image) -> inner desktop noVNC 127.0.0.1:6080.
  - Inner install = clone install.sh at --branch inside container (tmp), run `--mode native --skip-setup`; rerun = same (native rerun -> japa update).
  - Native over a Docker launcher: ask in a tty (default no), else native launcher goes to ~/.local/bin/japa-native.
  - Docker over a native launcher: ask (default no), else ~/.local/bin/japa-docker.
  - systemd wait accepts running or degraded.
  - Existing install-sh tests now set JAPA_INSTALL_MODE=native (fresh default became docker per spec).
- Tests: test/install-docker.test.ts, test/docker-launcher.test.ts (fake docker in test/fake-docker.ts), gated test/sysbox.test.ts (JAPA_SYSBOX_TESTS=1). Full suite + typecheck green.
- docker/Dockerfile builds locally (verified with legacy builder; Sysbox not available here, so e2e not run).
- README + docs/spec.md Outcome written; AGENTS.md, scripts/setup.sh, scripts/run.sh added.
- --non-interactive in Docker mode skips setup (as §4.3 step 5); --no-service is passed to the inner setup.
