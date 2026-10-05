# Configuration

## From chat

- `/login` logs in to a model provider (an API key, or the provider's own account login), and `/logout` removes a credential. Both are pi's own commands.
- `/model` picks the model for each slot: the chief of staff, jobs, and each named job model; `/thinking` sets how hard each one thinks, from the levels its model supports.
- `/settings` is a button menu for the models, your name and time zone, and each extension's switch. Changes apply immediately.
- An extension's own settings are its own command, as in pi: `/web` for the web's key, `/approvals` for the approval mode and standing permissions. A key is set by replying to its question, and that message is then deleted.

## Where data lives

Everything japa keeps is in one directory, `JAPA_DATA`. The default is `data/` in the checkout; it's gitignored and readable only by you.

| File | Holds |
|---|---|
| `settings.json` | settings, re-read when the file changes. The **allowlist** is edited only here: per platform, the user ids that may talk to the agent. An empty list lets no one in. |
| `auth.json` | model credentials (API keys or subscription logins), pi's own format: set with `/login`, or by the installer |
| `secrets.json`, `.env` | extension keys, as `<extension>.<key>` (Telegram's bot token is one). An extension can name an environment variable to fall back on (`pi.secrets.get(key, env)`); the defaults use `TELEGRAM_BOT_TOKEN` and `PARALLEL_API_KEY`. Variables named this way are taken out of the environment the agent's commands run in |
| `session.sqlite`, `history.sqlite` | the durable state of every conversation and task; history search |
| `memory/` | its memory of you, a git repo |
| `open-items.json`, `working-set.json` | what's in progress, and the short working set each slice starts from |
| `extensions/` | extensions installed from chat: each one's code (and its own npm packages) in `<name>/<version>/` |
| `approvals.json`, `approvals-options.json`, `audit.jsonl` | approval requests; the mode and standing permissions (`/approvals`); every reviewed action |
| `telegram-asks.json` | Telegram's questions waiting for your reply (a value for `/settings`, a login's key, an extension's question), so an answer sent across a restart still reaches its card, not the agent |
| `japa.log` | the log |

## Settings

| Setting | What it is |
|---|---|
| `model` | the chief of staff's model, as `{ provider, modelId, thinking? }`. There's no default: you pick from the providers you've logged in to. `thinking` is one of pi's levels (`off`, `minimal`, `low`, `medium`, `high`, …, as the model supports); every model slot has one. |
| `delegateModel` | a job's model when the chief doesn't pick one. The default is the chief's model. |
| `jobModels` | named models the chief can assign to a job, such as `fast` or `strong` |
| `user`, `timezone` | your name, and the time zone stamped on messages |
| `context` | when a new slice starts: `idleMinutes` without a message, or when a request would pass `sliceTokens`. The first (like `/new`, or a reply to an earlier message) also ends an exchange, which is when memory is brought up to date. |
| `allowlist` | per platform, who may talk to it. It's edited only in this file. |
| `extensions` | per extension: `enabled`, and its own options (for example `memory.words`, how long memory may get, or `web.mode`) |

## The machine

japa runs on the machine it's installed on, and that machine is the agent's computer. Its commands and file tools start in the home directory of the user japa runs as, files you send go in `inbox/` there, and the screen tool is on by default when the machine has an X display (`DISPLAY`, else `:0`). To keep the agent's shell off a machine you use, install japa on one of its own: any Linux VM that stays on.

## In the agent's home

What the agent adds to itself lives in its home, in pi's places, and applies from the next message: standing
instructions in `~/.pi/agent/AGENTS.md`, and skills in `~/.pi/agent/skills/<name>/SKILL.md` (or `~/.agents/skills`).
They're yours to read and edit too.
