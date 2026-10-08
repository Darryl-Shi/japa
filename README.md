# japa

japa is a personal chief of staff: a long-running AI agent (the "CoS") you chat with, which delegates work to
background jobs, remembers what matters, and runs reminders and schedules. It extends itself: it writes new skills,
worker profiles and extensions into its own git-tracked workspace, checks and installs them, and rolls them back
when they break.

## Requirements

- git, tar, and curl or wget (the installer uses them; Node.js 24 is installed for you if your system doesn't have it)
- An API key for a model provider supported by pi-ai (Anthropic, OpenAI, Google, OpenRouter, ...)

## Install

```sh
curl -fsSL https://raw.githubusercontent.com/Darryl-Shi/japa/main/install.sh | sh
```

This clones japa into `~/.local/share/japa/app`, downloads a private Node.js if your system doesn't have Node 24 or
newer, puts a `japa` launcher on your PATH (`~/.local/bin/japa`), and runs `japa setup` (see First run below).
Supports Linux and macOS, x64 or arm64 (WSL counts as Linux); needs `git`, `tar`, and `curl` or `wget` — a missing
one is named, along with how to install it.

To pass flags through the pipe, use `sh -s --`:

```sh
curl -fsSL https://raw.githubusercontent.com/Darryl-Shi/japa/main/install.sh | sh -s -- --dir ~/apps/japa
```

| Flag | Env | Default | What it does |
| --- | --- | --- | --- |
| `--dir <path>` | `JAPA_INSTALL_DIR` | `~/.local/share/japa` | Where to install japa |
| `--branch <name>` | `JAPA_BRANCH` | `main` | git branch to install |
| `--repo <url>` | `JAPA_REPO` | `https://github.com/Darryl-Shi/japa.git` | git repo to clone |
| `--non-interactive` | | off | Don't run `japa setup`'s prompts (for scripted installs; see Non-interactive setup) |
| `--no-service` | | off | Don't install or start the background service |
| `--skip-setup` | | off | Install but don't run `japa setup` at all |

Running the same command again later upgrades an existing install — see Updating.

### Install from a checkout

For development, or to manage the checkout yourself:

```sh
git clone <this repo> japa && cd japa
npm install
npm link        # puts `japa` on your PATH
```

`japa update` works here too, in place of a manual `git pull`.

## First run

The installer runs the setup wizard for you. Run it again any time — to finish a setup you skipped, or to change
models, keys, extensions or the service later:

```sh
japa setup
```

The first run walks through, in order:

1. **Model.** Pick a provider and model for the CoS (the main agent). Workers and memory consolidation default to
   the same model; say no to pick different ones for them.
2. **API key.** Pasted into a masked prompt and stored, trimmed, in `~/.japa/secrets/<provider>.apiKey` (mode 600)
   — or set it yourself, as an environment variable (e.g. `ANTHROPIC_API_KEY`) in the service's environment, or by
   writing that file directly (just the key, no trailing newline). If the environment variable is already set in
   your shell, japa still offers to store it: a background service doesn't see your shell's environment.
3. **Extensions.** Anything that declares secrets or settings — Telegram, web search, the desktop, extensions the
   CoS built for you — can be configured here, or later by asking the CoS.
4. **Service.** Optionally installs and starts `japa service` (see Running), so japa keeps running after you log
   out.

A rerun shows a menu (Models, Extensions, Service, Done) instead, with every current value preselected; Enter keeps
it. If you changed anything and the service is running, it offers to restart it.

The wizard covers models, keys, extensions and the service. Other settings — `jobs.maxConcurrent`,
`context.toolResultTokens`, `memory.*`, `safety.*`, `storage.adapter`, `secrets.adapter` — aren't in it; edit
`~/.japa/settings.json` directly, or ask the CoS.

Esc or Ctrl-C cancels the current step without saving; steps already completed stay saved.

### Non-interactive setup

For scripted installs (CI, provisioning), set these and add `--non-interactive` to `install.sh` or `japa setup`
(and `--no-service` too, if you don't want the background service):

| Variable | What it does |
| --- | --- |
| `JAPA_PROVIDER` | The CoS model's provider, e.g. `anthropic` |
| `JAPA_MODEL` | The CoS model's id |
| `JAPA_API_KEY` | Its API key — stored the same way as the interactive prompt |

Extensions aren't configured this way. `japa setup --non-interactive` exits with an error naming what's missing if
`models.cos` is still unset afterwards.

## Running

If the background service is running (the default after `japa setup`), japa is already answering:

```sh
japa chat
```

Otherwise — you skipped or declined the service step, used `--no-service`, or are on Linux without a systemd
user session (common on WSL) — run the daemon yourself:

```sh
japa daemon     # terminal 1: runs japa in the foreground (Ctrl-C stops it)
japa chat       # terminal 2: chat with the CoS
```

In `japa chat`: Enter sends (while the CoS is replying, it steers the reply); Esc stops the current reply;
Ctrl-C quits the chat (the daemon keeps running). When an extension asks for a secret, a masked prompt replaces
the editor; Enter submits it and Esc dismisses it.

### Service

`japa service <subcommand>` manages the background service — a systemd user unit on Linux, a launchd agent on
macOS — so japa keeps running after you log out. `japa setup` offers to install it; this is the same thing by hand.

| Subcommand | What it does |
| --- | --- |
| `install` | Write and enable the unit/agent, then start it |
| `uninstall` | Stop and remove it |
| `start`, `stop`, `restart` | Control it |
| `status` | The service manager's state, then `japa status` if the socket answers |
| `logs` | Tail its log (`journalctl --user -u japa -f` on Linux, `~/.japa/logs/daemon.log` on macOS) |

Needs a systemd user session on Linux (`systemctl --user`); on WSL, add `systemd=true` under `[boot]` in
`/etc/wsl.conf` and run `wsl --shutdown` to turn it on. Without it, `japa service install` explains why instead of
failing, and you run `japa daemon` yourself.

Other commands:

| Command | What it does |
| --- | --- |
| `japa status` | The CoS model, installed extensions, and errors (needs japa running, as a service or in the foreground) |
| `japa setup [--non-interactive] [--no-service]` | Configure models, keys, extensions and the service; rerun any time to change settings |
| `japa service <install\|uninstall\|start\|stop\|restart\|status\|logs>` | Manage the background service, see Service above |
| `japa update [--check] [--branch <b>] [--to <sha>] [--no-restart]` | Upgrade japa, see Updating |
| `japa uninstall [--purge]` | Remove japa, see Updating |
| `japa check <skill\|worker\|extension> <name>` | Checks a skill, worker profile or extension in the current directory (the CoS runs this in `~/.japa/.staging`) |
| `japa rollback <skill\|worker\|extension> <name> [to]` | Rolls it back to its last known good version, or to the git ref `to`; restart the daemon to apply |
| `japa safe-mode [--default-adapters]` | Restores the last working extensions, skills and workers, and optionally the default storage and secrets adapters |
| `japa --version` | Print the installed version and git commit |

japa enters safe mode by itself after three crashes within five minutes. A setup that has run for
`safety.goodAfterMinutes` is tagged as the last known good one.

## Updating

```sh
japa update
```

Fetches the branch you're on (`main` by default) and fast-forwards your checkout to it. Local edits in the
checkout are stashed first and restored after; a history that has diverged (local commits that aren't upstream)
is refused rather than guessed at, leaving your checkout unchanged. It reinstalls dependencies if they changed,
downloads a newer private Node.js if one is needed, and validates the result before doing anything else; on
failure it rolls back to the commit you were on and says why. It then restarts the service (or tells you to
restart `japa daemon` yourself) and lists any new extension secrets or settings since your last update, the same
step `japa setup` runs.

| Flag | What it does |
| --- | --- |
| `--check` | List incoming commits without changing anything |
| `--branch <name>` | Update to a different branch instead of the one you're on |
| `--to <sha>` | Move to a specific commit instead of the branch tip — forward or back, e.g. to undo a bad update |
| `--no-restart` | Update the files but leave the running service alone |

Re-running `install.sh` does the same thing: it detects an existing install and runs `japa update` instead of
cloning again. Your `~/.japa` data — settings, secrets, extensions, skills, workers — is never touched by an
update, except to record which extensions it has offered to configure.

### Uninstall

```sh
japa uninstall
```

Stops and removes the service and the `japa` launcher, and removes the install directory (a checkout you cloned
and linked yourself is left in place). Your data stays in `~/.japa`; the command prints where. Add `--purge` to
delete that too, once you type `delete` to confirm. PATH lines `install.sh` added to your shell's rc file are left
as they are.

## Telegram

1. Create a bot with [@BotFather](https://t.me/BotFather) (`/newbot`) and copy its token.
2. In `japa chat`, ask the CoS to connect Telegram, and paste the token at the masked prompt.
3. Message your bot; it answers with your Telegram user id. Tell the CoS, which sets
   `extensions.telegram.owner`. Anyone else just gets their own user id back.

Then chat with the CoS from Telegram: replies to your messages and proactive ones (schedules, job
reports) come to you there. `/jobs` lists jobs, `/status` shows the model, extensions and errors, and
`/settings` opens a menu for models, schedules and extension rollbacks. Photos and image files are
saved under `~/.japa/attachments/` and handed to the CoS. When japa needs a secret, it asks in the
chat: send it as your next message, and the bot deletes the message at once.

## Desktop

japa has its own computer: a Linux desktop with Chromium in a Docker container, which operator jobs use to get
things done on websites and in programs. It needs Docker, installed and usable by the user running japa. The first
use builds the image (a few minutes); `japa status` shows the desktop's line under the `desktop` extension.

- **Watch or take over** in noVNC: `ssh -L 6080:localhost:6080 <server>`, then open
  `http://localhost:6080/vnc.html`; or set `extensions.desktop.bind` to a Tailscale address. The password is in
  `~/.japa/secrets/desktop.vncPassword`.
- **Files** are exchanged in `~/.japa/desktop/shared` (`/home/japa/shared` on the desktop).
- **Settings** (`extensions.desktop`): `cpus` (default `2`), `memory` (`"4g"`), `shm` (`"2g"`) and `bind`
  (`"127.0.0.1"`). A change recreates the container on the next use and keeps its home (`/home/japa`, with the
  browser's logins; those from the last ~30 s before a stop, recreate or reboot may be lost, as Chromium commits
  cookies every ~30 s).

## Where state lives

The code — japa's git checkout, and a private Node.js if one was installed — lives under the install directory,
`~/.local/share/japa` by default (`$JAPA_INSTALL_DIR`, or `--dir` at install time):

```
app/      git checkout of japa (the branch you installed, `main` by default)
node/     a private Node.js, only if your system's was missing or older than 24
```

The `japa` launcher (`~/.local/bin/japa`) is a small shell script with an absolute path to that Node and that
checkout baked in, so it and the service work without your shell's PATH or nvm setup.

Everything japa *does* lives in `~/.japa`, or in `$JAPA_HOME` when set. It is a git repository:

```
settings.json        your settings
extensions/          extensions the CoS installed      (git-tracked)
skills/              skills the CoS installed          (git-tracked)
workers/             worker profiles the CoS installed (git-tracked)
.staging/            git worktree (branch `staging`) where the CoS builds things before installing them
secrets/             secrets, one file per secret      (ignored by git)
attachments/         images received over Telegram     (ignored by git)
desktop/shared/      files shared with japa's desktop  (ignored by git)
logs/                service log, macOS only           (ignored by git)
setup.json           extensions the setup wizard has already offered (ignored by git)
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
JAPA_DOCKER_TESTS=1 npx vitest --run test/desktop-docker.test.ts   # the desktop on Docker (builds its image)
```

Set `JAPA_HOME` to a scratch directory to run a throwaway daemon.
