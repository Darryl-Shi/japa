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

japa: a personal chief-of-staff agent daemon (TypeScript on Node 24, run directly with type stripping). The spec for
the current change is `docs/spec.md` (the contract); older design docs live in `docs/superpowers/`.

- Setup: `scripts/setup.sh` (`npm ci`)
- Test: npm test
- Typecheck: `npm run typecheck`
- One test file: `npx vitest --run test/<name>.test.ts` (sandbox tests skip without bubblewrap)
- Run: `scripts/run.sh` (foreground daemon, `node src/cli/main.ts daemon`); chat with `node src/cli/main.ts chat`.
  The daemon serves no HTTP URL: the terminal chat talks to it over the unix socket `~/.japa/japa.sock`
  (`$JAPA_HOME` overrides `~/.japa`); Telegram is the default messaging adapter.

## Map

- `src/cli/` — the `japa` CLI (setup, daemon, chat, service, update…).
- `src/kernel/` — the daemon: `boot.ts` (wires everything), `contracts.ts` (the extension contracts, exported via
  `src/sdk.ts` as `japa/sdk`), `cos.ts` + `identity.md` (the CoS agent), `replies.ts` (reply stream),
  `send-file.ts` (the CoS's `send_file` tool), `files.ts` (sizes/MIME helpers), `messaging/` (the kernel side of
  chat platforms: routing, merging, menus, secret prompts, `attachments.ts` = inbound file conversion incl. PDF text),
  `jobs/` (background jobs), `sandbox/` (bwrap job sandboxes; mounts `attachments/` read-only, `outbox/` and
  `desktop/shared` writable), `memory/`.
- `extensions/` — packaged extensions: `telegram/` (messaging adapter: `updates.ts` inbound, `api.ts` Bot API incl.
  multipart, `index.ts` send/sendFile), `gateway/` (the `japa chat` surface), providers, schedule, google, …
- `skills/` — packaged skills (e.g. `writing-job-briefs`).
- `test/` — vitest tests; `*-helpers.ts` hold fakes (fake messaging adapter, fake Telegram Bot API).
