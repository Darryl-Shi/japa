# japa

japa is a personal chief of staff: a long-running AI agent (the "CoS") you chat with, which delegates work to
background jobs, remembers what matters, and runs reminders and schedules. It extends itself: it writes new skills,
worker profiles and extensions into its own git-tracked workspace, checks and installs them, and rolls them back
when they break.

## Requirements

- git, tar, and curl or wget (the installer uses them; Node.js 24 is installed for you if your system doesn't have it)
- An account with a model provider supported by pi-ai (Anthropic, OpenAI, Google, OpenRouter, ...): a subscription
  you can sign in with (Claude Pro/Max, ChatGPT, GitHub Copilot, ...) or an API key

## Install

```sh
curl -fsSL https://raw.githubusercontent.com/Darryl-Shi/japa/main/install.sh | sh
```

This clones japa into `~/.local/share/japa/app`, downloads a private Node.js if your system doesn't have Node 24 or
newer (with npm), puts a `japa` launcher in `~/.local/bin`, and runs `japa setup` (see First run below). If
`~/.local/bin` isn't on your PATH yet, it adds it in your shell's rc file (`~/.bashrc`, `~/.zshrc` or
`~/.config/fish/config.fish`, from `$SHELL`) and prints "open a new shell or run: export PATH=...". Setup needs a
terminal: without one (e.g. in CI) the installer skips it and tells you to run `japa setup` to finish.
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
| `--non-interactive` | | off | Install but don't run `japa setup`; for scripted installs, see Non-interactive setup |
| `--no-service` | | off | Passed to `japa setup`: don't install or start the background service |
| `--skip-setup` | | off | Install but don't run `japa setup` |

If a step fails, or you press Ctrl-C, the installer names the step and removes the `app/` and `node/` it created.
It never touches `~/.japa`, refuses a `--dir` whose `app/` isn't a japa checkout (changing nothing), and never
replaces or removes a `node/` it didn't install itself.

Running the same command again later upgrades an existing install (writing the launcher first if it's missing or
points at another install) — see Updating.

### Install from a checkout

For development, or to manage the checkout yourself:

```sh
git clone <this repo> japa && cd japa
npm install
npm link        # puts `japa` on your PATH
```

`japa update` works here too, in place of a manual `git pull`, and the background service runs this checkout (see
Service).

## First run

The installer runs the setup wizard for you when it has a terminal. Run it again any time — to finish a setup you
skipped, or to change models, keys, extensions or the service later:

```sh
japa setup
```

The first run walks through, in order:

1. **Provider.** Pick the AI provider japa runs on; type to search the list.
2. **Connect.** Sign in with your subscription where the provider offers it (Claude Pro/Max, ChatGPT, GitHub
   Copilot, ...), or enter an API key — the same login flows pi uses. Sign-in shows a link (and opens it when this
   machine has a browser); over SSH, open it on your own machine and paste the final redirect URL or code back
   into the prompt. If the provider's key is already set in your shell (e.g. `ANTHROPIC_API_KEY`), setup offers
   to save it, since a background service doesn't see your shell's environment. Credentials are stored in
   `~/.japa/secrets` (mode 600): an API key as `<provider>.apiKey` (just the key — you can also write this file
   yourself), a sign-in as `<provider>.credential`, which japa refreshes as needed.
3. **Model.** Pick the model; background jobs and memory upkeep use it too unless you say no and pick others.
4. **Integrations.** Only those that need something from you — a Telegram bot token, a Parallel or Brave Search
   key, a Google sign-in (see Google) — are listed: pick any to set up now (none by default), or later here or in
   Telegram's `/settings`; until then japa doesn't see them. Anything with a default isn't asked about at all (the
   desktop just works, see Desktop); change it later by asking the CoS.
5. **Background service.** Installs and starts `japa service` (see Running), so japa keeps running after you log
   out — no question asked; pass `--no-service` to skip it. Setup then waits for japa to answer and prints
   `japa status`; without a service manager it tells you to run `japa daemon`.

A rerun shows a menu (Model and sign-in, Integrations, Background service, Done) instead, with every current
value preselected; Enter keeps it. When you're done, if anything was saved and the service is running, it restarts
it.

The wizard covers models, sign-in, integrations and the service. Other settings — `jobs.*`,
`context.toolResultTokens`, `memory.*`, `safety.*`, `storage.adapter`, `secrets.adapter` — aren't in it; edit
`~/.japa/settings.json` directly, use Telegram's `/settings`, or ask the CoS. `jobs.keepFinishedDays` (default `7`)
is how many days finished jobs stay listed before they're cleared.

An extension that needs a secret or a required setting stays hidden from japa — the CoS and its jobs don't know it
exists — until it's set up, with `japa setup` or `/settings` → Extensions. `extensions.<name>.enabled: false` hides
one the same way (`/settings` → Extensions → Turn off).

