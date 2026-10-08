# japa — computer use (`desktop` extension)

Date: 2026-10-08
Status: Draft for review
Extends: `2026-10-07-japa-design.md` (the "main spec")

## 1. Purpose

japa gets a computer of its own: a persistent, sandboxed Linux desktop on the
server it runs on, which it operates like a person (screen, mouse, keyboard)
and, for web pages, through the browser's own structure. Use cases are up to
the user — web tasks on sites without an API, logged-in portals, research on
JavaScript-heavy sites, desktop applications, testing what japa builds — so
the desktop is as capable as practical and keeps its state (logins, files,
installed software).

Success:

- An `operator` job can complete multi-step tasks in a browser or desktop
  app, using any vision-capable model.
- Logins made once (by japa, or by the user taking over through noVNC) stay
  logged in across jobs and daemon restarts.
- The CoS can glance at the desktop but delegates every action to an operator
  job.
- No approval gates (consistent with the main spec); the user decides what
  the desktop has access to.

### Approach

Current practice (October 2026) has no single winner: provider-native
computer-use tools (Anthropic `computer_toolset_20260801`, OpenAI GPT‑5.4,
Gemini `computer_use`) are the most accurate on their own models, but differ
between providers and change often; generic screenshot tools work with any
vision model; for web pages, a semantic layer (Playwright/CDP accessibility
snapshots, as in Stagehand and Browser Use) is more accurate and cheaper than
pixels. japa uses a **hybrid behind its own tool interface**: a pixel tool
for the whole desktop, a semantic browser tool on the same Chromium, and a
shell environment, all in one sandbox. Provider-native tools or a separate
grounding model (UI‑TARS, OpenCUA) can be added later behind the same tools.

### Out of scope

Provider-native computer-use APIs, grounding models, more than one desktop,
parallel operators, Windows/macOS desktops, recording or replaying sessions,
approval gates, a desktop on the user's own machine.

## 2. Components

```
japa daemon (host)                                   desktop container (Docker, kept running)
┌──────────────────────────────────────┐            ┌─────────────────────────────────────────────┐
│ extensions/desktop                   │            │ supervisord: Xvfb :1 (1280×800) · XFCE ·     │
│  environment "desktop" ──────────────┼─ docker ──▶│   Chromium (CDP :9222) · x11vnc · noVNC     │
│   (ExecutionEnv over docker exec)    │   exec     │ user `japa` (passwordless sudo)             │
│  tool computer ──────────────────────┼─ docker ──▶│ xdotool · screenshots · xclip               │
│  tool browser  ──────────────────────┼─ CDP  ────▶│ Chromium, profile in /home/japa             │
│   (playwright-core connectOverCDP)   │            │                                             │
│  desktop lock (one operator at once) │            │ volume japa-desktop-home → /home/japa       │
│  durable hook: keep 3 latest images  │            │ ~/.japa/desktop/shared ↔ /home/japa/shared  │
└──────────────────────────────────────┘            │ ~/.japa/attachments → /home/japa/attachments│
workers/operator.md                                  │                       (read-only)           │
                                                     └─────────────────────────────────────────────┘
```

### 2.1 The extension (`extensions/desktop/`)

```ts
defineJapaExtension({
  name: "desktop",
  summary: "Gives me my own computer: a desktop with a browser and apps that I can see and operate",
  examples: ["log into my utility portal and download the latest bill", "what's on the desktop right now?"],
  docs: "./skills/using-the-desktop/SKILL.md",
  provides: { environment: [desktopEnv], tool: [computer, browser] },
  durable: { hooks: [keepRecentImages] },
  secrets: ["desktop.vncPassword"],
  settings: Type.Object({
    cpus: Type.Optional(Type.Number()),     // default 2
    memory: Type.Optional(Type.String()),   // default "4g"
    shm: Type.Optional(Type.String()),      // default "2g"
    bind: Type.Optional(Type.String()),     // address noVNC listens on; default "127.0.0.1"
  }),
});
```

Files: `index.ts` (manifest), `container.ts` (build, create, start, health,
exec), `env.ts`, `computer.ts`, `browser.ts`, `lock.ts`, `images.ts` (the
hook), `Dockerfile`, `supervisord.conf`, `skills/using-the-desktop/SKILL.md`,
and tests.

### 2.2 The `desktop` environment

An `ExecutionEnv` whose commands and file operations run inside the container
as user `japa` (`docker exec -u japa -w <cwd> japa-desktop …`), with
`DISPLAY=:1` set, so a job's `bash`, `read`, `write` and `edit` act on the
desktop's file system. The default cwd is `/home/japa`. It passes Pi Durable's
`registerEnvConformance()` tests. The environment object carries a marker the
tools check (§3).

### 2.3 The `operator` worker profile (`workers/operator.md`)

```yaml
name: operator
description: Operates japa's own desktop computer — browser and apps — to get things done on websites and in programs.
tools: [read, write, edit, bash]
environment: desktop
extensions: [desktop]
```

No `model` is set (it uses `models.worker`); the user or the CoS can override
it with a workspace profile that names a stronger vision model. The prompt
says:

