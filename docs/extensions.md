# Extensions

Everything beyond the core is an extension, and an extension is what it is in pi: a module whose default export is a
factory given `pi`, pi's `ExtensionAPI` (`src/pi/extension.ts`). On it, the extension registers what it adds (tools,
commands, model providers) and handles pi's events. The names and meanings are pi's, so pi's extension docs apply.
japa implements them on Pi Durable:

| pi | on Pi Durable |
|---|---|
| `before_agent_start` (`systemPromptOptions.sections`), tools' `promptGuidelines` | a prompt section |
| `tool_call` (block, terminate, input patched in place), `tool_execution_start` | the tool task's `beforeTool` hook |
| `tool_result`, `tool_execution_end` | its `afterTool` hook |
| `context`, `turn_start` | the generation task's `beforeRequest` hook |
| `message_end`, `turn_end`, `agent_end` | its `afterResponse`, `afterTools` and `onYield` hooks |
| a tool's `details`, `terminate`, `onUpdate`, `prepareArguments`, `executionMode` | the tool's result, control, output and details |
| `sendUserMessage`, `sendMessage` (`triggerTurn`) | an input that starts a turn |
| `sendMessage` without `triggerTurn` | a write into the conversation, for its next turn |
| `appendEntry`, `ctx.sessionManager.getEntries()` | entries kept in the data directory |
| `setActiveTools`, `defaultActive` | the agent's tool filter (job agents start with the chief of staff's) |
| `setModel`, `setThinkingLevel` | the chief of staff's model in settings, as `/model` sets it |
| `session_start`, `session_shutdown`, `resources_discover` | turned on and off; skills |

What only a terminal shows (shortcuts, flags, renderers, `ctx.ui`'s status, widgets and title) is accepted and not
drawn, as in pi without a terminal; a flag is always its default. Anything else of pi's API japa doesn't have fails when
it's used, saying which; in the factory, the extension doesn't load, and the chief of staff hears why.

Where japa is built from something pi isn't, it's in the same API:

- a messaging channel: `registerChannel`;
- the end of an exchange with the user: the `exchange_end` event;
- more than one agent: `ctx.agent` (`"chief"` or `"job"`), and `to` on `sendUserMessage` and `sendMessage`;
- keys that aren't model credentials: `secrets`.

## Built in

Each one can be switched off in `/settings`. Every extension runs inside japa, built in or installed from chat, the
same way.

| Extension | Gives | Uses |
|---|---|---|
| telegram | the channel: messages, replies, buttons | `registerChannel`; its token from `secrets` |
| memory | `remember`, memory in the chief of staff's prompt | `before_agent_start` (for `ctx.agent === "chief"`); `exchange_end` (reflection) |
| approvals | review before every tool call, the dialog that asks you, `/approvals`, the audit log | `tool_call` (blocks and waits, pi's `terminate`); `ctx.ui.select`; `sendUserMessage` to the agent that asked |
| web | `web_search`, `web_fetch` (Parallel, fast mode), `/web` for its key | `registerTool`, `registerCommand`, `secrets` |
| screen | the `computer` tool on the machine's desktop (only when it has one) | `exec` |

The agent's computer (bash and files), its skills and standing instructions, and `search_history` are part of the
core.

## Writing one

```ts
import { Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "../pi/extension.ts";

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "forecast",
    label: "Forecast",
    description: "Today's forecast for a city.",
    parameters: Type.Object({ city: Type.String() }),
    annotations: { readOnlyHint: true, openWorldHint: true },
    execute: async (_id, params, signal) => {
      const key = pi.secrets.get("apiKey", "WEATHER_API_KEY");   // secrets.json, as "<name>.apiKey"
      // ...fetch with key and signal...
      return { content: [{ type: "text", text: "Sunny." }] };
    },
  });
  pi.registerCommand("weather", {                                // its own settings, as cards
    description: "Weather: its API key",
    handler: async (_args, ctx) => {
      const key = await ctx.ui.input("Send your weather API key as a reply.", "API key", { secret: true });
      if (key) pi.secrets.set("apiKey", key.trim());
      ctx.ui.notify("Saved.");
    },
  });
  let timer: ReturnType<typeof setInterval> | undefined;        // its own schedule
  pi.on("session_start", () => void (timer = setInterval(() => pi.sendUserMessage("Check the forecast; tell me only if it matters."), 86_400_000)));
  pi.on("session_shutdown", () => clearInterval(timer));
}
```

It's named by its key in `settings.extensions` (as installed, or in `main.ts` for a built-in). Its tools are for the
chief of staff and job agents both. A prompt section can be for one of them only, since `before_agent_start` says
which (`ctx.agent`). Every call of its tools is reviewed before it runs (see [Approvals](security.md)), unless the tool
says `openWorldHint: false`. That's only for tools that touch nothing but the agent's own state, the way `remember`
does. A tool that reads or writes files, or reaches the web, is reviewed.

Besides that, an extension can:

- run work when an exchange with the user ends (`exchange_end`): they went quiet, sent `/new`, or went back to an
  earlier message;
- start and stop as it's switched on and off (`session_start`, `session_shutdown`). A timer it sets there is its
  schedule: times missed while japa was down are skipped;
- ask the user (`ctx.ui`: `select`, `confirm`, `input`, `notify`), drawn as cards on whichever channel is on;
- wake an agent (`sendUserMessage`);
- run programs on the machine (`exec`);
- add a model provider (`registerProvider`). Its credential is pi's, set with `/login`;
- be a messaging channel (`registerChannel`), through its [adapter](architecture.md#adapters). A channel is opened with
  its platform's inbox, so it gets the allowlist for free;
- bring skills (`resources_discover`).

A key never goes in code or `settings.json`: it goes in `secrets`, set through the extension's own command. Its
options, if it has any, are read from `settings.json`'s `extensions.<name>` (`getSettings()`).

## From chat

The agent extends itself while running, and the [extending-japa skill](../skills/extending-japa/SKILL.md) says how.
Smaller changes than an extension don't need one: a standing instruction (pi's `~/.pi/agent/AGENTS.md`) or a skill
(`~/.pi/agent/skills/<name>/SKILL.md`) in its home applies from the next message. An extension:

1. A job writes the extension on its computer, against a clone of japa, until `npm run check` passes. It can be one
   `.ts` file, or a directory with a `package.json` for its own npm packages. Its default export is
   `(pi: ExtensionAPI) => void`.
2. The chief of staff calls `install_extension`. The code is copied to `extensions/` in the data directory and checked
   without running it: where it starts, that its imports resolve, and its own npm packages installed (without their
   scripts). Packages japa has are japa's, so it runs against what japa runs. If it wouldn't load, the agent hears why
   and you're never asked.
3. Otherwise you get a card: where it's from, its size, the web addresses in it, and its own packages. It has Install
   and Don't install buttons, every time, whatever the approvals mode.
4. When you tap Install it's loaded, and on from your next message, with no restart.

Installing a new version replaces the old one in place. At start, installed extensions load again. One that no longer
loads is reported to the chief of staff, including one written in an older shape (a factory returning an extension
object), so it can be rewritten. `remove_extension` takes one out.

## How installed extensions run

Exactly like the built-in ones: inside japa, given the same API, through the same adapters. An installed extension can
do anything a built-in can, and reads its keys with `pi.secrets.get`. That's why only your tap installs one.
