# How it works

japa has a **core**, which is what japa is and can't be turned off. Everything else is an **extension** of one kind, plugged in through one typed adapter per thing japa is built from. Code japa didn't ship runs on a machine, never inside the runtime that holds the keys.

```
                    ┌──────────────────────────── core (always on) ─────────────────────────────┐
 Channel ─► Inbox ──┤  Main thread ── the chief of staff: one conversation, worked in slices     │
 (allowlist)        │       │  every input has a cause; its answer goes back the way it came ───┼─► cards back
                    │       ▼  delegate / message_job / cancel_job                               │   on the channel
                    │  Team: one job agent per job ── report ──► back to the chief of staff      │
                    │  Open items · Triggers · UI cards · /settings · /login · /jobs · Installer │
                    │  Adapters: channels · model providers · machines                           │
                    └───────────────▲─────────────────────────────────────────────▲──────────────┘
                                    │ the Host: settings, secrets, models, workbench,│
                                    │ cards, wake, holds, emit, history              │
                    ┌───────────────┴───────────── extensions ───────────────────────┴───────────┐
                    │ built in, in-process: Telegram · Memory · Approvals · Web · Computer ·      │
                    │ Screen · Claude Code · Codex · boat.dev · Local machine                    │
                    │ installed from chat: a stand-in here, forwarding to its code ─────────┐    │
                    └───────────────────────────────────────────────────────────────────────┼────┘
                             │ bash, files, screen, coding agents                exec only  │
                             ▼                                                              ▼
       Workbench: the agent's own machine (boat.dev,       Extensions machine: each installed extension's
       by default), holding none of your secrets           code in its own process, keys as placeholders
```

## The core

- **The main thread** is the chief of staff (`src/pi/harness.ts`): one conversation, worked in short slices.
- **Addressed inputs** (`src/pi/inputs.ts`). Every input has a cause: you, a job's report, a trigger, an approval, or a problem. The answer goes back the way it came, threaded under what it answers, exactly once. Problems with extensions are inputs too, so the chief hears about them and can get them fixed.
- **Open items** are the record of what's been promised, asked or is in progress. With a short working set, they are what each slice starts from.
- **The team** (`src/pi/delegation.ts`) is one job agent per job, with subagents if a job needs them.
- **Triggers** wake the chief on a schedule or on an event.
- **The UI** (`src/core/ui.ts`) shows channel-neutral cards with buttons, and runs `/settings`, `/login` and `/jobs`.
- **The installer** (`src/pi/installer.ts`) adds extensions from chat.

## Adapters

Each thing japa is built from has one typed adapter in the core, and every implementation goes through it, built-in or not. A default has no privilege an extension you install lacks, so you can replace any of them.

| Abstraction | Adapter in the core | An extension provides one with | Built in |
|---|---|---|---|
| **Capability:** tools, prompt, hooks | `JapaExtension`, made from the `Host` (`src/pi/extension.ts`) | the extension itself: `chief`, `jobs`, `settings`, `safeTools`, `onSliceEnd`, `triggers`, `start`/`stop` | Memory, Approvals, Web, Computer, Screen, Claude Code, Codex |
| **Channel** | `Channel` (`src/pi/extension.ts`): `platform`, `open({ inbox, ui })`, `show(card)`, `close()`. Messages go in through the `Inbox`, the allowlist gate (`src/channels/inbox.ts`); presses, replies and commands go to the `UI` | `channel: { platform, open, show, close }` | Telegram |
| **Model provider** | pi-ai's `Provider` on the core's `Models`; credentials in `auth.json` through `/login` | `providers: [createProvider(...)]` | pi-ai's providers |
| **Machine** | `Backend` (`exec`, optionally `viewUrl`), opened by an `OpenBackend` (`src/core/backend.ts`) for a role | `backends: { "<name>": (role, config) => backend }`, picked by name in `machines.workbench` and `machines.extensions` | boat.dev, Local machine |

While an extension is on, the core registers its providers and machines, and opens its channel and shows cards on it. When the extension is turned off, the core drops them and closes the channel.

What's built on each adapter is generic and never names an implementation:
- **on `Backend`:** shell, files, the screen and the coding agents. They only run commands;
- **on `Models`:** `/login`, the model picker in `/settings`, and every agent's model;
- **on the `UI`:** `/settings`, approval and install cards, and the commands a channel advertises.

## One message, end to end

1. **In.** The channel passes your message to its Inbox, which refuses anyone not on the allowlist. A message is text plus any files: photos, voice notes, audio, video, documents. Every file is put on the workbench under `~/inbox`, and the message says where. A photo is also shown to the model directly when the model takes images. The message is saved before anything runs, so if the process dies, the answer still goes out after the restart.
2. **A slice.** The chief of staff doesn't carry the whole history. A slice starts from **state**: open items, a short working set, and the last few messages. A new slice begins when any of these happens:
   - you've been quiet for a while;
   - the context would grow too large;
   - you send `/new`;
   - you reply to something from an earlier slice.

   The departing slice is reflected on in the background, so your message never waits. History search brings back anything older.
3. **Answer, or delegate.** By itself the chief does only the very simple: an answer it knows, or a quick tool call or two. Everything else goes to `delegate`, which starts a job agent in its own conversation, with its own model, on the workbench. The chief replies at once, and the chat is free again.
4. **Work.** A job agent has web search and fetch, bash and files, the screen, and Claude Code or Codex. It can split work across subagents, and decides when to `report`. If it ends its run without a report, its last words count as its report.
5. **Approval.** Every tool call passes the Approvals hook first, where a fast model reviews it. Anything that sends as you, spends, deletes your things, deploys or changes accounts is **blocked, not held**:
   - you get **Approve / Deny / Always** buttons;
   - the agent ends its turn;
   - your decision comes back to it as a message;
   - an approved call then goes through exactly once.

   Work on its own computer goes ahead. If the review fails, it's retried, then retried with the main model, before you're asked. Every reviewed call goes to `audit.jsonl`.
6. **Back to you.** A report wakes the chief of staff, not you. The chief checks it, can redirect the job, and connects it with what it knows. Its reply is what you hear, threaded under your original message. A reply to progress reports alone stays with it. A job closes when it reports done, and asking for more of it opens it again, with everything it knew.
7. **On its own.** Triggers wake the chief without you, on a schedule ("08:00 on weekdays", "every 15m") or on an event. As with reports, what it replies reaches you. Triggers are durable, so a schedule survives restarts.

## Memory

Memory is one free-form document, `memory/memory.md` in the data directory. It changes only through small edits: `remember` during a conversation, and a reflection at the end of each slice, which also marks things that stopped being true. The directory is a git repo, so every change is a commit you can read and undo. Everything said before is searchable (`history.sqlite`, rebuilt from the transcript if lost).

## Extensions installed from chat

They run sandboxed, on a machine of their own. Each one is split into its code, which runs there, and a stand-in that japa registers. The details are in [Extensions](extensions.md#how-installed-extensions-run).
