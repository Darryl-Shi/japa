# Extensions

Everything beyond the core is an extension: one kind, `JapaExtension` (`src/pi/extension.ts`), made from the **Host**. The Host is everything an extension may use: settings, secrets, the data directory, models, the workbench, UI cards, `wake`, holds, `emit` and history search. An extension never touches the main thread directly; even a channel's messages come in through an adapter.

## Built in

Each one can be switched off in `/settings`. Built-in extensions run inside japa.

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
2. The chief of staff calls `install_extension`. The code is copied to `extensions/` in the data directory and loaded in its sandbox, to see what it declares. If it doesn't load, the agent hears why and you're never asked.
3. If it loads, you get a card saying what it would get: its tools, hooks, providers, channel, keys and npm packages. It has Install and Don't install buttons, every time, whatever the approvals mode.
4. When you tap Install it's on from your next message, with no restart.

Installing a new version replaces the old one in place. At start, installed extensions are registered again from what they declared, without waiting for their machine. `remove_extension` takes one out.

## How installed extensions run

The agent loop, saved state, keys and your consent stay in japa, but an installed extension's code doesn't run there. Each one is split in two (`src/pi/sandbox.ts`):
- **On the extensions machine,** its code runs in a small host process (`src/sandbox/host.mjs`), with its own npm packages. Its Host is a set of requests back to japa, and its keys are placeholders.
- **In japa,** a stand-in is registered from what the code declared. Every tool, prompt section, hook, channel call and lifecycle call is forwarded to the code through nothing but the machine's `exec`: one command per call, plus a long poll for what the code asks of japa.

japa holds the trust lines on its side:
- **Keys.** The code's `host.secrets.get` returns a placeholder such as `japa-secret:weather.key`. A web request carrying one goes out through japa, which fills in the real value (only for the extension's own keys) and masks it again in the answer.
- **Hooks.** A hook can rewrite only the extension's own tools' calls and results. For anyone else's tool it can only block.
- **Safe tools.** An extension vouches only for its own tools.
- **Cards and channels.** Its cards' buttons must start with its own name. A channel's messages still come in only through its platform's inbox.
- **Providers.** A model provider becomes a provider in japa, on pi-ai's built-in API for each model, with its key from `/login`. Its last model list is kept, so its models are available before its machine is.

An extension with a life of its own (a channel, or something it starts) keeps its process running. If the process dies, the chief of staff hears about it and the process is brought back. One that won't start is tried three times, then left until it's turned off and on or reinstalled. An extension that only answers calls starts on its first call, so its machine can sleep.

Durable tasks and machine providers are only for built-in extensions.
