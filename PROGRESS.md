# Progress — Web UI section in `japa setup` (run-mv82d2v6-spil)

- [x] `src/cli/webui-step.ts` (overview, select loop, bind/port/hosts/on-off/reset, validated writes) + rerun menu item
- [x] `test/setup-webui.test.ts` (fake prompter, injected `SetupOptions.interfaces`)
- [x] README (setup paragraph, rerun menu, Web UI Settings bullet), docs/spec.md (new spec + webui §2.3 note), AGENTS.md map

Decisions: unchanged values write nothing; Reset and the 0.0.0.0 warning default to No; addresses labelled
"<ip> (<iface>)" / "<ip> (Tailscale, <iface>)" in the label (round 2: clack hides hints off-cursor); Other… with
0.0.0.0/:: asks the plain-HTTP confirm too; empty `{}` left after removing the last key. No CI workflow
(none in the repo; not asked for).

---

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

# Progress: installer menu (docs/specs/run-mv4qu21g-84sb.md)

## Done
- install.sh: menu (Install/Update/Uninstall/Quit) on fd 3 from `JAPA_INSTALL_TTY` (default /dev/tty); foreign app/
  refused before the menu; prerequisites only for Install/Update; Uninstall: removal + data prompts, probe
  (launcher → marked node/ ≥24 → system node ≥24, then `--version`), delegated `uninstall [--purge]` or shell fallback
  mirroring uninstall.ts (best-effort, non-zero on failed steps).
- mini-japa fixture: `mini-dep` file: dependency (so removing node_modules breaks the probe) + `uninstall` stand-in.
- 19 new tests in test/install-sh.test.ts; README, docs/spec.md (incl. implementation notes), AGENTS.md.

## Decisions
- See docs/spec.md "installer menu" → Implementation notes. EOF at any prompt = no; Ctrl-C at menu = 130.
- No CI workflow: the spec doesn't ask for one.

## Integration (bundle-5: installer menu + Docker hosting)
- The menu comes first; Install then asks the Docker/native mode question (unless `--mode`), Update upgrades the
  existing install in its own mode (native `<dir>/app`, else the Docker instance), Uninstall removes the native install
  at `<dir>` (a Docker instance is removed with `japa --instance <n> uninstall`).
- The "replace the Docker launcher?" question moved after the menu (only for a native Install/Update).
- One `has_tty`/`TTY` at the top; after the menu every terminal read (mode, Sysbox, launcher questions, setup) uses fd 3.

---

# Progress: provider building blocks in japa/sdk

- `japa/sdk` exports pi-ai's `createProvider`, `envApiKeyAuth`, the lazy Anthropic Messages / OpenAI Responses / Chat Completions APIs, `createAssistantMessageEventStream`, `isRetryableAssistantError`, `isContextOverflow` and their types, so a workspace extension can register a model provider (and wrap its streams, e.g. to retry); test/check.test.ts checks one.

---

# Progress: Docker instances publish the web UI

- webui: the Host check (`acceptedHost` in extensions/webui/server.ts) accepts any IP literal (IPv4, bracketed IPv6)
  and `localhost` / `127.0.0.1` / `bind` / the new `extensions.webui.hosts` names, all on any port; foreign DNS names
  and a missing Host are still refused, and the Origin check is unchanged. `PipelineDeps.port` is gone (unused now).
