# How it works

japa has a **core**, which is what japa is and can't be turned off. Everything else is an **extension** of one kind, plugged in through one typed adapter per thing japa is built from. It all runs on one machine, which is also the agent's computer: its shell, files and screen are that machine's. Every extension runs inside japa, built in or installed from chat once you've tapped Install.

```
                  ┌──────────────────────────── core (always on) ────────────────────────────┐
 you ─► Channel ─►│ Inbox (allowlist) ─► Main thread: the chief of staff                     │
                  │                      one conversation, worked in slices                  │
                  │                      answers · decides · delegates · synthesizes         │
                  │                         │ delegate             ▲ report                  │
                  │                         ▼                      │                         │
                  │                      Team: one job agent per job (+ subagents)           │
                  │                                                                          │
                  │ Open items · Working set · Triggers · Installer · Models (/login)        │
 you ◄─ Channel ◄─│ UI cards ◄─ /settings · /jobs · pi's /login /model … · approvals         │
                  └───────────────────▲─────────────────────────────────────▲────────────────┘
                                      │ Host: settings · secrets · models   │
                                      │ ui · wake · holds · emit · history  │
                  ┌───────────────────┴──── extensions, all in-process ─────┴────────────────┐
                  │ each = a Pi extension (tools · sections · hooks · tasks)                 │
                  │      + japa's fields (for · settings · safeTools · onExchangeEnd ·       │
                  │                       triggers · channel · start/stop)                   │
                  │                                                                          │
                  │ Telegram · Memory · Approvals · Web · Computer · Screen · installed ones │
                  └──────────────────────────────────────────────────────────────────────────┘
          One machine, which is the agent's computer: bash, files and screen run here.
```

## The core

- **The main thread** is the chief of staff (`src/pi/harness.ts`): one conversation, worked in short slices.
- **Addressed inputs** (`src/pi/inputs.ts`). Every input has a cause: you, a job's report, a trigger, an approval, or a problem. The answer goes back the way it came, threaded under what it answers, exactly once. Problems with extensions are inputs too, so the chief hears about them and can get them fixed.
- **Open items** are the record of what's been promised, asked or is in progress. With a short working set, they are what each slice starts from.
- **The team** (`src/pi/delegation.ts`) is one job agent per job, with subagents if a job needs them.
- **Triggers** wake the chief on a schedule or on an event.
- **The UI** (`src/core/ui.ts`) shows channel-neutral cards with buttons, and runs japa's commands (`/settings`, `/jobs`) and pi's (`/login`, `/logout`, `/model`, `/thinking`).
- **The installer** (`src/pi/installer.ts`) adds extensions from chat.

## Adapters

Each thing japa is built from has one typed adapter in the core, and every implementation goes through it, built-in or not. A default has no privilege an extension you install lacks, so you can replace any of them.

| Abstraction | Adapter in the core | An extension provides one with | Built in |
|---|---|---|---|
| **Capability:** tools, prompt, hooks | `JapaExtension`, made from the `Host` (`src/pi/extension.ts`) | the extension itself: a Pi extension (`tools`, `sections`, `hooks`, `wraps`, `tasks`), plus `for`, `settings`, `safeTools`, `onExchangeEnd`, `triggers`, `start`/`stop` | Memory, Approvals, Web, Computer, Screen |
| **Channel** | `Channel` (`src/pi/extension.ts`): `platform`, `open({ inbox, ui })`, `show(card)`, `close()`. Messages go in through the `Inbox`, the allowlist gate (`src/channels/inbox.ts`); presses, replies and commands go to the `UI` | `channel: { platform, open, show, close }` | Telegram |
| **Model provider** | pi-ai's `Provider` on the core's `Models`; credentials in pi's `auth.json`, through `/login` | (none: pi-ai's own) | pi-ai's providers |

While an extension is on, the core opens its channel and shows cards on it. When the extension is turned off, the core closes the channel.

What's built on each adapter is generic and never names an implementation:
- **on `Models`:** `/login` and `/logout`, the model picker (`/model`), thinking levels (`/thinking`), and every agent's model;
- **on the `UI`:** `/settings`, approval and install cards, and the commands a channel advertises.

## One message, end to end

1. **In.** The channel passes your message to its Inbox, which refuses anyone not on the allowlist. A message is text plus any files: photos, voice notes, audio, video, documents. Every file is put on its computer, in `inbox/` under the agent's home, and the message says where. A photo is also shown to the model directly when the model takes images. The message is saved before anything runs, so if the process dies, the answer still goes out after the restart.
2. **A slice.** The chief of staff doesn't carry the whole history. A slice starts from **state**: open items, a short working set, and the last few messages. A new slice begins when any of these happens:
   - you've been quiet for a while;
   - the context would grow too large;
   - you send `/new`;
   - you reply to something from an earlier slice.

   The departing slice updates the working set in the background, so your message never waits. Every boundary but the size one also ends an **exchange**: extensions hear about it then (memory reflects on it), over all the slices it took. History search brings back anything older.
3. **Answer, or delegate.** By itself the chief does only the very simple: an answer it knows, or a quick tool call or two. Everything else goes to `delegate`, which starts a job agent in its own conversation, with its own model. The chief replies at once, and the chat is free again.
4. **Work.** A job agent has web search and fetch, bash and files, the screen, and whatever extensions give job agents. It can split work across subagents, and decides when to `report`. If it ends its run without a report, its last words count as its report.
5. **Approval.** Every tool call passes the Approvals hook first, where a fast model reviews it. Anything that sends as you, spends, deletes your things, deploys or changes accounts is **blocked, not held**:
   - you get **Approve / Deny / Always** buttons;
   - the agent ends its turn;
   - your decision comes back to it as a message;
   - an approved call then goes through exactly once.

   Work on its own computer goes ahead, except on japa's own code and data (its keys and settings are there), which waits for you too. If the review fails, it's retried, then retried with the main model, before you're asked. Every reviewed call goes to `audit.jsonl`.
6. **Back to you.** A report wakes the chief of staff, not you. The chief checks it, can redirect the job, and connects it with what it knows. Its reply is what you hear, threaded under your original message. A reply to progress reports alone stays with it. A job closes when it reports done, and asking for more of it opens it again, with everything it knew.
7. **On its own.** Triggers wake the chief without you, on a schedule ("08:00 on weekdays", "every 15m") or on an event. As with reports, what it replies reaches you. Triggers are durable, so a schedule survives restarts.

## Memory

Memory is one short free-form document, `memory/memory.md` in the data directory, kept to what would change how the agent helps you weeks from now. It changes only through small edits. A reflection at the end of each exchange does most of them: it sharpens or merges lines rather than adding, and marks things that stopped being true. `remember` is for when you ask it to remember, correct or forget something. Memory has a size in words (Memory in `/settings`): past it, an addition gets in only if a correction makes room. The directory is a git repo, so every change is a commit you can read and undo. Everything said before is searchable (`history.sqlite`, rebuilt from the transcript if lost).

## Extensions installed from chat

They run inside japa exactly like the built-in ones: same Host, same adapters, no restrictions. The line is your Install tap. The details are in [Extensions](extensions.md#from-chat).
