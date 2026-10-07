# japa

japa is a personal chief of staff: a long-running AI agent (the "CoS") you chat with, which delegates work to
background jobs, remembers what matters, and runs reminders and schedules. It extends itself: it writes new skills,
worker profiles and extensions into its own git-tracked workspace, checks and installs them, and rolls them back
when they break.

## Requirements

- Node.js 24 or newer (japa runs its TypeScript directly)
- git
- An API key for a model provider supported by pi-ai (Anthropic, OpenAI, Google, OpenRouter, ...)

## Install

```sh
git clone <this repo> japa && cd japa
npm install
npm link        # puts `japa` on your PATH
```

## First run

1. Choose the CoS model in `~/.japa/settings.json`:

   ```json
   {
     "models": {
       "cos": { "provider": "anthropic", "modelId": "claude-sonnet-4-6" }
     }
   }
   ```

   Optional keys, shown with their defaults:

   ```json
   {
     "models": { "worker": { "provider": "...", "modelId": "..." }, "consolidation": { "provider": "...", "modelId": "..." } },
     "storage": { "adapter": "sqlite" },
     "secrets": { "adapter": "file" },
     "jobs": { "maxConcurrent": 4 },
     "context": { "resetTokens": 20000, "idleResetHours": 2, "toolResultTokens": 2000 },
     "memory": { "maxFacts": 30, "maxTokens": 1500 },
     "safety": { "toolErrorThreshold": 5, "goodAfterMinutes": 10 },
     "extensions": {}
   }
   ```

   `worker` and `consolidation` default to the CoS model. You can also change settings later by asking the CoS.

2. Supply the provider's API key, in either of two places:
   - an environment variable in the daemon's environment, for example `export ANTHROPIC_API_KEY=...`;
   - the file `~/.japa/secrets/<provider>.apiKey`, holding only the key (no trailing newline), mode 600:

     ```sh
     mkdir -p -m 700 ~/.japa/secrets
     (umask 077; printf %s "$KEY" > ~/.japa/secrets/anthropic.apiKey)
     ```

   If the key is missing, `japa daemon` prints `models: No API key for <provider>. ...` at startup.

## Running

```sh
japa daemon     # terminal 1: runs japa in the foreground (Ctrl-C stops it)
japa chat       # terminal 2: chat with the CoS
```

In `japa chat`: Enter sends (while the CoS is replying, it steers the reply); Esc stops the current reply;
Ctrl-C quits the chat (the daemon keeps running). When an extension asks for a secret, a masked prompt replaces
the editor; Enter submits it and Esc dismisses it.

Other commands:

| Command | What it does |
| --- | --- |
| `japa status` | The CoS model, installed extensions, and errors (needs the daemon) |
| `japa check <skill\|worker\|extension> <name>` | Checks a skill, worker profile or extension in the current directory (the CoS runs this in `~/.japa/.staging`) |
| `japa rollback <skill\|worker\|extension> <name> [to]` | Rolls it back to its last known good version, or to the git ref `to`; restart the daemon to apply |
| `japa safe-mode [--default-adapters]` | Restores the last working extensions, skills and workers, and optionally the default storage and secrets adapters |

japa enters safe mode by itself after three crashes within five minutes. A setup that has run for
`safety.goodAfterMinutes` is tagged as the last known good one.

## Where state lives

Everything lives in `~/.japa`, or in `$JAPA_HOME` when set. It is a git repository:

```
settings.json        your settings
extensions/          extensions the CoS installed      (git-tracked)
skills/              skills the CoS installed          (git-tracked)
workers/             worker profiles the CoS installed (git-tracked)
.staging/            git worktree (branch `staging`) where the CoS builds things before installing them
secrets/             secrets, one file per secret      (ignored by git)
state.db             conversations, jobs, memory, change log (SQLite; ignored by git)
japa.sock            the socket `japa chat` and `japa status` connect to
boots.json, daemon.lock, .cache/, node_modules/   runtime files
```

The tag `japa-lkg` marks the last known good commit. `git log` in `~/.japa` shows every install and rollback.

## Extending

Ask the CoS: "when I say standup, draft my standup from my notes", or "add a tool that ...". It picks a mechanism
(skill, worker profile or extension), builds it in a background job, checks it, installs it and tells you how to
use it; "undo that" reverts it. The procedures it follows are in `skills/`:
`choosing-a-mechanism`, `building-skills`, `building-workers`, `building-extensions` and `reporting-changes`.
Extensions import only from `japa/sdk` (`src/sdk.ts`); the packaged ones in `extensions/` are examples.

## Development

```sh
npm test            # vitest
npm run typecheck   # tsc --noEmit
```

Set `JAPA_HOME` to a scratch directory to run a throwaway daemon.