- docker/: `japa-webui-forward.service` (socat 17337 → 127.0.0.1:7337), enabled in the Dockerfile, `EXPOSE 17337`.
- install.sh: `--webui-port` (default first free from 7337, skipping other instances' desktop/web UI ports, listening
  ports and this instance's desktop port) and `--webui-bind` (IPv4, default 127.0.0.1), validated before the build;
  publish `<bind>:<port>:17337`, labels `japa.webuiPort` / `japa.webuiBind`; an upgrade keeps them, recreating when
  they change or the label is missing (older instances); install and upgrade print the web UI URL; `japa instances`
  has a WEB UI column. README, docs/spec.md (webui §2.3, Docker hosting §3-§5 and Outcome) updated.

---

# Progress: Docker upgrade rewrites the host launcher

- [x] `docker_upgrade` always rewrites the Docker launcher (was: only when missing), so launcher changes (e.g. the WEB UI column) reach upgraded hosts. Tests in install-docker.test.ts; spec §4.4, README.
- [x] README: one-off `ssh <server> 'japa …'` needs `~/.local/bin/japa` (non-interactive shells stop reading ~/.bashrc before the PATH line).

---

# Progress: inner Docker state survives a recreate; the desktop recovers from lost layers

- Bug: Docker 29 in japa-host defaulted to the containerd image store, so the inner images/layers lived in
  /var/lib/containerd (the container's writable layer) and were lost on every upgrade recreate, while
  /var/lib/docker (container records, BuildKit cache) survived: `RWLayer … is unexpectedly nil`, then builds failing on
  a stale cache.
- docker/Dockerfile: `/etc/docker/daemon.json` = `{"features":{"containerd-snapshotter":false}}` (classic overlay2,
  all under the japa-<name>-docker volume). The first upgrade to it rebuilds the desktop image once.
- extensions/desktop/container.ts: a current container whose `start` fails → `rm -f` and recreate (rebuilding the image
  if it's gone), telling the CoS (`RECREATED`); a fresh `run` that fails → `rm -f` + `image rm -f` + rebuild; each at
  most once until the desktop next comes up, then the error is reported as before. A failed build →
  `builder prune -af` → one retry. The home volume is never touched. Tests in test/desktop-container.test.ts; the gated
  sysbox e2e checks the inner Driver is overlay2. README (Desktop, Where state lives), docs/spec.md (Docker hosting).

---

# Progress: web UI Settings, Desktop panel, no Status (run-mv82kuec-kxa9)

- [x] Contracts: `AdminContext`/`ProviderInfo`/`ModelInfo` in contracts.ts (+ sdk), protocol.ts (Settings/Desktop/flows API)
- [x] Kernel: admin context (src/kernel/admin.ts) + tests
- [x] webui server: settings bridge, flows, endpoints, ws proxy; desktop view handle
- [x] UI: Settings area, Desktop panel (noVNC), top bar, Status removed
- [x] Docs: README, docs/spec.md, AGENTS.md
- [x] japa check extension <packaged> loads in place (was failing at base for desktop)
- Manual: curl e2e against a real daemon (settings set/Not changed, api_key flow, oauth flow + 409 + cancel, ws 401/403). Real VNC not verifiable here (sandboxed net).

Decisions:
- "Packaged" = not loaded from the workspace (`<home>/extensions`): extensions handed to `boot` in code (tests) count as packaged.
- `admin.tool` only runs `schedule_*` tools.
- Sign-in flows are polled by the starting tab (GET /api/signin/<id>, ~1 s).
- Round 2: F1 desktop handle `enabled()` → webui treats off as unavailable (view/start/ws) + tests. F3 run.sh writes a starter settings.json when none exists (dev script only; kernel unchanged).

---

# Progress: web UI password users (run-mv82cc59-8jx1)

- [x] `extensions/webui/users.ts` (file, scrypt N=2^15 r=8 p=1, stamps, atomic writes, mtime-cached store),
      `auth.ts` (per-user session cookie `<name>.<expiry>.<mac>`, throttle, dummy hash), `server.ts` (POST /login
      username/password, 429, POST /logout, username to the app), `index.ts` (`webui.session-key`, status lines).
- [x] CLI `japa webui users add|passwd|remove|list` (`src/cli/webui-users.ts`), usage text; `/webui/` in IGNORED.
- [x] App: login page (username/password, no-users page, unreadable note), top bar user + Sign out, locals.user via
      `event.platform.req[Symbol.for("japa.webui.request")]`, chat page's `+page.server.ts` returns `{ user }`.
- [x] Tests: test/webui-users.test.ts (real CLI, --password-stdin), webui-server/webui tests rewritten, install-docker
      message asserts, job-sandboxes test that a job can't read webui/users.json (skips here: no userns for bwrap).
- [x] Docs: README, AGENTS.md, docs/spec.md, install.sh messages, scripts/run.sh comment.
- [x] Manual e2e: real daemon + curl + headless Chromium (sign in, wrong password, reload, sign out → 401, passwd → 401,
      throttle 429, ?token= ignored).

Decisions:
- `.gitignore` line is `/webui/` (anchored), not `webui/`: unanchored would also ignore a component's `extensions/webui/`.
- The CLI runs `ensureWorkspace(home)` before writing, so the ignore line exists even before the daemon restarts.
- The status line is read synchronously (`loadSync`, cached by stat), so `japa status` follows the file with no restart.
- Malformed-file reason is "not valid JSON" without the parser's message (it would quote hashes).
- Login page with an unreadable users file still shows the form plus a note pointing at `japa status`.
- The Docker upgrade message also mentions `webui users add` (instances upgraded from the token era need a user).
- `--password-stdin` reads only the first line; interactive input validates the first entry before asking again.
- No CI workflow: the spec doesn't ask for one (as before).
- [x] Round 2: F1 throttle reserves a slot before scrypt (parallel guesses capped at 10; test); F2 dummy hash made at pipeline creation.
- [x] Integration with run-mv82kuec-kxa9 (bundle-21): the Desktop websocket proxy checks the per-user session
      (users + session key) instead of the token, and its 30 s recheck ends a connection on passwd/remove/new key;
      the top bar keeps Jobs, Desktop, Settings plus the user and Sign out.
