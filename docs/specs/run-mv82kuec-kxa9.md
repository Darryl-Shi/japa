# japa: web UI Settings, a live Desktop view, and no Status sheet

Status: approved for build. This is an incremental change to the `webui` surface (see the `webui` spec in `docs/spec.md`), with one small kernel seam and one small addition to the `desktop` extension. The builder folds it into `docs/spec.md` (in the `webui` section) and the README's Web UI section.

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
