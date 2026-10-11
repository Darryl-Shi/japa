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

japa: a personal AI chief of staff (daemon + CLI, Node 24, TypeScript run directly by Node). The contract for the
current change is `docs/spec.md` (Docker hosting: Sysbox system containers, named instances); the README documents
install, running, state and uninstall.

- Setup: `scripts/setup.sh` (npm ci)
- Test: npx vitest --run
- Typecheck: `npm run typecheck`
- Run: `scripts/run.sh <command>` (e.g. `daemon`, `chat`, `status`, `--version`); `JAPA_HOME=<scratch>` for a throwaway daemon
- Gated e2e: `JAPA_DOCKER_TESTS=1 npx vitest --run test/desktop-docker.test.ts` (desktop on Docker),
  `JAPA_SYSBOX_TESTS=1 npx vitest --run test/sysbox.test.ts` (real Sysbox instances; needs Sysbox, a pushed branch:
  `JAPA_SYSBOX_TEST_REPO`, `JAPA_SYSBOX_TEST_BRANCH`)
- URL: no web server; `japa chat` talks over `~/.japa/japa.sock`. The desktop's noVNC is
  http://127.0.0.1:6080/vnc.html (natively), or http://127.0.0.1:<desktop port>/vnc.html for a Docker instance.

## Map

- `install.sh` — the installer: native mode, Docker mode (Sysbox instances) and the embedded host launcher
  (`docker_launcher_text`). POSIX sh, runs under `curl | sh`.
- `docker/` — the `japa-host` system container image (systemd, dockerd, Node 24, bwrap, noVNC forward on 16080).
- `src/cli/` — CLI commands (setup, service, update, uninstall, daemon); `src/kernel/` — the daemon, jobs, sandbox
  (bubblewrap), memory, messaging; `src/sdk.ts` — the extension SDK.
- `extensions/` — packaged extensions (telegram, desktop, google, search...); `skills/` — packaged skills.
- `test/` — vitest suites; `test/fake-docker.ts` is the fake `docker` for the installer/launcher tests;
  `test/fixtures/mini-japa` stands in for the repo in install tests.
- No container-specific code paths in `src/` or `extensions/` (spec §6): keep it that way.