You can switch to a browser or another window at any point; setup waits. Ctrl-C asks whether to quit (Enter keeps
going, a second Ctrl-C quits); steps already completed stay saved.

### Non-interactive setup

For scripted installs (CI, provisioning), install without setup, then run `japa setup --non-interactive` with the
variables below set (add `--no-service` if you don't want the background service). `japa` may not be on the PATH
of the shell that installed it yet, hence the full path:

```sh
curl -fsSL https://raw.githubusercontent.com/Darryl-Shi/japa/main/install.sh | sh -s -- --non-interactive
JAPA_PROVIDER=anthropic JAPA_MODEL=<model id> JAPA_API_KEY=<key> ~/.local/bin/japa setup --non-interactive
```

| Variable | What it does |
| --- | --- |
| `JAPA_PROVIDER` | The CoS model's provider, e.g. `anthropic` |
| `JAPA_MODEL` | The CoS model's id |
| `JAPA_API_KEY` | Its API key (read only together with the two above) — stored the same way as the interactive prompt |

This sets `models.cos` and the key, installs the background service unless `--no-service`, and skips extensions.
`japa setup` without a terminal (no tty) behaves the same way, with or without the flag. It exits with an error
naming what's missing if `models.cos` is still unset afterwards.

## Running

If the background service is running (the default after `japa setup`), japa is already answering:

```sh
japa chat
```

Otherwise — you used `--no-service`, or are on Linux without a systemd
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
It runs the `japa` launcher or, when the launcher doesn't run this checkout (one you `npm link`ed, say), this
checkout's `src/cli/main.ts` directly on the Node you installed the service with; either way with the PATH (and
`JAPA_HOME`, if set) of the shell you installed it from.

