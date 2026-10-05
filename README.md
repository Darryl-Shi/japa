# japa

A personal chief of staff you message (on Telegram, by default). It answers quickly, remembers you, and hands longer work to a team of job agents that run on their own computer. Their results come back as a reply to the message that asked for them. It's built on [Pi Durable](https://github.com/earendil-works/pi/tree/main/packages/durable), so everything it's in the middle of survives a restart.

It should feel like texting one competent person. The chat never blocks, small questions stay small, and it asks before anything that sends, spends, deletes or deploys.

## Install

On any Linux machine that stays on (a small VM is plenty):

```bash
curl -fsSL https://raw.githubusercontent.com/Darryl-Shi/japa/main/install.sh | bash
```

The script sets up the defaults. It asks for:
- a Telegram bot token (from [@BotFather](https://t.me/BotFather)), for the default channel;
- a model provider and its API key, or a subscription login. Any [pi-ai](https://github.com/earendil-works/pi) provider works: Anthropic, OpenAI, Google, OpenRouter, Z.ai and others. More can be added later from chat with `/login`;
- your name and time zone;
- optionally a [boat.dev](https://boat.dev) key, for the agent's own computer;
- optionally a [Parallel](https://parallel.ai) key, for web search.

It brings its own Node 24 if the machine has none and runs the agent as a systemd service. At the end, if you gave a bot, it asks you to send it `/whoami` and puts you on the allowlist.

Run the same command again to update; it also moves data from older layouts. For an unattended install, every answer can come from the environment instead (see the top of `install.sh`).

## How it works

```
                    ┌──────────────────────────── core (always on) ─────────────────────────────┐
 Channel ─► Inbox ──┤  Main thread ──── the chief of staff: one conversation, worked in slices   │
 (allowlist)        │       │  delegate / message_job / cancel_job          message_user ─► UI ─┼─► cards back
                    │       ▼                                                                    │   on the channel
                    │  Team: one job agent per job ──── report ──► back to the chief of staff    │
                    │  Open items · Triggers · UI cards · /settings · /login · /jobs             │
                    │  Adapters: channels · model providers · machines                           │
                    └───────────────▲─────────────────────────────────────────────▲──────────────┘
                                    │ the Host: settings, secrets, models, workbench,│
                                    │ cards, wake, holds, emit, history              │
                    ┌───────────────┴───────────── extensions ───────────────────────┴───────────┐
                    │ Telegram · Memory · Approvals · Web · Computer · Screen · Claude Code ·     │
                    │ Codex · boat.dev · Local machine · whatever you install from chat          │
                    └────────────────────────────────────────────────────────────────────────────┘
                                              │ bash, files, screen, coding agents
                                              ▼
                       Workbench: its own machine (boat.dev, by default), holding none of your secrets
```

**The core** can't be turned off. It's made of:
- **the main thread,** which is the chief of staff;
- **open items,** the record of what's been promised, asked or is in progress;
- **the team** of job agents;
- **triggers;**
- **the UI**, with `/settings`, `/login` and `/jobs` (what the team is working on: each job's status, model, recent activity, and a Cancel button);
- **the installer,** which adds extensions from chat.

**Everything else is an extension.** There is one kind, `JapaExtension` in `src/pi/extension.ts`. It's made from the **Host**, which is everything an extension may use: settings, secrets, the data directory, models, the workbench, UI cards, `wake`, holds, `emit` and history search. It never touches the main thread directly; even a channel's messages come in through an adapter.

### Core abstractions and their adapters

Each thing japa is built from has one typed adapter in the core, and every implementation goes through it, built-in or not. A default has no privilege an extension you install lacks, so you can replace any of them.

| Abstraction | Adapter in the core | An extension provides one with | Built in |
|---|---|---|---|
| **Capability:** tools, prompt, hooks | `JapaExtension`, made from the `Host` (`src/pi/extension.ts`) | the extension itself: `chief`, `jobs`, `settings`, `safeTools`, `onSliceEnd`, `triggers`, `start`/`stop` | Memory, Approvals, Web, Computer, Screen, Claude Code, Codex |
| **Channel** | `Channel` (`src/pi/extension.ts`): `platform`, `open({ inbox, ui })`, `show(card)`, `close()`. Messages go in through the `Inbox`, the allowlist gate (`src/channels/inbox.ts`); presses, replies and commands go to the `UI` (`src/core/ui.ts`) | `channel: { platform, open, show, close }` | Telegram |
| **Model provider** | pi-ai's `Provider` on the core's `Models`; credentials in `auth.json` through `/login` | `providers: [createProvider(...)]` | pi-ai's providers |
| **Machine** | `Backend` (`exec`, optionally `viewUrl`), opened by an `OpenBackend` (`src/core/backend.ts`) | `backends: { "<name>": (role, config) => backend }`, picked by name in `machines.workbench` | boat.dev, Local machine |

While an extension is on, the core registers its providers and machines, and opens its channel and shows cards on it. When the extension is turned off, the core drops them and closes the channel.

What's built on each adapter is generic and never names an implementation:
- **on `Backend`:** shell, files, the screen and the coding agents. They only run commands;
- **on `Models`:** `/login`, the model picker in `/settings`, and every agent's model;
- **on the `UI`:** `/settings`, approvals and install cards, and the commands a channel advertises.

### One message, end to end

1. **In.** The channel (Telegram, by default) passes your message to its Inbox, which refuses anyone not on the allowlist. A message is text plus any files: photos, voice notes, audio, video, documents. Every file is put on the workbench under `~/inbox`, and the message says where, so the chief of staff or a job can work with it. A photo is also shown to the model directly when the model takes images. The message is saved before anything runs, so if the process dies, the answer still goes out after the restart.
2. **A slice.** The chief of staff doesn't carry the whole history. A new slice starts from **state** rather than from history: open items, a short working set, and the last few messages. A new slice begins when any of these happens:
   - you've been quiet for a while;
   - the context would grow too large;
   - you send `/new`;
   - you reply to something from an earlier slice.

   The departing slice is summarised and reflected on in the background, so your message never waits. History search brings back anything older.
3. **Answer, or delegate.** By itself it does only the very simple: an answer it knows, or a quick tool call or two. Everything else goes to `delegate`, which starts a job agent in its own conversation, with its own model, on the workbench. The chief of staff replies at once ("on it"), and the chat is free again.
4. **Work.** The job agent has these tools:
   - web search and fetch;
   - bash and files;
   - the screen;
   - Claude Code or Codex for coding.

   It can split work across subagents, and decides when to `report`.
5. **Approval.** Every tool call passes the Approvals hook first. A fast model reviews it. Anything that sends as you, spends, deletes your things, deploys or changes accounts is **blocked, not held**:
   - you get **Approve / Deny / Always** buttons;
   - the agent ends its turn;
   - your decision comes back to it as a message;
   - an approved call then goes through exactly once.

   Every reviewed call is written to `audit.jsonl`.
6. **Back to you.** A report wakes the chief of staff, not you. It checks the report, can question or redirect the job, connects it with what it knows, and decides what you hear: now, silently, or not yet. Results arrive threaded under your original message. A job stays open until you accept or drop it.
7. **On its own.** Triggers wake the chief of staff without you, on a schedule ("08:00 on weekdays", "every 15m") or on an event. They're durable, so a sleeping schedule survives restarts.

### Memory

Memory is one free-form document, `memory/memory.md` in the data directory, holding what the agent knows about you and your world. It changes only through small edits, never wholesale rewrites:
- `remember` during a conversation;
- a reflection at the end of each slice, which also marks things that stopped being true.

The directory is a git repo, so every change is a commit you can read and undo. Everything said before is searchable (`history.sqlite`, rebuilt from the transcript if lost).

### Default extensions

Each one can be switched off in `/settings`:

| Extension | Gives | Hooks into |
|---|---|---|
| Telegram | the channel: messages, replies, buttons | `channel`, `start`/`stop`, renders UI cards |
| Memory | `remember`, `search_history`, memory in the prompt | the chief of staff; `onSliceEnd` (reflection) |
| Approvals | review before every tool call, the buttons, the audit log | every agent (`beforeTool`); UI cards; `wake`; holds |
| Web | `web_search`, `web_fetch` (Parallel, fast mode) | every agent; a key in `/settings` |
| Computer, Screen | bash and files; the `computer` tool on the workbench's desktop | every agent; quiet while there's no workbench |
| Claude Code, Codex | `claude_code`, `codex` | job agents only; a key is passed to one command, never stored on the workbench |
| boat.dev | the `boat` machine provider | `backends`; its key in `/settings` |
| Local machine | the `local` machine provider, for development | `backends` |

### Writing an extension

```ts
export function weatherExtension(host: Host): JapaExtension {
  return {
    name: "weather",
    title: "Weather",
    about: "Morning forecast, and a forecast tool.",
    settings: [{ key: "city", label: "City", kind: "text" }],   // appears in /settings
    defaults: { city: "Singapore" },
    chief: [forecastTools(host)],                                // Pi tools, prompt sections, hooks, durable tasks
    jobs: [forecastTools(host)],
    safeTools: ["forecast"],                                     // never needs approval
    triggers: [{ name: "morning", when: { at: "07:30" }, prompt: "Check today's forecast; tell me only if it matters." }],
  };
}
```

An extension can also:
- run work when a slice ends (`onSliceEnd`);
- start and stop as it's switched (`start`/`stop`);
- show cards and handle their buttons (`host.ui`);
- wake an agent (`host.wake`) or raise an event that fires triggers (`host.emit`);
- be a messaging channel (`channel`), add model providers (`providers`), or add machine providers (`backends`), through the adapters above. A channel is opened with its platform's inbox, so it gets the allowlist for free.

### Extensions from chat

The agent extends itself while running. A job writes the extension on the workbench: one `.ts` file whose default export is `(host: Host) => JapaExtension`, importing values only from packages. Then the chief of staff calls `install_extension`, and you get a card with Install and Don't install buttons, every time, whatever the approvals mode, because the code runs inside the agent with its keys. When you tap Install it's loaded, saved to `extensions/` in the data directory, and on from your next message, with no restart. Installing a new version replaces the old one in place, and installed extensions load again at start. `remove_extension` takes one out.

Which machine is the workbench is set in `machines.workbench` in `settings.json`, by the name of a machine provider:
- `boat`: boat.dev;
- `local`: this machine, for development;
- any provider an installed extension declares.

It's opened when first needed and again when that setting changes.

## Configuration

Send `/settings` in chat. It's a button menu for the models, your name and time zone, and each extension's switch and options. Keys are set by replying to its question, and that message is then deleted. Changes apply immediately. `/login` logs in to a model provider, with an API key or the provider's own account login, and offers its models in `/settings`.

Everything it keeps is in one directory, `JAPA_DATA` (default `data/` in the checkout; gitignored, readable only by you):

| File | Holds |
|---|---|
| `settings.json` | settings, re-read on change. The **allowlist** is edited only here: per platform, the user ids that may talk to the agent. An empty list lets no one in. |
| `auth.json` | model credentials (API keys or subscription logins) |
| `secrets.json`, `.env` | extension keys, as `<extension>.<key>` (Telegram's bot token is one). An extension's secret field can name an environment variable to fall back on; the defaults use `TELEGRAM_BOT_TOKEN`, `BOAT_API_KEY`, `PARALLEL_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN` or `ANTHROPIC_API_KEY`, `CODEX_API_KEY` |
| `session.sqlite`, `history.sqlite` | the durable state of every conversation and task; history search |
| `memory/` | its memory of you, a git repo |
| `extensions/` | extensions installed from chat |
| `audit.jsonl`, `japa.log` | every reviewed action; the log |

**The workbench** on boat.dev is set with `{ "provider": "boat", "type": "small", "screen": true, "idleSeconds": 7200 }`, and its key in `/settings` → boat.dev. It sleeps after `idleSeconds` unused, and each command pushes that deadline back. The next command wakes it with the same disk.

## Security

- **Only the allowlist gets in.** Every channel goes through the same gate, and the agent has no tool to change the list.
- **Secrets never live on the workbench.** Model credentials and keys stay in the harness. A key a coding agent needs is passed to that one command's environment.
- **Agent code never runs in the harness.** Shell, files and coding agents run on the workbench. Without one, the agent has no shell at all. The one exception is an extension, which runs inside japa with its keys, so only your tap installs one, after the file has been checked.
- **Consequential actions need you,** through Approvals. Standing permissions come only from your "Always" taps and can be removed in `/settings`.

## Development

```bash
npm install
npm test          # the whole agent on pi-ai's faux provider: no API key needed
npm run check     # type-check
```

```
src/
  main.ts          the default extensions, and start
  japa.ts          the core, assembled; builds the Host and opens the workbench through its provider
  core/            our formats and services: messages, UI cards, schedules, approvals, memory, state (no Pi imports)
  pi/              Pi adapters and the built-in extensions (extension.ts: the one unit type and the Host; installer.ts: extensions from chat)
  channels/        the Inbox (allowlist gate), /settings, /login, /jobs, Telegram
  backends/        machine providers, as extensions: boat, local
```

Pi is pinned at 1.0.2 (`pi-durable`, `pi-ai`, `chord`). Pi is experimental, so our data formats live in `src/core`, and only `src/pi` imports Pi. How to work on it, and why it's shaped this way: [AGENTS.md](AGENTS.md).

## Next

The bar is daily use, compared with the agent it replaces:
- a quick question gets a reply in seconds;
- it recalls things from weeks ago without being reminded;
- one thread is enough;
- the base prompt stays small.

What comes next:
- **Habits.** Email and calendar as extensions, skills (remembered how-tos), behaviours (extensions with triggers), and digests instead of interruptions.
- **It extends itself, further.** Extensions from chat are hot-loaded now; next is running them outside the harness process. The first test is WhatsApp.
- **Voice.**
