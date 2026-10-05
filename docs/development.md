# Development

```bash
npm install
npm test          # the whole agent on pi-ai's faux provider: no API key needed
npm run check     # type-check
```

Tests reach japa the way a user's code would. A machine for a test is an extension declaring a backend, and the sandbox tests run installed extensions on a local machine that already has the packages.

## Layout

```
src/
  main.ts          the default extensions, and start
  japa.ts          the core, assembled; builds the Host and opens machines by role through their providers
  core/            our formats and services: messages, UI cards, schedules, approvals, memory, state (no Pi imports)
  pi/              Pi adapters and the built-in extensions
                   extension.ts: the one unit type and the Host · harness.ts: the main thread · inputs.ts: addressed
                   inputs · delegation.ts: the team · installer.ts: extensions from chat · sandbox.ts: their stand-ins
  sandbox/         host.mjs: an installed extension's process on its machine (plain JS, node:* only)
  channels/        the Inbox (allowlist gate), /settings, /login, /jobs, Telegram
  backends/        machine providers, as extensions: boat, local
docs/              these pages
```

Pi is pinned at 1.0.2 (`pi-durable`, `pi-ai`, `chord`). Pi is experimental, so our data formats live in `src/core`, and only `src/pi` imports Pi.

## Deploying

Push to `main`, then run the installer again on the server. It updates the code and moves anything from an older layout into place.

How to work on japa, and why it's shaped the way it is: [AGENTS.md](../AGENTS.md).
