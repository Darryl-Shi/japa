# Configuration

## From chat

- `/settings` is a button menu for the models, your name and time zone, and each extension's switch and options. Keys are set by replying to its question, and that message is then deleted. Changes apply immediately.
- `/login` logs in to a model provider, with an API key or the provider's own account login, and offers its models in `/settings`.

## Where data lives

Everything japa keeps is in one directory, `JAPA_DATA`. The default is `data/` in the checkout; it's gitignored and readable only by you.

| File | Holds |
|---|---|
| `settings.json` | settings, re-read when the file changes. The **allowlist** is edited only here: per platform, the user ids that may talk to the agent. An empty list lets no one in. |
| `auth.json` | model credentials (API keys or subscription logins) |
| `secrets.json`, `.env` | extension keys, as `<extension>.<key>` (Telegram's bot token is one). An extension's secret field can name an environment variable to fall back on; the defaults use `TELEGRAM_BOT_TOKEN`, `BOAT_API_KEY`, `PARALLEL_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN` or `ANTHROPIC_API_KEY`, `CODEX_API_KEY` |
| `session.sqlite`, `history.sqlite` | the durable state of every conversation and task; history search |
| `memory/` | its memory of you, a git repo |
| `open-items.json`, `working-set.json` | what's in progress, and the short working set each slice starts from |
| `extensions/` | extensions installed from chat: each one's code (and its own npm packages) in `<name>/<version>/` |
| `approvals.json`, `audit.jsonl` | standing permissions; every reviewed action |
| `boat-machines.json` | which boat.dev machine belongs to each role |
| `japa.log` | the log |

## Settings

| Setting | What it is |
|---|---|
| `model` | the chief of staff's model, as `{ provider, modelId }`. There's no default: you pick from the providers you've logged in to. |
| `delegateModel` | a job's model when the chief doesn't pick one. The default is the chief's model. |
| `jobModels` | named models the chief can assign to a job, such as `fast` or `strong` |
| `machines.workbench` | the agent's own computer, by machine provider name, with that provider's options |
| `user`, `timezone` | your name, and the time zone stamped on messages |
| `context` | when a new slice starts: `idleMinutes` without a message, or when a request would pass `sliceTokens` |
| `allowlist` | per platform, who may talk to it. It's edited only in this file. |
| `extensions` | per extension: `enabled`, and its own options |

## Machines

A machine is opened by role, through the provider its settings name:
- `boat`: boat.dev, a persistent Linux VM per role;
- `local`: this machine, for development only, since it holds japa's own secrets;
- any provider an installed extension declares.

A machine is opened when it's first needed, and again when its settings change.

**The workbench** on boat.dev is set with `{ "provider": "boat", "type": "small", "screen": true, "idleSeconds": 7200 }`, and its key in `/settings` → boat.dev. It sleeps after `idleSeconds` unused, and each command pushes that deadline back. The next command wakes it with the same disk.

