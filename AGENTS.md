# Working on japa

japa is a chief of staff that each user makes their own: their channel, their models, the machine it runs on, and
extensions they add from chat. Most decisions below follow from that. The default setup (Telegram, one pi-ai provider)
is one configuration of japa, never something the code may assume.

pls dont hardcode anything, introduce unecessary abstraction or give up on flexibility and assume a specific working
path. (The user's words; what follows is what they mean here.)

## One core, one unit, one adapter per thing japa is built from

The core is what japa *is*, and can't be turned off: the main thread (the chief of staff), open items, the team of job
agents, triggers, the UI and its commands, and the installer. Everything else is an extension, and there is exactly
one kind: `JapaExtension` (`src/pi/extension.ts`), made from the `Host` and hooked in only through it.

The things japa is built from each have one generic, typed adapter in the core, and every implementation goes through
it, the built-in ones included:

- a **capability** is a `JapaExtension` made from the `Host` (`src/pi/extension.ts`): a Pi extension, plus the fields
  japa's own flow needs (who gets it, its settings, its safe tools, its exchange end, its triggers, its lifecycle);
- a **channel** is a `Channel` in an extension's `channel` (`src/pi/extension.ts`), opened with its platform's `Inbox`
  (the allowlist gate) and the `UI`;
- a **model provider** is a pi-ai `Provider` on the core's `Models`, its credential in pi's `auth.json` (`/login`).

The core opens a channel while its extension is on, and shows cards on it, and closes it when it's off.
docs/architecture.md has the full table.

There is no machine adapter, because there is no other machine: japa runs on one, and that machine is the agent's
computer. Its tools run there through Pi's own local environment, in the agent's home. Where that machine is (a
laptop, a server, a VM) is the installer's business, not the code's.

The adapter is where the type is enforced, so a provider can't half-implement the contract, and nothing reaches around
it: the Host has no inbox, so a channel's messages come in only through the one it was opened with. What's built on an
adapter stays generic: shell, files and the screen only use the call's environment (`api.env`); `/login` and the model
picker only use `Models`; `/settings` and approvals only show cards on the `UI`. None of them names an implementation.

Because built-ins use the same path, a default has no privilege an installed extension lacks: the user can replace any
of them. For example, Telegram used to attach itself to the UI and fetch its own inbox; now it declares a `Channel` and
the core opens it. And what only some users want isn't built in: Claude Code and Codex used to be, and now a coding
agent is an extension a user adds from chat if they want one.

When something new comes up, ask which it is. Something japa is built from gets an adapter in the core. A capability
(email, calendar, a skill) is an extension. Neither needs a second unit kind, a registry beside the adapter, or an
option nobody asked for. A deleted speculative feature costs nothing; a kept one costs every reader.

## The specific lives in its extension

Behaviour that belongs to one provider or channel stays in that extension. The core changes only for a
mechanism every implementation shares. When the Sudocode provider's models didn't show in `/settings`, the wrong fix
was a core page and refresh calls for that case. If a fix names one provider or channel, it doesn't belong in the core.

## Commands: japa's own, and pi's

The UI's commands are of two kinds, and nothing in between. japa's own are for its own flow: `/settings`, `/jobs`,
`/new`. pi's are pi's commands, offered in chat when the user needs one and has no other way to reach it there (no
terminal): `/login`, `/logout`, `/model`, `/thinking`. They keep pi's names and meaning, and are thin over pi's own API
(`Models`, a conversation's model and thinking level). A pi command that only makes sense in a terminal (`/hotkeys`,
`/quit`) or against japa's design (`/tree`, `/fork`, `/compact`: japa is one conversation, worked in slices) isn't
offered. A new command is one or the other; a japa invention that wraps pi is neither.

## Nothing hardcoded, nothing assumed

- **Values** come from settings, secrets, pi's credential store, or live state. That means no keys, models, hosts or
  names in code or prompts. No default models: the user picks from what they've logged in to.
- **Locations** come from where things actually are: `JAPA_DATA` (`host.dataDir` for an extension's own files), the
  code's own directory (`import.meta.dirname`), the agent's `home` (the home directory of the user japa runs as).
  Never a fixed directory like `~/jarvis-home` or `/tmp/japa`.
- **Formats** don't bake in one implementation. A `CardRef` carries the channel's own ids as strings, because every
  channel has its own id format; Telegram converts at its edge.

## Prompts carry the role, not the setup

The chief of staff answers, decides, delegates and synthesizes. By itself it does only the very simple: answer from
what it knows, or one or two quick tool calls. Everything else is a job, so the user is never left waiting.

Prompts say "the user" and "the conversation". They name no channel, no provider and no machine, and never the
owner's name (that comes from settings); a person is "they". The base prompt stays small:
- each slice starts from state (open items, the working set, the last few messages), not from replayed history;
- a how-to goes where it's read when needed (the extension guide is in `install_extension`'s description), not into
  every turn.

## Trust lines

- Secrets never go in code or `settings.json`. Model credentials live in pi's `auth.json`, through `/login`. Extension keys
  live in `secrets.json`, through a secret settings field.
- Secrets never go in a command's environment. japa's own keys are taken out of the environment its commands run in;
  a key a command needs is passed to that one command.
- There is one machine. The agent's shell, files and screen are the machine japa runs on, as the user japa runs as, so
  nothing but review stands between them and japa's own files: every action is reviewed, and only effects beyond the
  machine, or on japa's own code and data, wait for the user.
- Every extension runs inside japa with the Host, keys included, built-in or installed from chat, with no
  restrictions a built-in doesn't have. So the user approves every install with a card, whatever the approvals mode,
  and the code is checked before they're asked.
- The allowlist is edited only in `settings.json`; no tool of japa's changes it.

## Continuity

- **Saved state outlives code.** Durable ids keep their `jarvis.*` names (`jarvis.outbox`, `jarvis.jobs`, ...),
  because renaming them would orphan state already saved. Records saved before a format change are read leniently:
  numeric message ids still match.
- **The installer is the migration.** Re-running it updates the code and moves anything in an older layout (memory,
  log) into place, so a deploy is always: push, then re-run the installer.
- **Pi is experimental.** Only `src/pi` imports Pi; our own formats live in `src/core`.

## Checking your work

`npm run check` type-checks; `npm test` runs the whole agent on pi-ai's faux provider, with no key needed. A test
reaches japa the way a user's code would: its agent gets a home of its own on this machine, and anything else it needs
is an extension, not a back door.
