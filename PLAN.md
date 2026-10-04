# pi-jarvis

A personal chief of staff on [Pi Durable](https://github.com/earendil-works/pi/tree/main/packages/durable), reached over Telegram. It runs alongside Hermes until it is better in real daily use.

## Product

**Principle:** it should feel like texting one competent person. The main thread answers fast and never blocks. Real work happens somewhere else and comes back as a reply to the message that asked for it.

**The bar is what's wrong with Hermes:**

| Hermes | Here | Check |
|---|---|---|
| A small query turns into a big agentic task | The main thread answers directly. Anything longer is announced and goes to a subagent. | A simple question gets its first reply in under ~5s |
| Poor memory by default | Memory is always on | It recalls things from weeks ago without being reminded |
| Every task needs its own thread | One thread in Telegram; the model works in short slices that start from state (open items, working set, last few messages), not from history. History search brings back anything older. | 4–6k input tokens for a quick question and 5–8k for a follow-up or resumed topic, on any provider |
| Bloated | A small core, loaded on demand | Base prompt under ~3k tokens, at most ~8 tools in the main turn |

**What it knows and does**

- **Memory:** one free-form document, the agent's own memory of the user and their world, organised however serves it: who they are, how they work, what they're in the middle of, people, plans, seasons. There are no fixed categories.
  - It changes only through small edits: `remember` during a conversation, plus a reflection at the end of each slice. That reflection marks things that stopped being true (past tense with when, or removed) instead of letting them silently expire. This is the lever StateMemBench says matters.
  - Every change is logged for a weekly check-in. What happened stays in the transcript, which history search can cite.
- **The core** can't be turned off: the main thread (the chief of staff, slices, the record of the conversation), open items, the team (job agents and their reports), triggers, the UI and `/settings`.
- **One unit: the extension.** Everything else is an extension, made from the **Host** and hooked in only through it. The Host gives settings, secrets, models, the workbench, the UI (cards with buttons, questions answered by reply, slash commands), `wake` (a new turn for the chief of staff or a job), holds (a job paused on the user), `emit` (events for triggers), history search, and `inbox(platform)`. It never gives the main thread itself. An extension says:
  - what it gives the chief of staff (`chief`) and job agents (`jobs`): Pi tools, prompt sections, hooks, durable tasks;
  - its `/settings` fields, and the tools that never need approval (`safeTools`);
  - `onSliceEnd`, for work when a slice ends (memory reflection uses it);
  - `triggers`, to wake the chief of staff by itself: on a schedule (`every`, or `at` a local time on given days; durable tasks that survive restarts) or on an event another extension emits. A trigger arrives as a message starting "[Trigger", and the chief of staff decides what the user hears;
  - `channel` (a messaging platform: it gets an Inbox, and the last channel can't be turned off);
  - `start` and `stop`, run when it's turned on or off, live.
  - Only the backend (which computer) is a separate, config-level abstraction, because it is infrastructure rather than a capability.
  - A **skill** is an extension with a prompt section and maybe a script. A **behaviour** is an extension with a trigger. A behaviour that makes the agent do less applies immediately; one that gives it more autonomy needs the user to confirm.
  - Agent-built extensions (M3) run **outside the harness** as a manifest plus a service in the extension host, and are turned on in `/settings`. Built-in ones are trusted code in the harness. Changes to the core are reviewed PRs.
  - Extensions use each other only through the Host (cards, wake, emit). A declared `uses:` link with lazy loading arrives with the extension host.
- **Default extensions (each can be turned off in `/settings`):**

  | Extension | Gives | Hooks used |
  |---|---|---|
  | Telegram | the main channel | `channel`, `start`/`stop`, renders UI cards |
  | Memory | `<memory>`, `remember`, `search_history` | `chief`, `onSliceEnd` (reflection) |
  | Approvals | a `beforeTool` hook in every agent | `chief`+`jobs` hook, UI cards, `wake`, holds, `start` (recovery) |
  | Web (Parallel) | `web_search`, `web_fetch` | `chief`+`jobs`, settings, secret |
  | Computer, Screen | bash/files, the `computer` tool on the workbench | `chief`+`jobs` |
  | Claude Code, Codex | `claude_code`, `codex` | `jobs` only; a key set in `/settings` is passed per run, never stored on the workbench |

**Messaging UX**

- **A hard user whitelist.** Every messaging channel reaches the agent only through an `Inbox`, which refuses anyone not on that platform's `allowlist` before anything runs (Telegram: private chats only). An empty list lets no one in. The list is edited only in `settings.json`: not in `/settings`, and no tool changes it. Any messaging extension (WhatsApp, email, voice) must take its messages through an Inbox.

- Telegram: one DM. Results come back as replies to the message that asked.
- Before anything that sends, spends, deletes, deploys or changes accounts, the user is asked with [Approve] [Deny] [Always: <kind of action>] buttons.
- Interrupt only when necessary. Everything else arrives silently or in a digest.

## Milestones

| | What you get |
|---|---|
| **M1: It answers** | Telegram, one thread, fast path, memory and history search, sandbox, job agents with coding agents, web search, approvals, audit log, `/settings` |
| **M2: It has habits** | The extension host first, with email and calendar as its first extensions. Then skills and behaviours as units with `uses:` links, `always` and `time` triggers, digests and the delivery gate |
| **M3: It extends itself** | Event triggers, the agent building its own extensions: the loop of build → prove → card → toggle → rollback. First test: WhatsApp. |
| **M4: Voice** | Calls |

## Configuration (`/settings`)

`/settings` in Telegram is a menu of buttons. The first page has **General** (the chief of staff's model, the default job model, the user's name, time zone, idle minutes) and every extension with its switch. Each extension's ⚙ page is built from the settings fields it declares, so an extension adds settings just by listing them: toggle, choice (tap to cycle), text, number, model, list (tap to remove an item), or secret. A field that needs a value asks for it, and the user sets it by replying. Values go to `data/settings.json`. Secrets go to `data/secrets.json`, with an environment variable as a fallback; a typed secret is deleted from the chat.

- **Models:** any model pi-ai supports, including Claude and ChatGPT subscriptions through OAuth. `model` is the chief of staff's: a strong one, kept fast by small contexts. `delegateModel` is the default for jobs, and `jobModels` holds named choices the chief of staff can assign per job. (`jobModels.fast` also reviews actions for approvals.)
- **User:** `user.name` (optional). The prompts otherwise just say "the user".
- **Machines:** a provider per role (`workbench`, later `desk`): boat.dev, local, or any provider an extension registers. This is the backend config, outside the extension menu.
- No spend cap for now.

## Architecture

```
Telegram ⇄ harness (Node, always-on VM)                 sandbox (own endpoint | boat.dev)
            Pi Durable on SQLite (+ Litestream)  ──env──►  bash/files, skill scripts,
            secrets, pi-ai credential store                 Claude Code / Codex
            built-in extensions (trusted)
            adapter: manifest → registry.install  ◄─MCP─►  extension host (M2)
```

Pinned to `@earendil-works/pi-durable`, `pi-ai`, `chord` and `pi-mcp` **1.0.2**. Pi is experimental, so memory, prompts, units and data formats live in our code under `src/core`. Only `src/pi` imports Pi.

```
src/
  main.ts              the default extensions, and start
  jarvis.ts            the core, assembled; builds the Host
  settings.ts          live settings (settings.json, read on every use)
  core/                our formats and services (UI, schedule, approvals store); no Pi imports
  pi/                  Pi adapters and the built-in extensions (extension.ts: the one unit type and the Host)
  channels/            the Inbox (allowlist gate), /settings, Telegram
  backends/            backend providers: boat, local
home/                  (default ~/jarvis-home, a separate git repo) memory, skills, behaviours
```

## M1 build order

1. **Skeleton.** Harness on SQLite and one root conversation. Telegram through grammY long polling, restricted to the owner's chat ID. Requests are tagged with a `requestId` taken from the Telegram message ID. The answer is sent as a reply, and pending replies survive a restart.
2. **Fast path and slices.** A fast main model with a small toolset. The context is kept small by construction, not by any provider's cache settings; only the default short cache is used. Designed with GPT-6 Astra.
   - **There's one Telegram DM and one root conversation as the record.** The model works in slices of it. A slice starts with `reset()` and carries the open items and working set (system sections), plus the last few visible messages, plus the message being replied to, if any.
   - **A new slice starts when the next message from the user arrives and:**
     - they've been quiet for `idleMinutes` (10),
     - the request would pass `sliceTokens` (8k),
     - they send `/new`, or
     - they reply to a message from an earlier slice.

     Background reports don't count as activity, and nothing resets while an answer is running.
   - **Open items** are structured records: task / waiting / promise, plus the Telegram message each belongs to. Promises and questions are never dropped from the prompt.
   - **The working set** (options, constraints, decisions, the last question) is written in the background by one cheap call over the departing slice only. It's versioned, so a late summary never overwrites a newer one, and the user's message never waits for it.
   - **The time goes in each message**, never in the prefix. Every answer logs the slice decision, cache reads/writes and cost.
3. **Prompt sections.** Identity, the memory portrait, and (M2) the list of units. The prefix never contains anything that changes per message.
4. **Memory.** `jarvis-home/memory.md`, kept by `remember` plus the end-of-slice reflection (the same background call that writes the working set), with every change logged to `memory-changes.jsonl`. History search with citations is FTS5 over the transcript and reports.
5. **Backends (the agent's computers).** `Backend` is the single abstraction over infrastructure: `exec`, plus optional fast file paths, a screen, a view link for a human, and suspend.
   - Providers implement it: boat (built in; `idleSeconds` sleeps the machine after that long unused, by pushing boat's auto-stop deadline back on every use, and the next command wakes it with the same disk), local (reference and tests), and anyone's own infrastructure through an extension. Settings map roles to providers: `machines.workbench` (its own machine, no secrets) and later `machines.desk` (a screen plus your logged-in browser).
   - Everything on top is a generic extension that never names a provider. Pi's bash/read/write/edit run *directly* on the workbench through `BackendExecutionEnv`, which builds Pi's whole `ExecutionEnv` on `exec`. It's verified to behave like Pi's own local environment by a differential test.
   - The `computer` tool (screenshot, click, type, key, scroll, drag, share_screen) drives a machine's display. It uses the backend's native screen API if it has one, otherwise X over `exec` (xdotool, plus ImageMagick or ffmpeg). Screenshots are downscaled to 1280 wide and clicks are scaled back. `share_screen` gives the user a watch/take-over link.
6. **Delegation: one chief of staff and its team.** The user only ever talks to the chief of staff.
   - **Job agents:** `delegate` starts one job agent per job. It's a Pi conversation with its own small context, the same computer, and a model the chief of staff assigns from `jobModels` (default `delegateModel`), bound to that job. A job agent can start sub-agents (two levels deep), and they report to it.
   - **Reports:** the job agent decides when to report (done / stuck / decision needed / progress). A report wakes the chief of staff, which checks it, can question or redirect the job (`check_job`), connects it with other jobs and with memory, and decides what the user hears through `message_user` (now or silent, threaded under the original request). A job agent that ends a run without reporting is reported automatically.
   - **Jobs can't vanish:** only `conclude_job` closes one, after the user has accepted or dropped it. `cancel_job` stops a job and its sub-agents. Open jobs stay in every prompt.
   - **Scheduling:** the user's message jumps into a run that's busy with a report; it doesn't queue behind it. Reports that pile up are taken in one turn (`followUpMode: "all"`). Only the user's own messages count towards the idle clock.
   - **Tested:** reports reach the chief of staff and not the user; auto-report when a job goes quiet; per-job models; sub-agents report to their job; the user's question is answered quickly while reports are being handled; five reports are taken in at most three turns; jobs survive a slice reset.
   - **Coding:** Claude Code and Codex are default extensions that job agents get (`claude_code`, `codex`). They run headless on the workbench, are installed on first use, and can continue a session. A token or key set in `/settings` goes into the environment of that one command and is never written to the workbench. Without one, they use whatever login the workbench has.
7. **Web.** Parallel Search (objective plus several queries in one call, fast mode) and Extract (`web_fetch`: passages for an objective, or the whole page).
8. **Approvals and audit.** A `beforeTool` hook in every agent. Tools an extension marks safe skip it. In smart mode, `jobModels.fast` reviews every other call against a policy (sending as the user, spending, deleting the user's things, deploying, changing accounts) plus the standing permissions. A call that needs the user is **blocked, not held**: the agent ends its turn, the user gets buttons, and the decision comes back as a message, to the chief of staff as if from the user, or to a job agent as a new run of its job. An approved call then goes through exactly once (same tool, same arguments). A job waiting on an approval isn't auto-reported as gone quiet. "Always" adds the kind of action to the standing permissions, which can be removed in `/settings`. Every reviewed call is appended to `data/audit.jsonl`.
9. **`/settings`.** As above.

## Open

- Deployment: server first (Node on an always-on VM). Serverless comes later: Fly scale-to-zero, then possibly a Cloudflare Durable Object after a spike. Until then, avoid new direct `setTimeout` scheduling, so the switch stays cheap.

- Where the harness VM runs.