| Subcommand | What it does |
| --- | --- |
| `install` | Write and enable the unit/agent, then start it (while `japa daemon` runs in the foreground it's written and enabled but not started, with an error telling you to stop the foreground daemon) |
| `uninstall` | Stop and remove it |
| `start`, `stop`, `restart` | Control it (`start` is refused while `japa daemon` runs in the foreground) |
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
failure it rolls back to the commit you were on and says why (the step and, for a command that failed, the command
and the end of its error output). It then lists what's new since your last update — new extensions, and new secrets
or settings in existing ones — and, in a terminal, offers to configure them (the same step `japa setup` runs). Last,
it restarts the service if it's running (a service you stopped stays stopped), or tells you to restart
`japa daemon` yourself.

| Flag | What it does |
| --- | --- |
| `--check` | List incoming commits without changing anything |
| `--branch <name>` | Update to a different branch instead of the one you're on |
| `--to <sha>` | Move to a specific commit instead of the branch tip — forward or back, e.g. to undo a bad update |
| `--no-restart` | Update the files but leave the running service alone |

Re-running `install.sh` does the same thing: it detects an existing install and runs `japa update` instead of
cloning again (writing the launcher first if it's missing or points at another install). Your `~/.japa` data —
settings, secrets, extensions, skills, workers — is never touched by an update, except to record which extensions
it has told you about.

### Uninstall

```sh
japa uninstall
```

Stops and removes the service and the `japa` launcher (if it runs this install), and removes the install
directory's `app/` and the private Node.js japa installed, then the directory itself once it's empty (a checkout you
cloned and linked yourself is left in place). Your data stays in `~/.japa`; the command prints where. Add `--purge`
to delete that too, once you type `delete` to confirm. The PATH line `install.sh` added to your shell's rc file is
left as it is; the command names the file.

## Telegram

1. Create a bot with [@BotFather](https://t.me/BotFather) (`/newbot`) and copy its token.
2. Run `japa setup` and paste the token under Integrations → Telegram.
3. Message your bot; it answers with your Telegram user id. Tell the CoS, which sets
   `extensions.telegram.owner`. Anyone else just gets their own user id back.

Then chat with the CoS from Telegram: replies to your messages and proactive ones (schedules, job
reports) come to you there. `/jobs` lists jobs, active ones first, with counts and ages; each opens its
brief and its progress, result, question or reason, and `Clear finished` clears the finished ones (they
go by themselves after `jobs.keepFinishedDays`). `/status` shows the model, extensions (and which aren't
on) and errors. `/settings` sets models, extensions (secrets, settings, on/off, rollback), schedules
(pause, resume, remove) and general settings, and undoes recent changes; a value you type there goes to
the menu, not the CoS, and a secret is deleted at once (a prompt left 10 minutes expires; your next
message goes to the CoS again). Photos and image files are saved under
`~/.japa/attachments/` and handed to the CoS. When japa needs a secret, it asks in the chat: send it as
your next message, and the bot deletes the message at once.

## Desktop

japa has its own computer: a Linux desktop with Chromium in a Docker container, which operator jobs use to get
things done on websites and in programs. There's nothing to set up: when japa starts, it builds the desktop's image
(a few minutes, the first time) and starts it in the background, so it's ready when first needed. It needs Docker,
installed and usable by the user running japa (on Linux: `sudo usermod -aG docker $USER`, then log in again);
`japa status` shows the desktop's line under the `desktop` extension, including what's wrong if it can't start.

- **Watch or take over** in noVNC: `ssh -L 6080:localhost:6080 <server>`, then open
  `http://localhost:6080/vnc.html`; or set `extensions.desktop.bind` to a Tailscale address. The password is in
  `~/.japa/secrets/desktop.vncPassword`.
- **Files** are exchanged in `~/.japa/desktop/shared` (`/home/japa/shared` on the desktop).
- **Settings** (`extensions.desktop`), all optional: `cpus` (default `2`), `memory` (`"4g"`), `shm` (`"2g"`),
  `bind` (`"127.0.0.1"`) and `autostart` (`true`; `false` builds and starts it on first use instead). A change recreates the container on the next use and keeps its home (`/home/japa`, with the
  browser's logins; those from the last ~30 s before a stop, recreate or reboot may be lost, as Chromium commits
  cookies every ~30 s).

## Google

japa can work with one Google account — Gmail, Drive, Calendar, Contacts and Tasks, reading and writing. Google
doesn't let a shared app have this much access without a paid security review, so you make your own (free) OAuth
client in Google Cloud Console and give japa its id and secret. It takes about ten minutes, once:

1. **Create a project** at [console.cloud.google.com/projectcreate](https://console.cloud.google.com/projectcreate)
   (any name, e.g. "japa").
2. **Enable the APIs.** In the [API Library](https://console.cloud.google.com/apis/library), search for and enable
   each of: **Gmail API**, **Google Drive API**, **Google Calendar API**, **People API** (contacts) and **Google
   Tasks API**.
3. **Set up the consent screen** at [Google Auth Platform](https://console.cloud.google.com/auth/overview): click
   Get started, give it a name and your email, and pick the audience:
   - **External** (any Google account, e.g. @gmail.com). Leave it in **Testing** and, under Audience, add your own
     address as a **test user**. In Testing, the sign-in stops working after **7 days**: the next time japa uses
     Google, `japa status` shows `sign-in expired — ask japa to reconnect`, and you connect again (below).
     Publishing the app avoids this, but Google then wants it verified.
   - **Internal**, if your account is in a Google Workspace organization you administer: no test users and no
     7-day limit.
4. **Create the client** under [Clients](https://console.cloud.google.com/auth/clients): Create client, type
   **Desktop app**. Copy its **client ID** and **client secret**.
5. **Connect.** Either run `japa setup`, choose Integrations → google, paste the id and secret, and sign in when it
   asks; or set the id and secret in Telegram's `/settings` → Extensions → google (japa doesn't see google until
   they're set), then tell japa "connect my Google account" in `japa chat` or Telegram and open the link it sends.

Signing in opens Google's consent page. In Testing, Google first shows a "Google hasn't verified this app" screen:
that's your own app, so choose **Continue**. Allow everything it asks (japa's access is fixed: mail, Drive,
calendar, contacts and tasks). On the machine running japa, the browser comes back to japa by itself. Anywhere else — over
SSH, or from your phone — the page it lands on after you approve fails to load: that's expected. Copy that page's
full address from the address bar and paste it where japa asks: at the prompt in `japa setup`, at the masked
prompt in `japa chat`, or as your next message in Telegram (the bot deletes it at once).
`japa status` shows `connected as you@gmail.com` under `google` once it's done.

Then ask for things like "what came in from my accountant this week?", "reply to Dana that Thursday works", "find
the Q3 budget doc and summarize it", "schedule 30 minutes with Dana next Tuesday", "what's Bob's phone number?" or
"add 'renew passport' to my tasks for Friday". japa checks with you before it sends mail, deletes, trashes or
shares anything you didn't ask for in so many words; creating, changing or deleting a calendar event emails its
guests. Attachments and downloaded files are saved under `~/.japa/attachments/google/`. Only one Google account is
supported; to switch accounts, connect again and sign in as the other one.

## Where state lives

The code — japa's git checkout, and a private Node.js if one was installed — lives under the install directory,
`~/.local/share/japa` by default (`$JAPA_INSTALL_DIR`, or `--dir` at install time):

```
app/      git checkout of japa (the branch you installed, `main` by default)
node/     a private Node.js, only if your system's was missing, older than 24, or without npm
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
attachments/         images received over Telegram, files from Google (ignored by git)
desktop/shared/      files shared with japa's desktop  (ignored by git)
logs/                service log, macOS only           (ignored by git)
setup.json           extensions `japa setup` and `japa update` have already told you about (ignored by git)
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
