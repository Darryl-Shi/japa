---
name: extending-japa
description: How to change how you work, with a standing instruction, a skill, or an extension (give it to a job that writes one).
---

# Extending yourself

Use the smallest change that does the job:

| The user wants | Add | Who approves |
| --- | --- | --- |
| you to always (or never) do something | a **standing instruction** | nobody: it's in your home; tell the user what you added |
| you to know how to do a task that you do now and then | a **skill** | nobody: it's in your home; tell the user what you added |
| something you can't do with your tools: an API, a new command, a channel, a model provider, a check before tool calls | an **extension** | the user, with a tap, every time |

All three apply from the next message, with no restart. Paths below are on your computer. `~` is your home, and this
file's directory is in japa's own code, two directories up from here (`../..`).

## A standing instruction (a behaviour)

Standing instructions live in `~/.pi/agent/AGENTS.md`, pi's file for them, and are in every prompt, yours and your
jobs'. Keep each one to a line or two, in the user's terms ("Sign emails as Darryl's assistant", "Never book before
9am"), and edit the file rather than piling lines on. A fact about the user belongs in memory, not here. Never put a
secret in it.

## A skill

A skill is a directory with a `SKILL.md`, in `~/.pi/agent/skills/<name>/`, pi's place for them:

```markdown
---
name: <name, lowercase-with-dashes, the directory's name>
description: <one sentence: what it's for and when to read it. This is all you see until you read it, so make it specific.>
---

The steps, the commands, what to check. Relative paths are from this directory, so scripts or templates can sit
beside it.
```

Every skill is listed in your prompt with its description, and you (or a job) read its file when a task matches.
A job can write one: give it the format above.

## An extension

An extension is code that runs inside you, with your keys, so the user approves every install. You don't write it
yourself. Delegate a job, and its brief says to read this skill (give it this file's path). The job then does the
following.

1. **Get a working copy of japa** in a directory of its own: `git clone <japa's code dir> ~/japa-dev` (or copy it,
   leaving `node_modules` out), then `npm ci` there. japa's code is two directories up from this file. Read japa's
   code there, never change it in place.
2. **Write it** as `~/japa-dev/src/extensions/<name>.ts`, or as a directory there with an `index.ts` and a
   `package.json` if it needs npm packages of its own. Write it in pi's extension shape, below.
3. **Check it**: `npm run check` in `~/japa-dev` passes. If it reaches a service, try the calls there first.
4. **Install it**: report the path, and the chief of staff calls `install_extension` (path, name, a sentence for the
   user). It's checked again. The user gets a card showing what it reaches, and on their tap it's on. If it wouldn't
   load, the reason comes back. Fix it and install again. Installing again with the same name replaces it.
   `remove_extension` takes it out.

### The shape: a pi extension

It's a pi coding-agent extension, with the same API, names and meanings (see pi's extension docs). The full contract,
with what japa adds, is `src/pi/extension.ts` in japa's code.

```ts
import { Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "../pi/extension.ts"; // types only: `import type`

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "weather",
		label: "Weather",
		description: "The forecast for a place.",
		parameters: Type.Object({ place: Type.String() }),
		// openWorldHint: false only if it touches nothing but your own state; anything else is reviewed before it runs.
		annotations: { readOnlyHint: true, openWorldHint: true },
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			const key = pi.secrets.get("apiKey", "WEATHER_API_KEY");
			if (key === undefined) throw new Error("No weather key: the user sets one with /weather.");
			const response = await fetch(`https://api.example.com/forecast?q=${encodeURIComponent(params.place)}`, { headers: { authorization: key }, signal });
			return { content: [{ type: "text", text: await response.text() }] };
		},
	});

	// Its settings are its own command's, drawn as cards with buttons and replies.
	pi.registerCommand("weather", {
		description: "Weather: its API key",
		handler: async (_args, ctx) => {
			const key = await ctx.ui.input("Send your weather API key as a reply to this message.", "API key", { secret: true });
			if (key) pi.secrets.set("apiKey", key.trim());
			ctx.ui.notify("Saved.");
		},
	});
}
```

What it can use (`pi.`), with pi's meanings:

- `registerTool`: a tool, for you and your jobs. Throwing returns the error to the agent. A result can carry
  `details` and `terminate: true` (the run ends after this round); `onUpdate` streams partial output.
  `promptGuidelines` go in the prompt while the tool is active; `defaultActive: false` keeps it out until
  `setActiveTools` names it.
- `registerCommand(name, { description, handler(args, ctx) })`: a slash command the user can run. `ctx.ui` has
  `select`, `confirm`, `input` (with `{ signal, timeout }`), `editor` and `notify`.
- `on(event, handler)` (returns a function that unsubscribes), where the event is one of:
  - `session_start` and `session_shutdown`: it's turned on or off. Start and stop long-lived things here, not in the
    factory.
  - `before_agent_start`: add prompt text, `event.systemPromptOptions.sections.<key> = "..."`. `ctx.agent` is `"chief"`
    or `"job"`.
  - `tool_call`: return `{ block: true, reason }` to stop a call, or change `event.input` in place to patch it.
  - `tool_result`: return `{ content, details, isError }` to change a result.
  - `tool_execution_start`, `tool_execution_end`, `turn_start`, `turn_end`, `message_end`, `agent_end`: to observe.
  - `context`: return `{ messages }` to change what one request sends.
  - `resources_discover`: return `{ skillPaths }` for skills it brings.
  - `exchange_end`: an exchange with the user ended.
- `sendUserMessage(text, { to? })`: wake the chief of staff (or, with `to`, an agent's conversation), as if the user
  wrote. To act on a schedule, set a timer in `session_start` and clear it in `session_shutdown`. Times missed while
  japa was down are skipped.
- `sendMessage({ customType, content }, { triggerTurn?, to? })`: put a message in the conversation for its next turn,
  or (`triggerTurn`) start one.
- `appendEntry(customType, data)`: keep state in the session, never sent to the model. Read it back with
  `ctx.sessionManager.getEntries()`, in `session_start` after a restart.
- `getAllTools()`, `getActiveTools()`, `setActiveTools(names)`, `getCommands()`.
- `setModel(model)`, `getThinkingLevel()`, `setThinkingLevel(level)`: the chief of staff's, as `/model` sets them.
- `exec(command, args, { signal, timeout, cwd })`: run a program on your computer, without japa's keys in its
  environment.
- `registerProvider(provider)`: a pi-ai model provider (`createProvider`, `envApiKeyAuth` from
  `@earendil-works/pi-ai`). Its credential comes through `/login`, and its models appear in `/model`.
- `registerChannel({ platform, open({ inbox, ui }), show(card, replace?), close() })`: a messaging channel. Its
  messages go to `inbox`, and button presses, replies and commands go to `ui`. Who may talk is the allowlist in
  `settings.json`, never the extension's.
- Its own things:
  - `secrets.get(key, ENV_VAR?)` and `secrets.set`: its keys, kept in `secrets.json`. Never put a key in code,
    settings, or a prompt.
  - `getSettings()`: settings are read-only. Its own options are under `extensions.<name>`.
  - `dataDir`: where it keeps its files, named after itself.
  - `events`: messages between extensions.

What only a terminal shows (`registerShortcut`, `registerFlag`, which then reads its default, renderers, and
`ctx.ui`'s status, widgets and title) is accepted and not drawn. Anything else of pi's API isn't in japa: using it
fails at once, saying which (in the factory, the extension doesn't load, and you hear why).

What it can import:

- `@earendil-works/pi-ai` (`Type`, `createProvider`, ...) and node's own modules are there already.
- Any other package import is installed beside it.
- Types come only through `import type`.
- It isn't japa's own code, and it can't import from japa except types.

It's named by its install name, which is also its key in `/settings` (where the user turns it on and off), in secrets
and in settings. Once it's installed, tell the user what it does and the commands it added.