- Prefer `browser` for web pages; use `computer` for other apps, for things
  the browser layer can't reach (canvas, extensions, native dialogs), or when
  a ref-based action fails.
- Look before acting and verify after: check the returned state after every
  action, and zoom for small text.
- For MFA, CAPTCHAs, payments needing the user's device, or anything only the
  user can do, end the turn asking the user to finish it in the desktop (the
  job goes to `needs_input`); continue when the CoS relays that it's done.
- Save files meant for the user or other jobs to `~/shared`; files the user
  sent are in `~/attachments`.
- System packages installed with `apt` are lost when the desktop image is
  upgraded; anything under home is kept.
- Finish with what was done, where the results are, and anything left undone.

### 2.4 The CoS

The CoS gets the `computer` and `browser` tools like every extension tool,
but runs in the read-only local environment, so only their read actions work
for it (§3). The `using-the-desktop` skill and the CoS's delegation guidance
say: glance yourself; start an `operator` job for anything that acts.

## 3. Tools

Two tools, each with an `action` parameter — the single-tool shape providers
train computer use on, and short tool definitions. **Read actions** work from
any environment. **Every other action** requires the calling conversation's
environment (`api.env`) to be the desktop environment; otherwise it returns
"This acts on the desktop — start an operator job for it." Every action needs
the container running (§4.4).

### 3.1 `computer` — pixels, for the whole desktop

| Action | Parameters | Notes |
|--------|------------|-------|
| `screenshot` (read) | — | PNG of the 1280×800 display; coordinates are 1:1 with the screen. |
| `zoom` (read) | `region: [x1, y1, x2, y2]` | Crop scaled up to fit 1280×800. |
| `cursor_position` (read) | — | |
| `click` | `x, y, button? ("left"\|"right"\|"middle"), count? (1–3), modifiers? (["ctrl", "shift", "alt", "super"])` | |
| `mouse_down`, `mouse_up` | `x, y, button?` | |
| `move` | `x, y` | |
| `drag` | `path: [[x, y], …]` (≥ 2 points) | |
| `scroll` | `x, y, direction ("up"\|"down"\|"left"\|"right"), amount (wheel clicks)` | |
| `type` | `text` | Typed in chunks of 50 characters, with a short delay between keys. |
| `key` | `combo` (xdotool syntax, e.g. `ctrl+l`, `Return`), `hold?` (seconds) | |
| `wait` | `seconds` (≤ 30) | |
| `clipboard_get` (read) | — | |
| `clipboard_set` | `text` | |

Actions run as `xdotool` / `xclip` / `import -window root png:-` commands
through `docker exec`. Every action except `wait`, `cursor_position` and
`clipboard_get` returns a screenshot taken 500 ms after it finishes, unless
`screenshot: false`. Results are image content plus one text line (the
action, and the cursor position).

### 3.2 `browser` — semantic, on the same Chromium

`playwright-core` connects over CDP to the desktop's Chromium
(`connectOverCDP("http://127.0.0.1:9222")`), so the browser the user sees in
noVNC, its tabs and its persistent profile are the ones the tool drives. The
connection is opened on first use and reopened if lost.

