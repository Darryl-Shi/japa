# japa

A personal chief of staff you text on Telegram. It answers quickly, remembers you, and hands longer work to a team of job agents that run on their own computer. Their results come back as a reply to the message that asked for them. It's built on [Pi Durable](https://github.com/earendil-works/pi/tree/main/packages/durable), so everything it's in the middle of survives a restart.

It should feel like texting one competent person. The chat never blocks, small questions stay small, and it asks before anything that sends, spends, deletes or deploys.

## Install

On any Linux machine that stays on (a small VM is plenty):

```bash
curl -fsSL https://raw.githubusercontent.com/Darryl-Shi/japa/main/install.sh | bash
```

The script asks for:
- a Telegram bot token (from [@BotFather](https://t.me/BotFather));
- a model provider and its API key, or a subscription login. Any [pi-ai](https://github.com/earendil-works/pi) provider works: Anthropic, OpenAI, Google, OpenRouter, Z.ai and others;
- your name and time zone;
- optionally a [boat.dev](https://boat.dev) key, for the agent's own computer;
- optionally a [Parallel](https://parallel.ai) key, for web search.

It brings its own Node 24 if the machine has none and runs the agent as a systemd service. At the end it asks you to send `/whoami` to your bot, and puts you on the allowlist.

Run the same command again to update. For an unattended install, every answer can come from the environment instead (see the top of `install.sh`).

## How it works

```
                    ┌──────────────────────────── core (always on) ─────────────────────────────┐
 Telegram ─► Inbox ─┤  Main thread ──── the chief of staff: one conversation, worked in slices   │
 (allowlist)        │       │  delegate / check_job / conclude_job          message_user ─► UI ─┼─► cards back
                    │       ▼                                                                    │   to Telegram
                    │  Team: one job agent per job ──── report ──► back to the chief of staff    │
                    │  Open items · Triggers (schedules, events) · UI cards · /settings          │
                    └───────────────▲─────────────────────────────────────────────▲──────────────┘
                                    │ the Host: settings, secrets, models, workbench,│
                                    │ cards, wake, holds, emit, history, inbox       │
                    ┌───────────────┴───────────── extensions ───────────────────────┴───────────┐
                    │ Telegram · Memory · Approvals · Web · Computer · Screen · Claude Code · Codex│
                    └────────────────────────────────────────────────────────────────────────────┘
                                              │ bash, files, screen, coding agents
                                              ▼
                                  Workbench: its own machine (boat.dev), holding none of your secrets
```

**The core** can't be turned off. It's made of:
- **the main thread,** which is the chief of staff;
- **open items,** the record of what's been promised, asked or is in progress;
- **the team** of job agents;
- **triggers;**
- **the UI** and `/settings`.

**Everything else is an extension.** Each extension is built from one shape, `JarvisExtension` in `src/pi/extension.ts`, and is hooked in only through the **Host**. It never touches the main thread directly.

### One message, end to end

1. **In.** Telegram passes your message to its Inbox, which refuses anyone not on the allowlist. The message is saved before anything runs, so if the process dies, the answer still goes out after the restart.
2. **A slice.** The chief of staff doesn't carry the whole history. A new slice starts from **state** rather than from history: open items, a short working set, and the last few messages. A new slice begins when any of these happens:
   - you've been quiet for a while;
   - the context would grow too large;
   - you send `/new`;
   - you reply to something from an earlier slice.

   The departing slice is summarised and reflected on in the background, so your message never waits. History search brings back anything older.
3. **Answer, or delegate.** Quick things it answers directly. Longer work goes to `delegate`, which starts a job agent in its own conversation, with its own model, on the workbench. The chief of staff replies at once ("on it"), and the chat is free again.
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

   Every reviewed call is written to `data/audit.jsonl`.
6. **Back to you.** A report wakes the chief of staff, not you. It checks the report, can question or redirect the job, connects it with what it knows, and decides what you hear: now, silently, or not yet. Results arrive threaded under your original message. A job stays open until you accept or drop it.
7. **On its own.** Triggers wake the chief of staff without you, on a schedule ("08:00 on weekdays", "every 15m") or on an event. They're durable, so a sleeping schedule survives restarts.

### Memory

Memory is one free-form document, `~/jarvis-home/memory.md`, holding what the agent knows about you and your world. It changes only through small edits, never wholesale rewrites:
- `remember` during a conversation;
- a reflection at the end of each slice, which also marks things that stopped being true.

The directory is a git repo, so every change is a commit you can read and undo. Everything said before is searchable (`data/history.sqlite`, rebuilt from the transcript if lost).

### Default extensions

Each one can be switched off in `/settings`:

| Extension | Gives | Hooks into |
|---|---|---|
| Telegram | the channel: messages, replies, buttons | `channel`, `start`/`stop`, renders UI cards |
| Memory | `remember`, `search_history`, memory in the prompt | the chief of staff; `onSliceEnd` (reflection) |
| Approvals | review before every tool call, the buttons, the audit log | every agent (`beforeTool`); UI cards; `wake`; holds |
| Web | `web_search`, `web_fetch` (Parallel, fast mode) | every agent; a key in `/settings` |
| Computer, Screen | bash and files; the `computer` tool on the workbench's desktop | every agent |
| Claude Code, Codex | `claude_code`, `codex` | job agents only; a key is passed to one command, never stored on the workbench |

### Writing an extension

```ts
export function weatherExtension(host: Host): JarvisExtension {
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
- be a messaging channel (`channel`). A channel reaches the agent only through `host.inbox(platform)`, so it gets the allowlist for free;
- add a model provider (`host.models.setProvider` in `start`).

### Extensions from chat

The agent extends itself while running. A job writes the extension on the workbench: one `.ts` file whose default export is `(host: Host) => JarvisExtension`, importing values only from packages. Then the chief of staff calls `install_extension`, and you get a card with Install and Don't install buttons, every time, whatever the approvals mode, because the code runs inside the agent with its keys. When you tap Install it's loaded, saved to `data/extensions/`, and on from your next message, with no restart. Installing a new version replaces the old one in place, and installed extensions load again at start. `remove_extension` takes one out.

The only other configurable abstraction is the **backend**, meaning which machine is the workbench. It's infrastructure, not a capability, so it's set in `machines.workbench` in `data/settings.json`:
- `boat`: built in;
- `local`: for development;
- any provider an extension registers.

## Configuration

Send `/settings` to the bot. It's a button menu for the models, your name and time zone, and each extension's switch and options. Keys are set by replying to the bot's question, and that message is then deleted. Changes apply immediately.

Files in `data/` (gitignored, readable only by you):

| File | Holds |
|---|---|
| `settings.json` | settings, re-read on change. The **allowlist** is edited only here: per platform, the user ids that may talk to the agent. An empty list lets no one in. |
| `auth.json` | model credentials (API keys or subscription logins) |
| `secrets.json`, `.env` | extension keys and the bot token. Environment variables also work: `TELEGRAM_BOT_TOKEN`, `BOAT_API_KEY`, `PARALLEL_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN` or `ANTHROPIC_API_KEY`, `CODEX_API_KEY` |
| `session.sqlite`, `history.sqlite` | the durable state of every conversation and task; history search |
| `audit.jsonl`, `jarvis.log` | every reviewed action; the log |

**The workbench** on boat.dev is set with `{ "provider": "boat", "type": "small", "screen": true, "idleSeconds": 7200 }`. It sleeps after `idleSeconds` unused, and each command pushes that deadline back. The next command wakes it with the same disk.

## Security

- **Only the allowlist gets in.** Every channel goes through the same gate, and the agent has no tool to change the list.
- **Secrets never live on the workbench.** Model credentials and keys stay in the harness. A key a coding agent needs is passed to that one command's environment.
- **Agent code never runs in the harness.** Shell, files and coding agents run on the workbench. Without one, the agent has no shell at all.
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
  jarvis.ts        the core, assembled; builds the Host
  core/            our formats and services: UI cards, schedules, approvals, memory, state (no Pi imports)
  pi/              Pi adapters and the built-in extensions (extension.ts: the one unit type and the Host; installer.ts: extensions from chat)
  channels/        the Inbox (allowlist gate), /settings, Telegram
  backends/        workbench providers: boat, local
```

Pi is pinned at 1.0.2 (`pi-durable`, `pi-ai`, `chord`). Pi is experimental, so our data formats live in `src/core`, and only `src/pi` imports Pi.

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
