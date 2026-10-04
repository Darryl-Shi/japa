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

Settings are read again on every message, so there's no need to restart. Models are `model` (the main thread) and `delegateModel`, each written as `{ "provider": "...", "modelId": "..." }`.

`npm test` runs the tests against pi-ai's faux provider, so no API key is needed. `npm run check` type-checks.
