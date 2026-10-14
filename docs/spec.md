# japa: current changes

This file carries four specs, each the contract for its ticket: the installer menu (Install / Update / Uninstall, JAPA-4), the `webui` browser chat surface (JAPA-2), files in and out (JAPA-1), and Docker hosting (JAPA-3).

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
  - The server projects pi-durable events into a simple transcript model, the same rules as `extensions/gateway/transcript.ts`: user / assistant / tool / info lines plus the streaming text. Reset handoffs and compaction summaries are hidden. The browser never receives raw model entries.
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

  A change takes effect when the surface next starts (a daemon restart or extension reload). The extension needs nothing to be set up, so it is **available by default**, and `japa setup` doesn't ask about it.
- **Access token:** a secret `webui.token`, declared with `generated: true`. On first start, if unset, the extension generates a random value of at least 32 bytes (URL-safe) and stores it in `~/.japa/secrets/webui.token`.
  - Every request other than the sign-in page and its static assets needs a valid session cookie. The cookie is `HttpOnly`, `SameSite=Strict`, path `/`, and set only after the token has been presented.
  - There are two ways to present it: pasting it into the sign-in page's single field, or opening `/?token=<token>`. The second sets the cookie and redirects to `/` with the token stripped from the URL.
  - A wrong token gets a generic error.
  - Changing the token (deleting the file and restarting, or setting a new value) invalidates existing sessions.
- **Request checks:**
  - Requests are refused unless their `Host` header names this server, which defends against DNS rebinding: `localhost`, `127.0.0.1`, the bound address or a name in `hosts`, or any IP literal (IPv4, or IPv6 in brackets). The port isn't checked (any port, or none), so an SSH tunnel to another local port and a port published by Docker work. IP literals are safe to accept because DNS rebinding always arrives with the attacker's domain name in `Host`, never a bare address; that also lets a LAN or VPN address reach a server that doesn't know it (a Docker instance's published port). A missing `Host`, a foreign name, and a name that merely starts with an address (`10.1.2.3.evil.example`) are refused.
  - State-changing requests must carry a matching `Origin`: `http://` followed by the `Host` header as sent.
  - Responses send a strict Content-Security-Policy: self only, no inline script beyond what SvelteKit's own CSP support hashes, and no third-party origins.
  - The page makes **no external network requests**: no CDNs and no web fonts fetched from the internet.
- **Status line:** the extension's `status()` line, shown under `webui` in `japa status` and Telegram's `/status`, is one of:
  - `http://<bind>:<port> — sign in with the token in ~/.japa/secrets/webui.token`
  - `not built — run npm run build in <app dir>`
  - `can't listen on <bind>:<port>: <reason>`

  In the last two cases the surface stays down and the daemon and other surfaces keep running. The token itself is never put in status output.

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
  - User turns appear as soft grey bubbles aligned right. Assistant turns are unboxed text aligned left. Tool calls are small muted chips (`⚙ tool_name`), and info and errors are muted inline notes.
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
- The README gains a **Web UI** section covering the URL, where the token is, the `bind` / `port` settings, SSH tunnelling (`ssh -L 7337:localhost:7337 <server>`) and Tailscale.
- The Development section adds `npm run build`, and the "Where state lives" section notes `webui.token`.
- `docs/spec.md` is updated to describe the `webui` surface.

## Acceptance behaviours

1. With a fresh `npm ci` and a running daemon, `japa status` lists `webui` with `http://127.0.0.1:7337 — sign in with the token in ~/.japa/secrets/webui.token`, and that file exists with mode 600.
2. Opening `http://127.0.0.1:7337/` without a session shows only a minimal sign-in page. A wrong token is refused. Opening `/?token=<token>` lands on the chat at `/` with the token gone from the address bar, and reloading keeps you signed in.
3. Requests to the API or live stream without a session cookie get 401. A request with a foreign `Host` header (a DNS name not in `hosts`) is refused, one addressed to an IP literal on any port is served, and a POST with a foreign `Origin` is refused.
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
  replace with their own hashed one, `nosniff`, `no-referrer`, `DENY` framing), sign-in (`POST /login`,
  `?token=`), and the session gate (401 JSON for `/api/*`, a redirect to `/login` for pages).
- **Sessions** are stateless: the cookie `japa_webui_session` is `<expiry>.<HMAC-SHA256(token, expiry)>`, valid 30
  days. Sessions survive daemon restarts, and changing the token invalidates them all.
- **API** (`extensions/webui/app/src/lib/protocol.ts`): `GET /api/events` (SSE: a snapshot, then `lines`, `delta`,
  `streaming`, `busy`, `transcript`, `jobs`, `secrets`), `POST /api/submit|abort|secrets/fulfil|secrets/decline`,
  `GET /api/status`.
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
| Desktop | Unchanged desktop extension, using the **inner** dockerd. Its image and container live in the instance's docker volume. |
| Tenancy model | **Operator-managed named instances.** One admin with host Docker access creates and manages instances. Tenants reach their japa through Telegram, or through a shell the admin opens for them in their own container. |
| Image source | Built locally on the host from the repo's `docker/` directory at the installed branch, using a git build context. No registry dependency. |

## 3. Host-side shape of a Docker instance

For an instance named `<name>`:

| Thing | Name / value |
|---|---|
| Container | `japa-<name>`, labels `japa.instance=<name>`, `japa.branch=<branch>`, `japa.desktopPort=<port>`, `japa.webuiPort=<port>`, `japa.webuiBind=<address>` |
| Volumes | `japa-<name>-home` → `/home/japa` (app checkout, `~/.japa`, the rest of the home); `japa-<name>-docker` → `/var/lib/docker` (inner images and containers, including the desktop and its home volume) |
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
  - dockerd enabled as a system service;
  - the `japa` user with lingering;
  - Node 24 on PATH, so the native installer uses it rather than downloading a private Node;
  - bubblewrap, git, tar and curl;
  - the noVNC and web UI port forwards (§3).
- **Google sign-in** uses the existing paste-the-redirect-URL fallback, because the OAuth loopback isn't reachable from the host browser. This is the same as over SSH today.
- **Inner Docker state stays in the instance.** The desktop's image builds and its home volume live in the inner Docker, so they are per instance and survive container recreation through `japa-<name>-docker`.

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
