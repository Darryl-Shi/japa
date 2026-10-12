# Agent directives

## Subagent models

- Every subagent (implementers, reviewers, re-reviewers, explorers, workflow agents) runs on **Opus 5.5 only**:
  `model: "anthropic/claude-opus-5-5"`. Never sonnet, haiku, or another Opus version, and never a fuzzy name
  like `"opus"` (it can resolve to a different version).
- Thinking level is **medium to xhigh only**: `thinking: "medium" | "high" | "xhigh"`. Never `off`, `minimal`,
  `low` or `max`. Always set it explicitly, so it isn't inherited.
- Pick within that range by difficulty: `medium` for small, mechanical fixes and scoped re-reviews; `high` for
  ordinary implementation and task reviews; `xhigh` for final whole-branch reviews and risky work (install,
  update, rollback, security).
- This overrides any skill's model-selection advice (e.g. "use the cheapest model").

## Project

japa: a personal chief-of-staff agent daemon (Node 24, TypeScript run directly with type stripping, ESM).
The contract is **docs/spec.md** (the `webui` browser chat surface, files in and out, and Docker hosting: Sysbox
system containers, named instances); README.md
documents the whole product; older design docs live in `docs/superpowers/`. Keep a short progress log in PROGRESS.md.

## Commands

- Setup: `scripts/setup.sh` (`npm ci` — its `prepare` builds the web UI — then `npm run build`)
- Test: npm test
- One test file: `npx vitest --run test/<name>.test.ts` (sandbox tests skip without bubblewrap)
- Typecheck: `npm run typecheck` (TypeScript 7 `tsc --noEmit` via `@typescript/native`, then `svelte-kit sync` +
  `svelte-check` on extensions/webui/app with TypeScript 6 — the root `typescript` dep is 6 because svelte-check and
  SvelteKit need its JS API; scripts and `japa check` call `node_modules/@typescript/native/bin/tsc` explicitly)
- Build the web UI: `npm run build` (extensions/webui/app → extensions/webui/build, git-ignored)
- Run: `scripts/run.sh` (foreground daemon; set `JAPA_HOME` to a scratch dir; needs a model in its settings.json);
  `scripts/run.sh <command>` runs any other CLI command (e.g. `chat`, `status`, `--version`).
- Gated e2e: `JAPA_DOCKER_TESTS=1 npx vitest --run test/desktop-docker.test.ts` (desktop on Docker),
  `JAPA_SYSBOX_TESTS=1 npx vitest --run test/sysbox.test.ts` (real Sysbox instances; needs Sysbox, a pushed branch:
  `JAPA_SYSBOX_TEST_REPO`, `JAPA_SYSBOX_TEST_BRANCH`)
- Check one extension: `node src/cli/main.ts check extension <name>`

## Running product

- Web UI: http://127.0.0.1:7337 (settings `extensions.webui.bind` / `.port`); token in `~/.japa/secrets/webui.token`
  (or `$JAPA_HOME/secrets/webui.token`). Sign in with `/?token=<token>`.
- `japa chat` talks to the daemon over `<home>/japa.sock`; `japa status` prints extension status lines.
  Telegram is the default messaging adapter.
- Desktop noVNC: http://127.0.0.1:6080/vnc.html (natively), or http://127.0.0.1:<desktop port>/vnc.html for a Docker
  instance (`japa instances` lists them).

## Map

- `src/cli/` — the `japa` CLI: daemon, chat, setup, service, update (rollback on failed steps: node, dependencies,
  build, validation)
- `src/kernel/` — the daemon: `boot.ts` (wires everything), `contracts.ts` (the extension contracts, exported via
  `src/sdk.ts` as `japa/sdk`), `cos.ts` + `identity.md` (the CoS agent), `replies.ts` (reply stream),
  `send-file.ts` (the CoS's `send_file` tool), `files.ts` (sizes/MIME helpers), `messaging/` (the kernel side of
  chat platforms: routing, merging, menus, secret prompts, `attachments.ts` = inbound file conversion incl. PDF text),
  `jobs/` (background jobs), `sandbox/` (bwrap job sandboxes; mounts `attachments/` read-only, `outbox/` and
  `desktop/shared` writable), `memory/`, settings, secrets, check.
- `src/sdk.ts` — the public `japa/sdk` for extensions
- `extensions/` — packaged extensions: `telegram/` (messaging adapter: `updates.ts` inbound, `api.ts` Bot API incl.
  multipart, `index.ts` send/sendFile), `gateway/` (the `japa chat` surface), providers, schedule, google, `webui`:
  - `extensions/webui/index.ts` — manifest + surface (token, status line, HTTP server, bridge on `Symbol.for("japa.webui.bridge")`)
  - `extensions/webui/server.ts` — Host/Origin checks, security headers, sign-in, session gate in front of SvelteKit
  - `extensions/webui/auth.ts` — token + HMAC session cookies; `live.ts` + `transcript.ts` — live hub / projection
  - `extensions/webui/app/` — SvelteKit 2 + Svelte 5 app; `src/lib/protocol.ts` is the surface↔app contract
- `skills/` — packaged skills (e.g. `writing-job-briefs`).
- `install.sh` — the installer: with a terminal, a menu first (Install / Update / Uninstall / Quit); native mode
  (steps: clone, node, dependencies, build, launcher; Uninstall delegates to `japa uninstall` or removes directly),
  Docker mode (Sysbox instances) and the embedded host launcher (`docker_launcher_text`). POSIX sh, runs under
  `curl | sh` (tests: `JAPA_INSTALL_TTY`).
- `docker/` — the `japa-host` system container image (systemd, dockerd, Node 24, bwrap, noVNC forward on 16080).
- `test/` — vitest suites (`test/webui*.test.ts` for the web UI; `*-helpers.ts` hold fakes: fake messaging adapter,
  fake Telegram Bot API); `test/fake-docker.ts` is the fake `docker` for the installer/launcher tests;
  `test/fixtures/mini-japa` for install.sh tests
- Vitest sets `JAPA_WEBUI_AUTOSTART=0` (and `JAPA_DESKTOP_AUTOSTART=0`) so test daemons don't bind 7337.
- No container-specific code paths in `src/` or `extensions/` (Docker hosting spec §6): keep it that way.
