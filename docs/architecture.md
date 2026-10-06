# How it works

japa has a **core**, which is what japa is and can't be turned off. Everything else is an **extension**, and an extension is a pi extension: a factory given pi's `ExtensionAPI`, with japa's own things in the same API. Each kind of thing an extension registers has one owner in the core, which puts it in use while the extension is on. The agent's computer is one of those kinds: by default it's the machine japa runs on. Every extension runs inside japa, built in or installed from chat once you've tapped Install.

```
                  ┌──────────────────────────── core (always on) ────────────────────────────┐
 you ─► Channel ─►│ Inbox (allowlist) ─► Main thread: the chief of staff                     │
                  │                      one conversation, worked in slices                  │
                  │                      answers · decides · delegates · synthesizes         │
                  │                         │ delegate             ▲ report                  │
                  │                         ▼                      │                         │
                  │                      Team: one job agent per job (+ subagents)           │
                  │                                                                          │
                  │ Open items · Working set · Computer · Skills · Schedules · History ·     │
                  │ Installer                                                                │
 you ◄─ Channel ◄─│ UI cards ◄─ /settings · /jobs · pi's /login /model … · dialogs           │
                  │                                                                          │
                  │ Owners: commands · model providers · accounts · environments · channels ·│
                  │         schedules · MCP servers  (+ tools, handlers, skills, settings)   │
                  └───────────────────▲─────────────────────────────────────▲────────────────┘
                                      │ pi's ExtensionAPI: registerTool ·   │
                                      │ registerCommand · registerProvider ·│
                                      │ registerFlag · registerMcpServer ·  │
                                      │ on(events) · sendUserMessage · exec │
                                      │ + registerChannel · registerAccount │
                                      │ · registerEnvironment ·             │
                                      │ registerSchedule · ctx.agent        │
                  ┌───────────────────┴──── extensions, all in-process ─────┴────────────────┐
                  │ local · telegram · memory · approvals · web · screen · installed ones    │
                  └──────────────────────────────────────────────────────────────────────────┘
   The agent's computer: the environment in use (local: this machine, from your user's home).
```

## The core

- **The main thread** is the chief of staff (`src/pi/harness.ts`): one conversation, worked in short slices.
- **Addressed inputs** (`src/pi/inputs.ts`). Every input has a cause: you, a job's report, an extension's message (an approval's decision), a schedule, or a problem. The answer goes back the way it came, threaded under what it answers, exactly once. Problems with extensions are inputs too, so the chief hears about them and can get them fixed.
- **Open items** are the record of what's been promised, asked or is in progress. With a short working set, they are what each slice starts from.
- **The team** (`src/pi/delegation.ts`) is one job agent per job, with subagents if a job needs them.
- **The computer** (`src/pi/computer.ts`): bash and files for every agent, on the environment in use.
- **Skills and standing instructions** (`src/pi/skills.ts`), as pi has them: skills listed in every prompt and read when a task needs one (the `skill` tool reads one wherever it is); pi's `AGENTS.md` in every prompt. The agent's own live in its home on its computer, so it extends itself with them (the extending-japa skill says how).
- **Schedules** (`src/pi/schedules.ts`): messages the chief of staff gets on time. Its own, made with `schedule` when you ask, and those extensions register. A time missed while japa was down runs once when it's back.
- **History** (`src/pi/history.ts`): `search_history` over everything said to and by the chief.
- **The UI** (`src/core/ui.ts`) shows channel-neutral cards with buttons, draws pi's dialogs (`ctx.ui`) as cards, and runs japa's commands (`/settings`, `/jobs`), pi's (`/login`, `/logout`, `/model`, `/thinking`, and `/session`: spend by job, from pi's own ledger), and those extensions register.
- **The installer** (`src/pi/installer.ts`) adds extensions from chat.

## What extensions register, and its owner

