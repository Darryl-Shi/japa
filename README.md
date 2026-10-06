# japa

japa is a personal chief of staff you message, on Telegram by default. Ask it something small and it answers in seconds. Give it something bigger and it says "on it", hands the work to its team, and comes back with the result as a reply to the message that asked for it. It remembers you, and it asks before it does anything that sends, spends, deletes or deploys on your behalf.

It should feel like texting one competent person who just gets it done.

## What it's like to use

- **One chat.** You talk to one assistant in one conversation. It never makes you wait while it works, and you never need a new thread for a new topic.
- **A team behind it.** Longer work goes to job agents. They can browse the web, write and run code, and use a desktop, all on the computer japa runs on. Each one reports back to your chief of staff, who checks the work and tells you what matters.
- **It remembers.** It keeps a short memory of you and your world, brought up to date after each conversation, which you can read and correct. It can also search everything you've ever said to it.
- **It asks first.** Anything that acts on the world for you (sending a message, spending money, deleting your things) comes to you as a card with Approve, Deny and Always buttons. Reading, researching and work on its own computer just go ahead.
- **It acts on its own when asked.** Ask it to remind you, or to do something every morning, and it schedules it; it also wakes when something happens. Either way it decides whether it's worth telling you.
- **It grows.** Ask it to learn something new, such as connecting to a service you use, and it can build that ability itself, or plug in an MCP server. You approve each one with a tap, and it's available from your next message.

## Install

On any Linux machine that stays on. That machine becomes its computer too, with its own shell there, so give it one of its own (a small VM is plenty):

```bash
curl -fsSL https://raw.githubusercontent.com/Darryl-Shi/japa/main/install.sh | bash
```

It asks for:
- a Telegram bot token, from [@BotFather](https://t.me/BotFather);
- optionally an AI model provider (Anthropic, OpenAI, Google, OpenRouter, Z.ai and others), with an API key or a subscription login; or later, with `/login`;
- your name and time zone;
- optionally a [Parallel](https://parallel.ai) key, for web search; or later, with `/login`.

Keys go in `auth.json` in its data directory, the one place every login is kept. At the end it asks you to send your bot `/whoami`, so that only you can talk to it. To update, run the same command again.

## Everyday use

Just message it. A few commands help:

| Command | What it does |
|---|---|
| `/settings` | Choose models, set your name and time zone, and switch each extension on or off and set its options, all with buttons |
| `/model`, `/thinking` | Which model the chief of staff and its jobs use, and how hard each one thinks |
| `/login`, `/logout` | Connect an AI model provider, or an account an extension uses (its bot, a service), or disconnect one |
| `/session` | What it has spent so far, by job |
| `/jobs` | See what the team is working on and what's scheduled, and close or cancel a job |
| `/new` | Start a fresh topic |

## Keeping you safe

- **Only you get in.** People not on its allowlist are turned away before anything runs, and the assistant can't change that list.
- **Your keys stay in japa's files.** Every login is in `auth.json`. Its commands don't get keys in their environment; a key one needs is passed to that command alone. By default its shell is on the same machine, though, which is why it should have a machine of its own.
- **New abilities need your yes.** Anything it builds for itself is checked first, then waits for your tap. Once installed, it works exactly like a built-in ability, with the same access, so only install what you'd trust.
- **You decide what matters.** Consequential actions wait for your tap. "Always" permissions come only from you, and you can remove them with `/approvals`.

## Learn more

- [How it works](docs/architecture.md): the main parts and how a message flows through them
- [Abilities (extensions)](docs/extensions.md): what's built in, and how to add more
- [Configuration](docs/configuration.md): settings, where data lives, and the agent's computer
- [Security](docs/security.md): the lines it holds, and where
- [Development](docs/development.md): running the tests and finding your way around the code

## What's next

- **Habits:** email and calendar, remembered how-tos, standing routines, and digests instead of interruptions.
- **WhatsApp**, as an inbox it can read and reply from with your approval.
- **Voice.**

It's built on [Pi Durable](https://github.com/earendil-works/pi/tree/main/packages/durable), so whatever it's in the middle of survives a restart.
