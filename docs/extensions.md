# Extensions

Everything beyond the core is an extension: one kind, `JapaExtension` (`src/pi/extension.ts`), made from the **Host**. The Host is everything an extension may use: settings, secrets, the data directory, models, the workbench, UI cards, `wake`, holds, `emit` and history search. An extension never touches the main thread directly; even a channel's messages come in through an adapter.

## Built in

Each one can be switched off in `/settings`. Every extension runs inside japa, built in or installed from chat.

| Extension | Gives | Hooks into |
|---|---|---|
| Telegram | the channel: messages, replies, buttons | `channel`, `start`/`stop`, renders UI cards |
| Memory | `remember`, `search_history`, memory in the prompt | the chief of staff; `onSliceEnd` (reflection) |
| Approvals | review before every tool call, the buttons, the audit log | every agent (`beforeTool`); UI cards; `wake`; holds |
| Web | `web_search`, `web_fetch` (Parallel, fast mode) | every agent; a key in `/settings` |
| Computer, Screen | bash and files; the `computer` tool on the workbench's desktop | every agent; quiet while there's no workbench |
| Claude Code, Codex | `claude_code`, `codex` | job agents only; a key is passed to one command, never stored on the workbench |
| boat.dev | the `boat` machine provider | `backends`; its key in `/settings` |
| Local machine | the `local` machine provider, for development | `backends` |

## Writing one

```ts
export default function weather(host: Host): JapaExtension {
  return {
    name: "weather",
    title: "Weather",
    about: "Morning forecast, and a forecast tool.",
    settings: [
      { key: "city", label: "City", kind: "text" },              // appears in /settings
      { key: "key", label: "Weather API key", kind: "secret" },  // read with host.secrets.get("weather.key")
    ],
    defaults: { city: "Singapore" },
    chief: [forecastTools(host)],                                // Pi tools, prompt sections, hooks
    jobs: [forecastTools(host)],
    safeTools: ["forecast"],                                     // never needs approval
    triggers: [{ name: "morning", when: { at: "07:30" }, prompt: "Check today's forecast; tell me only if it matters." }],
  };
}
```

An extension can also:
- run work when a slice ends (`onSliceEnd`);
- start and stop as it's switched on and off (`start`/`stop`);
- show cards and handle their buttons (`host.ui`);
- wake an agent (`host.wake`) or raise an event that fires triggers (`host.emit`);
- be a messaging channel (`channel`), add model providers (`providers`), or add machine providers (`backends`), through the [adapters](architecture.md#adapters). A channel is opened with its platform's inbox, so it gets the allowlist for free.

A key never goes in code: it goes in a secret settings field, which the user sets in `/settings`.

## From chat

The agent extends itself while running:

1. A job writes the extension on the workbench. It can be one `.ts` file, or a directory with a `package.json` for its own npm packages. Its default export is `(host: Host) => JapaExtension`.
2. The chief of staff calls `install_extension`. The code is copied to `extensions/` in the data directory and checked without running it: where it starts, that its imports resolve, and its own npm packages installed (without their scripts). Packages japa has are japa's, so it runs against what japa runs. If it wouldn't load, the agent hears why and you're never asked.
3. Otherwise you get a card: where it's from, its size, the web addresses in it, and its own packages. It has Install and Don't install buttons, every time, whatever the approvals mode.
4. When you tap Install it's loaded, and on from your next message, with no restart.

Installing a new version replaces the old one in place. At start, installed extensions load again; one that no longer loads is reported to the chief of staff. `remove_extension` takes one out.

## How installed extensions run

Exactly like the built-in ones: inside japa, made from the same Host, through the same adapters. An installed extension can do anything a built-in can (tools, hooks, wraps, durable tasks, model providers, machine providers, a channel) and reads its keys with `host.secrets.get`. That's why only your tap installs one.
