# Development

```bash
npm install
npm test          # the whole agent on pi-ai's faux provider: no API key needed
npm run check     # type-check
```

Tests reach japa the way a user's code would. A test's agent gets a home of its own on this machine.

## Layout

```
src/
  main.ts          the default extensions, and start
  japa.ts          the core, assembled: what extensions are given (pi's API), and the agent's computer (this
                   machine, in its home)
  core/            our formats and services: messages, UI cards and dialogs, approvals, memory, state (no Pi imports)
  pi/              Pi adapters and the built-in extensions
                   extension.ts: pi's ExtensionAPI, on Pi Durable · harness.ts: the main thread · inputs.ts:
                   addressed inputs · delegation.ts: the team · computer.ts, skills.ts, history.ts: the rest of the
                   core · installer.ts: extensions from chat
                   memory.ts · approvals.ts · web.ts · screen.ts: the built-in extensions, one file each
  commands/        japa's /settings (with pi's /model and /thinking) and /jobs, and pi's /login, /logout and /session:
                   cards on the UI, on whichever channel is open
  channels/        the Inbox (allowlist gate), and Telegram
skills/            the skills japa ships with (extending-japa: how it extends itself)
docs/              these pages
```

Pi is pinned at 1.0.2 (`pi-durable`, `pi-ai`, `chord`). Pi is experimental, so our data formats live in `src/core`, and only `src/pi` imports Pi.

## Deploying

Push to `main`, then run the installer again on the server. It updates the code and moves anything from an older layout into place.

How to work on japa, and why it's shaped the way it is: [AGENTS.md](../AGENTS.md).
