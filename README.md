# pi-jarvis

A personal chief of staff on Pi Durable, reached over Telegram. See [PLAN.md](PLAN.md).

## Run

```bash
npm install
mkdir -p data
npx @earendil-works/pi-ai login anthropic && mv auth.json data/   # or any provider pi-ai supports
export TELEGRAM_BOT_TOKEN=...                                       # from @BotFather
npm start
```

Send `/whoami` to the bot, then put that ID into `data/settings.json`:

```json
{ "telegram": { "ownerChatId": 123456789 } }
```

Memory, a short portrait of you, lives in `~/jarvis-home/memory.md` (set `JARVIS_HOME` to put it elsewhere). It's yours to read and edit, and if that directory is a git repo, every change the agent makes becomes a commit. Search over everything said before is in `data/history.sqlite`, and it can be rebuilt from the transcript.

The agent's own computer (the workbench) is configured in `data/settings.json`. For boat.dev, set `BOAT_API_KEY` and use:

```json
{ "machines": { "workbench": { "provider": "boat", "type": "small", "screen": true } } }
```

`screen: true` lets the agent see and use the machine's desktop as well. The machine is created on first start (with none of your boat account's secrets), remembered in `data/boat-machines.json`, and resumed whenever it's needed. For local development, use `{ "provider": "local", "home": "data/machines/workbench" }`.

Settings are read again on every message, so there's no need to restart. Models are `model` (the main thread) and `delegateModel`, each written as `{ "provider": "...", "modelId": "..." }`.

`npm test` runs the tests against pi-ai's faux provider, so no API key is needed. `npm run check` type-checks.
