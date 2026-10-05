# Working on japa

japa is a chief of staff that each user makes their own: their channel, their models, their machines, and extensions
they add from chat. Most decisions below follow from that. The default setup (Telegram, boat.dev, one pi-ai provider)
is one configuration of japa, never something the code may assume.

pls dont hardcode anything, introduce unecessary abstraction or give up on flexibility and assume a specific working
path. (The user's words; what follows is what they mean here.)

## One core, one unit, one adapter per thing japa is built from

The core is what japa *is*, and can't be turned off: the main thread (the chief of staff), open items, the team of job
agents, triggers, the UI and its commands (`/settings`, `/login`), and the installer. Everything else is an extension,
and there is exactly one kind: `JapaExtension` (`src/pi/extension.ts`), made from the `Host` and hooked in only
through it.

The things japa is built from each have one generic, typed adapter in the core, and every implementation goes through
it, the built-in ones included:

- a **capability** is a `JapaExtension` made from the `Host` (`src/pi/extension.ts`);
- a **channel** is a `Channel` in an extension's `channel` (`src/pi/extension.ts`), opened with its platform's `Inbox`
  (the allowlist gate) and the `UI`;
- a **model provider** is a pi-ai `Provider` in an extension's `providers`, its credential from `/login`;
- a **machine** is a `Backend`, opened by an `OpenBackend` in an extension's `backends` (`src/core/backend.ts`), picked
  by name in `machines.workbench`.

The core registers them while their extension is on (a channel is opened, and cards shown on it) and drops them when
it's off (the channel is closed). The README has the full table.

The adapter is where the type is enforced, so a provider can't half-implement the contract, and nothing reaches around
it: the Host has no inbox, so a channel's messages come in only through the one it was opened with. What's built on an
adapter stays generic: shell, files, screen and coding agents only run commands on a `Backend`; `/login` and the model
picker only use `Models`; `/settings` and approvals only show cards on the `UI`. None of them names an implementation.

Because built-ins use the same path, a default has no privilege an installed extension lacks: the user can replace any
of them. For example, boat.dev used to be a branch in `main.ts`'s switch; now it's an extension declaring
`backends.boat`, exactly as a user's own machine provider would. Telegram used to attach itself to the UI and fetch its
own inbox; now it declares a `Channel` and the core opens it.

When something new comes up, ask which it is. Something japa is built from gets an adapter in the core. A capability
(email, calendar, a skill) is an extension. Neither needs a second unit kind, a registry beside the adapter, or an
option nobody asked for. A deleted speculative feature costs nothing; a kept one costs every reader.

## The specific lives in its extension

Behaviour that belongs to one provider, channel or machine stays in that extension. The core changes only for a
mechanism every implementation shares. When the Sudocode provider's models didn't show in `/settings`, the wrong fix
was a core page and refresh calls for that case. The right fix was `/login` (any provider's own login, kept where pi
keeps credentials) and the provider adapter loading a provider's model list when it's registered. If a fix names one
provider, it belongs in that provider's extension.

## Nothing hardcoded, nothing assumed

- **Values** come from settings, secrets, pi's credential store, or live state. That means no keys, models, hosts or
  names in code or prompts. No default models: the user picks from what they've logged in to.
- **Locations** come from where things actually are: `JAPA_DATA` (`host.dataDir` for an extension's own files), the
  code's own directory (`import.meta.dirname`), the workbench's `home`. Never a fixed directory like `~/jarvis-home`
  or `/tmp/japa`.
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

- Secrets never go in code or `settings.json`. Model credentials live in `auth.json`, through `/login`. Extension keys
  live in `secrets.json`, through a secret settings field.
- Secrets never go on the workbench. A key a command needs is passed to that one command.
- Agent-written code runs on the workbench, not in the harness. The one exception is an extension, which runs inside
  japa with its keys. So the user approves every install with a card, whatever the approvals mode, and the file is
  checked before they're asked.
- The allowlist is edited only in `settings.json`; no tool can change it.

## Continuity

- **Saved state outlives code.** Durable ids keep their `jarvis.*` names (`jarvis.outbox`, `jarvis.jobs`, ...),
  because renaming them would orphan state already saved. Records saved before a format change are read leniently:
  numeric message ids still match.
- **The installer is the migration.** Re-running it updates the code and moves anything in an older layout (memory,
  log) into place, so a deploy is always: push, then re-run the installer.
- **Pi is experimental.** Only `src/pi` imports Pi; our own formats live in `src/core`.

## Checking your work

`npm run check` type-checks; `npm test` runs the whole agent on pi-ai's faux provider, with no key needed. A test
reaches japa the way a user's code would: a machine for a test is an extension declaring a backend, not a back door.
