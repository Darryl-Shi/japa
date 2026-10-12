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
The contract for the current change is **docs/spec.md** (the `webui` browser chat surface); README.md documents the
whole product. Keep a short progress log in PROGRESS.md.

## Commands

- Setup: `scripts/setup.sh` (`npm ci` — its `prepare` builds the web UI — then `npm run build`)
- Test: npm test
- Typecheck: `npm run typecheck` (TypeScript 7 `tsc --noEmit` via `@typescript/native`, then `svelte-kit sync` +
  `svelte-check` on extensions/webui/app with TypeScript 6 — the root `typescript` dep is 6 because svelte-check and
  SvelteKit need its JS API; scripts and `japa check` call `node_modules/@typescript/native/bin/tsc` explicitly)
- Build the web UI: `npm run build` (extensions/webui/app → extensions/webui/build, git-ignored)
- Run: `scripts/run.sh` (foreground daemon; set `JAPA_HOME` to a scratch dir; needs a model in its settings.json)
- Check one extension: `node src/cli/main.ts check extension <name>`

## Running product

- Web UI: http://127.0.0.1:7337 (settings `extensions.webui.bind` / `.port`); token in `~/.japa/secrets/webui.token`
  (or `$JAPA_HOME/secrets/webui.token`). Sign in with `/?token=<token>`.
- `japa chat` talks to the daemon over `<home>/japa.sock`; `japa status` prints extension status lines.

## Map

- `src/kernel/` — boot, contracts (surfaces, messaging, triggers…), jobs, settings, secrets, check
- `src/cli/` — the `japa` CLI: daemon, chat, setup, update (rollback on failed steps: node, dependencies, build, validation)
- `src/sdk.ts` — the public `japa/sdk` for extensions
- `extensions/` — packaged extensions; `gateway` (terminal chat), `telegram`, `webui` (this change):
  - `extensions/webui/index.ts` — manifest + surface (token, status line, HTTP server, bridge on `Symbol.for("japa.webui.bridge")`)
  - `extensions/webui/server.ts` — Host/Origin checks, security headers, sign-in, session gate in front of SvelteKit
  - `extensions/webui/auth.ts` — token + HMAC session cookies; `live.ts` + `transcript.ts` — live hub / projection
  - `extensions/webui/app/` — SvelteKit 2 + Svelte 5 app; `src/lib/protocol.ts` is the surface↔app contract
- `install.sh` — bootstrap installer (steps: clone, node, dependencies, build, launcher)
- `test/` — vitest suites (`test/webui*.test.ts` for the web UI); `test/fixtures/mini-japa` for install.sh tests
- Vitest sets `JAPA_WEBUI_AUTOSTART=0` (and `JAPA_DESKTOP_AUTOSTART=0`) so test daemons don't bind 7337.
