# Working on japa

japa is a chief of staff that each user makes their own: their channel, their models, the machine it runs on, and
extensions they add from chat. Most decisions below follow from that. The default setup (Telegram, one pi-ai provider)
is one configuration of japa, never something the code may assume.

pls dont hardcode anything, introduce unecessary abstraction or give up on flexibility and assume a specific working
path. (The user's words; what follows is what they mean here.)

## One core, one unit, one owner per kind

The core is what japa *is*, and can't be turned off: the main thread (the chief of staff), open items, the team of job
agents, the agent's computer, skills and standing instructions, schedules, the UI and its commands, and the installer.
Everything else is an extension, and an extension is a pi extension: a factory given pi's `ExtensionAPI`
(`src/pi/extension.ts`), with pi's names and meanings, so pi's docs apply. japa implements that API on Pi Durable.

Each kind of thing an extension registers has one typed interface (pi's, where pi has the kind) and one owner in the
core (`Owners`), and every one goes through it, the built-in ones included. One lifecycle covers them all: what an
extension registered is put in use while it's on and taken out when it's off.

| Kind | Registered with | Its owner in the core |
|---|---|---|
| tool | `registerTool`, with pi's annotations | runs it on Pi Durable, for every agent |
| command | `registerCommand`, with `ctx.ui`'s dialogs | offers it on the UI; a name that's taken is refused |
| event handler | `on(...)`: `session_start`, `before_agent_start`, `tool_call`, ... | hooks it into Pi Durable |
| skill | `resources_discover` | lists it in the prompt |
| setting | `registerFlag` | shows it on the extension's page in `/settings`; kept in `settings.json` |
| model provider | `registerProvider`, a pi-ai `Provider` | puts it on the core's `Models`; its login is in `/login` |
| account | `registerAccount`, with pi-ai's auth | offers its login in `/login`, keeps it in `auth.json`, refreshes it (`pi.accounts.get`) |
| environment | `registerEnvironment`, Pi Durable's `ExecutionEnv` | makes it the agent's computer (the last one turned on) |
| channel | `registerChannel` | opens it with its platform's `Inbox` (the allowlist gate) and the `UI`, and shows cards on it |
| schedule | `registerSchedule` | sends the chief of staff its message on time, across restarts |
| MCP server | `registerMcpServer`, pi's config | connects it; its tools are the extension's |

What pi's API already expresses needs nothing new: which tools skip review is a tool's own annotation, chief or job
is `ctx.agent`. Where japa is built from something pi isn't (a channel, an account that isn't a model provider, the
agent's computer, a schedule, the end of an exchange, more than one agent), it's in the same API, as one more method
or event, never a second kind of unit.

The agent's computer is an environment like any other. The built-in one (`local`) is the machine japa runs on, from
the home directory of the user japa runs as; an extension can give it another. Everything that touches the computer
goes through the environment in use: the shell and file tools, `pi.exec`, files the user sends, the agent's own
skills, the code it writes for install. Where that machine is (a laptop, a server, a VM) is the installer's or an
extension's business, not the code's.

The owner is where the type is enforced, so an implementation can't half-implement the contract, and nothing reaches
around it: the API has no inbox, so a channel's messages come in only through the one it was opened with. What's built
on an owner stays generic: shell, files and the screen only use the call's environment (`api.env`); `/login` lists
model providers and accounts alike; `/settings` shows each extension's page from what it registered; dialogs are cards
on the `UI`. None of them names an implementation.

Because built-ins use the same path, a default has no privilege an installed extension lacks: the user can replace any
of them. For example, Telegram used to attach itself to the UI and fetch its own inbox; now it declares a `Channel`
and an account for its bot, and the core opens it. And what only some users want isn't built in: Claude Code and
Codex used to be, and now a coding agent is an extension a user adds from chat if they want one.

When something new comes up, ask which it is. Something japa is built from gets an owner in the core. A capability
(email, calendar, a skill) is an extension. Neither needs a second unit kind, a registry beside the owner, or an
option nobody asked for. A deleted speculative feature costs nothing; a kept one costs every reader.

## The specific lives in its extension

Behaviour that belongs to one provider or channel stays in that extension. The core changes only for a
mechanism every implementation shares. When the Sudocode provider's models didn't show in `/settings`, the wrong fix
was a core page and refresh calls for that case. If a fix names one provider or channel, it doesn't belong in the core.

## Commands: japa's own, and pi's

The UI's commands are of two kinds, and nothing in between. japa's own are for its own flow: `/settings`, `/jobs`,
`/new`. pi's are pi's commands, offered in chat when the user needs one and has no other way to reach it there (no
terminal): `/login`, `/logout`, `/model`, `/thinking`, `/session`. They keep pi's names and meaning, and are thin over
pi's own API (`Models`, a conversation's model, thinking level and usage). Where japa's design differs, the command
follows it: `/session` is by job, since jobs do the work. A pi command that only makes sense in a terminal (`/hotkeys`,
`/quit`) or against japa's design (`/tree`, `/fork`, `/compact`: japa is one conversation, worked in slices) isn't
offered. A new command is one or the other; a japa invention that wraps pi is neither.

## Nothing hardcoded, nothing assumed

- **Values** come from settings, pi's credential store, or live state. That means no keys, models, hosts or names in
  code or prompts. No default models: the user picks from what they've logged in to.
- **Locations** come from where things actually are: `JAPA_DATA` (`pi.dataDir` for an extension's own files), the
  code's own directory (`import.meta.dirname`), the agent's home (the computer's working directory; on the machine
  japa runs on, the home directory of the user it runs as). Never a fixed directory like `~/japa-home` or `/tmp/japa`.
- **Formats** don't bake in one implementation. A `CardRef` carries the channel's own ids as strings, because every
  channel has its own id format; Telegram converts at its edge.

## Prompts carry the role, not the setup

The chief of staff answers, decides, delegates and synthesizes. By itself it does only the very simple: answer from
what it knows, or one or two quick tool calls. Everything else is a job, so the user is never left waiting.

Prompts say "the user" and "the conversation". They name no channel, no provider and no machine, and never the
owner's name (that comes from settings); a person is "they". The base prompt stays small:
- each slice starts from state (open items, the working set, the last few messages), not from replayed history;
- a how-to is a skill, read when needed (how japa extends itself is `skills/extending-japa`), not in every turn.

## Trust lines

- Secrets never go in code or `settings.json`. Every login's credentials (model providers' and accounts', a channel's
  token among them) live in pi's `auth.json`, through `/login`; an extension asks for its own with `pi.accounts.get`.
- Secrets never go in a command's environment. An environment variable a login reads is one of japa's keys, and the
  core unsets it in every command the agent's computer runs, whichever computer that is; a key a command needs is
  passed to that one command.
- On the built-in computer, the agent's shell, files and screen are the machine japa runs on, as the user japa runs
  as, so nothing but review stands between them and japa's own files: every action is reviewed, and only effects
  beyond the machine, changes to japa's own code or data, or reading its data, wait for the user.
- Every extension runs inside japa with the same API, keys included, built-in or installed from chat, with no
  restrictions a built-in doesn't have. So the user approves every install with a card, whatever the approvals mode,
  and the code is checked before they're asked.
- The allowlist is edited only in `settings.json`; no tool of japa's changes it.

## Continuity

- **Saved state outlives code.** Durable ids are `japa.*` (`japa.outbox`, `japa.jobs`, ...). State saved when they
  were `jarvis.*` is renamed when japa opens it, so none of it is orphaned; a rename like that always comes with its
  migration. Records saved before a format change are read leniently: numeric message ids still match, and a number
  saved before its setting was a flag reads as that setting.
- **The installer is the migration.** Re-running it updates the code and moves anything in an older layout (memory,
  log, keys from `secrets.json` or `.env` into `auth.json`) into place, so a deploy is always: push, then re-run the
  installer.
- **Pi is experimental.** Only `src/pi` imports Pi; our own formats live in `src/core`.

## Checking your work

`npm run check` type-checks; `npm test` runs the whole agent on pi-ai's faux provider, with no key needed. A test
reaches japa the way a user's code would: its agent gets a home of its own on this machine, and anything else it needs
is an extension, not a back door.
