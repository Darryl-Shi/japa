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