| Action | Parameters | Notes |
|--------|------------|-------|
| `tabs` (read) | — | Id, title and URL of each tab; marks the current one. |
| `snapshot` (read) | `tab?` | URL, title and the accessibility tree (Playwright's aria snapshot) with element refs (`e12`), capped at 8,000 tokens with a note when cut. |
| `text` (read) | `ref?` | Readable text of the page or of one element, capped like `snapshot`. |
| `screenshot` (read) | `ref?, fullPage?` | |
| `navigate` | `url` | |
| `back`, `forward`, `reload` | — | |
| `tab_new` | `url?` | |
| `tab_select`, `tab_close` | `id` | |
| `click`, `hover` | `ref`, `button?`, `count?` | |
| `type` | `ref, text, submit?` | Replaces the field's content; `submit` presses Enter. |
| `select` | `ref, values` | |
| `press` | `key` | Playwright key syntax. |
| `upload` | `ref, paths` | Paths inside the container. |
| `wait_for` | `text?, ref?, gone?, timeout?` (≤ 30 s) | |
| `dialog` | `accept, text?` | Answers the pending JavaScript dialog. |
| `evaluate` | `js` | Runs in the page; returns the JSON result, capped. |

Refs are valid until the next snapshot of that tab; a stale ref returns
"Element e12 is gone — take a new snapshot." Every action returns the new
snapshot, or, when the page did not navigate, the lines that changed. File
downloads are saved to `/home/japa/Downloads`, and the result lists their
paths.

### 3.3 Keeping context small

Each screenshot costs about 1–1.5k tokens. The extension's durable hook
rewrites the model context of every conversation so that only the **3 most
recent images from `computer` or `browser` results** remain; older ones
become the text `[earlier screenshot omitted]`. Stored entries are not
changed. The stateless-CoS reset (separate spec) clears the CoS's glances
after each turn anyway.

### 3.4 The desktop lock

One operator at a time. The first action call from a job takes the lock (a
durable doc holding the job id). A call from another job waits, reporting job
progress "Waiting for the desktop (in use by job N)", and retries until the
lock is free. The lock is released when its job finishes, fails or is
aborted; a lock whose job is no longer running is taken over. Read actions
and the CoS never take the lock.

## 4. The sandbox

### 4.1 Image

`extensions/desktop/Dockerfile`, multi-arch (amd64, arm64):

- Ubuntu 24.04; Xvfb at 1280×800×24; XFCE; supervisord managing Xvfb,
  XFCE, Chromium, x11vnc and noVNC (`websockify`).
- Chromium (non-snap build) started with `--remote-debugging-port=9222
  --remote-debugging-address=127.0.0.1 --user-data-dir=/home/japa/.config/chromium`,
  restarted by supervisord if it exits.
- LibreOffice, a file manager, a PDF viewer; xdotool, xclip, ImageMagick,
  Python 3, Node.js, git, curl, ffmpeg, unzip; Noto fonts including CJK and
  emoji.
- User `japa` (uid 1000) with passwordless sudo.
- A label `japa.desktop.hash` holding the hash of the Dockerfile and
  `supervisord.conf`.

### 4.2 Persistence

- The container `japa-desktop` is created once and started on daemon boot (if
  it exists) or first use. It is never removed in normal operation, so
  software installed with `apt` and open windows survive daemon restarts.
- `/home/japa` is the named volume `japa-desktop-home`: browser profile,
  logins, files. It survives container recreation.
- **Upgrade:** when the image hash label differs from the extension's files,
  the extension rebuilds the image, recreates the container with the same
  volume and mounts, and tells the CoS through the kernel context's
  `trigger.emit` (key `upgrade:<hash>`) that system-level installs were reset.
- Mounts: `~/.japa/desktop/shared` ↔ `/home/japa/shared` (read-write);
  `~/.japa/attachments` → `/home/japa/attachments` (read-only).

### 4.3 Access

- noVNC on `<bind>:6080` (default `127.0.0.1`), protected by the VNC password
  in secret `desktop.vncPassword` (generated at first start, 16 random
  characters, stored through the secrets store). The user reaches it with an
  SSH tunnel (`ssh -L 6080:localhost:6080 <server>`) or by setting `bind` to
  a Tailscale address. `japa status` lists the URL, and the skill tells the
  CoS how to explain access.
- CDP is published on `127.0.0.1:9222` only.
- The container is not privileged, has no Docker socket and no other host
  mounts, and has full outbound network access. Limits: `--cpus`, `--memory`,
  `--shm-size` from settings.

### 4.4 Lifecycle and errors

- **Docker missing** or not usable by the daemon's user: activation fails
  with "The desktop needs Docker: <reason>" (shown in `japa status`; the
  main spec's §10.4 applies).
- **First build** runs in the background after activation (minutes); until it
  is ready, actions answer "The desktop is starting (building its image) —
  try again in a few minutes."
- **Container stopped or crashed:** the next call starts it and waits up to
  60 s for X and CDP to answer.
- **Chromium or X crash:** supervisord restarts them; the browser tool
  reconnects.
- **CDP unavailable** after a restart: `browser` answers with the reason;
  `computer` still works.
- **Command failures** (xdotool, screenshot) return the error text as the
  tool result; they never throw past the tool.

## 5. Dependencies and docs

- New dependency: `playwright-core` (client library only, no bundled
  browsers), for CDP accessibility snapshots and element actions.
- README: Docker is required for the desktop; how to reach noVNC.
- Main spec §11.1: add the `desktop` row; §11.2: add the `operator` profile.
- Agent-facing skill `using-the-desktop` (bundled with the extension): when to
  glance and when to delegate, how to brief an operator job, how the user
  takes over, where files go.

## 6. Testing

Unit (vitest, a fake exec runner standing in for `docker exec`):

- Each `computer` action builds the right command; screenshots come back as
  PNG image content; `screenshot: false`; `type` chunking; `zoom` crop.
- Read actions work from a non-desktop environment; every other action is
  refused there with the operator message.
- Lock: second job waits and reports progress; release on finish, failure and
  abort; takeover of a lock whose job is not running; reads never lock.
- Image hook: only the 3 most recent images remain in the model context;
  stored entries unchanged.
- `browser` snapshot capping and stale-ref message (Playwright against a fake
  page object).
- Container: create and start arguments (limits, mounts, ports, bind), the
  hash label check and recreate-with-same-volume path, "Docker missing" and
  "starting" messages.

Integration (run only when Docker is available, `JAPA_DOCKER_TESTS=1`):

- The image builds and the container starts; a screenshot is a 1280×800 PNG.
- `computer click` and `type` change a test page; `browser navigate` to a
  page served from the shared folder returns refs, and `click` by ref works.
- A cookie set in the browser survives a container restart and a recreate.
- The `desktop` environment passes `registerEnvConformance()`.
- An `operator` job, with the faux model's scripted calls, opens a page and
  reports its heading.