Each kind has one typed interface (pi's, where pi has the kind) and one owner in the core (`Owners` in `src/pi/extension.ts`; `src/pi/owners.ts` and the modules beside it). One lifecycle covers every kind: what an extension registered is put in use when it's turned on, in this order, and taken out in reverse when it's turned off. A failure is a problem the chief of staff hears; the rest of the extension still starts. A default has no privilege an extension you install lacks, so you can replace any of them.

| Kind | An extension registers it with | Its owner in the core | Built in |
|---|---|---|---|
| **Tool** | `registerTool` (pi's annotations) | runs it on Pi Durable, for every agent | memory, web, screen |
| **Command** | `registerCommand` (`ctx.ui`'s dialogs) | offers it on the UI; a taken name is refused | approvals |
| **Event handler** | `on(...)`: `session_start`, `before_agent_start`, `tool_call`, `exchange_end`, ... | hooks and prompt sections on Pi Durable | memory, approvals |
| **Skill** | `resources_discover` | lists it in the prompt | |
| **Setting** | `registerFlag` | shows it on the extension's page in `/settings`; `settings.json` | memory, web |
| **Model provider** | `registerProvider` (a pi-ai `Provider`) | puts it on the core's `Models`; a provider it replaces comes back when it's off | pi-ai's providers |
| **Account** | `registerAccount` (pi-ai's auth: an API key, OAuth) | offers its login in `/login`, keeps it in `auth.json`, refreshes it; `pi.accounts.get` asks you to log in when it's missing | telegram (its bot), web (Parallel) |
| **Environment** | `registerEnvironment` (Pi Durable's `ExecutionEnv`) | the agent's computer: the last one turned on. Every command there starts without japa's keys | local |
| **Channel** | `registerChannel`: `platform`, `open({ inbox, ui })`, `show(card)`, `close()` | opens it with its platform's `Inbox` (the allowlist gate, `src/channels/inbox.ts`) and the `UI`, shows cards on it, closes it | telegram |
| **Schedule** | `registerSchedule` | sends the chief of staff its message on time, across restarts | |
| **MCP server** | `registerMcpServer` (pi's config: a command, or a URL) | connects it while it's on; its tools are the extension's (`mcp__<server>__<tool>`); an OAuth login is an account | |

The last channel that's open, and the only computer, can't be turned off: their owners say why.

What's built on the owners is generic and never names an implementation:
- **`/login` and `/logout`**: model providers and accounts alike, with their own logins;
- **`/model` and `/thinking`**: the models on `Models`, every agent's model;
- **`/settings`**: each extension's page, from what it registered (its switch, its settings);
- **the UI**: install cards, pi's dialogs (approvals ask through them), and the commands a channel advertises;
- **the computer**: shell, files and the screen through the call's environment (`api.env`), and `pi.exec`.

## One message, end to end

1. **In.** The channel passes your message to its Inbox, which refuses anyone not on the allowlist. A message is text plus any files: photos, voice notes, audio, video, documents. Every file is put on its computer, in `inbox/` under the agent's home there, and the message says where. A photo is also shown to the model directly when the model takes images. The message is saved before anything runs, so if the process dies, the answer still goes out after the restart.
2. **A slice.** The chief of staff doesn't carry the whole history. A slice starts from **state**: open items, a short working set, and the last few messages. A new slice begins when any of these happens:
   - you've been quiet for a while;
   - the context would grow too large;
   - you send `/new`;
   - you reply to something from an earlier slice.

   The departing slice updates the working set in the background, so your message never waits. Every boundary but the size one also ends an **exchange**: extensions hear about it then (memory reflects on it), over all the slices it took. History search brings back anything older.
3. **Answer, or delegate.** By itself the chief does only the very simple: an answer it knows, or a quick tool call or two. Everything else goes to `delegate`, which starts a job agent in its own conversation, with its own model. The chief replies at once, and the chat is free again.
4. **Work.** A job agent has bash and files, the skills and standing instructions, and the tools extensions give (web search and fetch, the screen, ...). It can split work across subagents, and decides when to `report`. If it ends its run without a report, its last words count as its report.
5. **Approval.** Every tool call that acts, on the machine (files included) or beyond it, passes the approvals extension's `tool_call` handler first, where a fast model reviews it. Only tools that say they touch nothing but the agent's own state (pi's `openWorldHint: false`: memory, open items, jobs) skip it. Anything that sends as you, spends, deletes your things, deploys or changes accounts is **blocked, not held**:
   - you get **Approve / Deny / Always** buttons;
   - the agent ends its turn;
   - your decision comes back to it as a message;
   - an approved call then goes through exactly once.

   Work on its own computer goes ahead, except changing japa's own code or data, or reading its data (its keys and settings are there), which waits for you too. If the review fails, it's retried, then retried with the main model, before you're asked. Every reviewed call goes to `audit.jsonl`.
6. **Back to you.** A report wakes the chief of staff, not you. The chief checks it, can redirect the job, and connects it with what it knows. Its reply is what you hear, threaded under your original message. A reply to progress reports alone stays with it. A job closes when it reports done, and asking for more of it opens it again, with everything it knew.
7. **On its own.** A schedule wakes the chief without you: its own, made when you ask ("remind me on Friday"), or one an extension registers. So does an extension's message (`sendUserMessage`) when something happens. As with reports, what it replies reaches you.

## Memory

Memory is one short free-form document, `memory/memory.md` in the data directory, kept to what would change how the agent helps you weeks from now. It changes only through small edits. A reflection at the end of each exchange does most of them: it sharpens or merges lines rather than adding, and marks things that stopped being true. `remember` is for when you ask it to remember, correct or forget something. Memory has a size in words (its setting on memory's page in `/settings`): past it, an addition gets in only if a correction makes room. The directory is a git repo, so every change is a commit you can read and undo. Everything said before is searchable (`history.sqlite`, rebuilt from the transcript if lost).

## Extensions installed from chat

They run inside japa exactly like the built-in ones: same API, same owners, no restrictions. The line is your Install tap. The details are in [Extensions](extensions.md#from-chat).
