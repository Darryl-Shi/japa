# japa

japa is a personal chief of staff: a long-running AI agent (the "CoS") you chat with, which delegates work to
background jobs, remembers what matters, and runs reminders and schedules. It extends itself: its jobs write new skills
and extensions into a private copy of its git-tracked workspace, and those that pass their checks are merged in
when the job finishes; it rolls them back when they break.

## Requirements

- Linux on x64 or arm64 (WSL works for a native install), and curl or wget
- For a **Docker install** (the default): Docker, usable by your user (`docker info` works; on Linux:
  `sudo usermod -aG docker $USER`, then log in again), and the [Sysbox](https://github.com/nestybox/sysbox) runtime —
  the installer offers to install it for you on Ubuntu or Debian. Everything else is inside the container.
- For a **native install**: git and tar (Node.js 24 is installed for you if your system doesn't have it), and
  bubblewrap, which sandboxes jobs (`sudo apt install bubblewrap`)
- An account with a model provider supported by pi-ai (Anthropic, OpenAI, Google, OpenRouter, ...): a subscription
  you can sign in with (Claude Pro/Max, ChatGPT, GitHub Copilot, ...) or an API key

## Install

```sh
curl -fsSL https://raw.githubusercontent.com/Darryl-Shi/japa/main/install.sh | sh
```

In a terminal, the installer first shows a menu naming the install directory (marked `installed` when japa is
already there):

```
==> japa installer (~/.local/share/japa)
  1) Install
  2) Update
  3) Uninstall
  4) Quit
Choose [1]:
```

- **Install** installs japa fresh, in the mode described next. It's the default (Enter) when japa isn't installed there.
- **Update** upgrades the existing install in its own mode (`japa update` for a native one; see Updating). It's the
  default when japa is already installed — natively at the install directory, or as the Docker instance of that name
  (the header then names the instance).
- **Uninstall** removes the native install at the install directory, after asking (see Uninstall). A Docker
  instance is removed with `japa --instance <name> uninstall`.
- **Quit**, or closing input, exits without changing anything.

A choice that doesn't fit — Install when japa is already installed, Update when it isn't, Uninstall when nothing of japa's is there — says so and
shows the menu again; so does any other input. Without a terminal (e.g. in CI), or with `--non-interactive`, there's
no menu: the installer installs fresh, or updates an existing install, and never uninstalls.

One installer, two modes. After you choose Install in a terminal it asks "Install japa via Docker (recommended) or
natively?"; Enter picks Docker, and so does an install without a terminal. Pass `--mode docker` or `--mode native`
to skip the question. Re-running it over an existing install upgrades that install in its own mode without asking: a
native one if `<dir>/app` is a checkout, else a Docker instance of that name if there is one.

- **Docker** runs japa in its own [Sysbox](https://github.com/nestybox/sysbox) system container — a small Linux
  machine with systemd, its own Docker and working bubblewrap — where it is installed and runs exactly as a native
  install does (same code, service, updates, job sandbox and desktop). Its state is in named Docker volumes; on the
  host there's only the container, its volumes and network, and a `japa` launcher. Several instances (one per
  tenant, say) can run side by side. See Docker install below.
- **Native** installs japa straight into your home directory, as described next.

### Native install

```sh
curl -fsSL https://raw.githubusercontent.com/Darryl-Shi/japa/main/install.sh | sh -s -- --mode native
```

Install clones japa into `~/.local/share/japa/app`, downloads a private Node.js if your system doesn't have Node 24 or
newer (with npm), puts a `japa` launcher in `~/.local/bin`, and runs `japa setup` (see First run below). If
`~/.local/bin` isn't on your PATH yet, it adds it in your shell's rc file (`~/.bashrc`, `~/.zshrc` or
`~/.config/fish/config.fish`, from `$SHELL`) and prints "open a new shell or run: export PATH=...". That covers
interactive shells only: a one-off `ssh <server> 'japa …'` runs a non-interactive shell, which (on Debian and Ubuntu)
stops reading `~/.bashrc` before that line, so use the full path there: `ssh <server> '~/.local/bin/japa …'`. Setup needs a
terminal: without one (e.g. in CI) the installer skips it and tells you to run `japa setup` to finish.
Runs on Linux only, x64 or arm64 (WSL works); needs `git`, `tar`, and `curl` or `wget` — a missing
one is named, along with how to install it. Jobs also need bubblewrap (`sudo apt install bubblewrap`): `japa setup`
checks that it works and, if not, says how to install it.

If a step fails, or you press Ctrl-C, the installer names the step and removes the `app/` and `node/` it created.
It never touches `~/.japa`, refuses a `--dir` whose `app/` isn't a japa checkout (changing nothing), and never
replaces or removes a `node/` it didn't install itself.

Running the same command again later and choosing Update (the default then) upgrades an existing install (writing
the launcher first if it's missing or points at another install) — see Updating.

### Docker install

```sh
curl -fsSL https://raw.githubusercontent.com/Darryl-Shi/japa/main/install.sh | sh -s -- --mode docker --instance alice
```

The installer first checks that Docker works for you and that the Sysbox runtime (`sysbox-runc`) is registered with
it. If Sysbox is missing on Ubuntu or Debian, it offers to install it (Sysbox 0.7.1's `.deb`, checksum-verified,
with `sudo apt-get install`) and warns that this **restarts Docker, briefly stopping running containers**; Enter
means yes. Without a terminal it installs Sysbox only with `--install-sysbox`. Otherwise (another distro, you said
no, or the install failed) it points at Sysbox's install docs and, in a terminal, offers a native install instead;
without one it exits non-zero. Never `--privileged`, and never the host's `docker.sock`.

A fresh install of instance `<name>` (default: your `$USER`, lower-cased, anything but `a-z0-9-` turned into `-`):

1. builds the image `japa-host:<branch>` from the repo's `docker/` directory at `--branch` (a git build context,
   so `--repo` must be a URL: `https://`, `git://`, `ssh://` or `git@`);
2. creates the network `japa-<name>-net` and the volumes `japa-<name>-home` and `japa-<name>-docker`, and starts the
   container `japa-<name>` with `--runtime=sysbox-runc` and `--restart unless-stopped` (so it comes back after a
   reboot), publishing only the desktop on `127.0.0.1:<port>` and the web UI on `127.0.0.1:<web UI port>` (or
   `--webui-bind`'s address); then waits for its systemd to boot;
3. installs japa inside as user `japa` with this same installer's native mode (`--mode native --skip-setup`, same
   `--repo` and `--branch`): the checkout, `npm ci` and the inner launcher;
4. writes the host launcher `~/.local/bin/japa` (and the PATH line, as for a native install; see Running → Docker instances);
5. runs `japa --instance <name> setup`, which runs the setup wizard inside the container and installs the
   background service there. Without a terminal, or with `--skip-setup` or `--non-interactive`, it prints
   ``run `japa --instance <name> setup` to finish`` instead.

It refuses a name already used by a container that isn't a japa instance. If a step before setup fails, or you
press Ctrl-C, it names the step and removes the container, volumes, network and launcher this run created —
nothing that existed before.

Re-running the installer for an existing instance (`--instance <name>`, or the default) upgrades it: it rebuilds
`japa-host:<branch>` and, if the image, branch, `--desktop-port`, `--webui-port` or `--webui-bind` changed (or the
instance predates the web UI's publish), recreates `japa-<name>` with the same name, volumes, network, labels and
ports — the volumes and everything in them are kept — rewrites the host launcher with the current one, then runs
`japa update` inside, as a native re-run does. It stays on the instance's branch unless you pass `--branch`. It also brings back an
instance removed with `japa uninstall` (its volumes were kept).

Run it again with `--mode docker --instance <another name>` for each further instance (one per tenant, say): each
has its own container, volumes, network, settings, secrets, models, Telegram bot, desktop and web UI ports, and can't reach
the others' ports. The one host launcher serves them all.

Native and Docker installs can share a machine, but only one owns `~/.local/bin/japa`. A Docker install over a
native launcher asks whether to replace it (Enter: no); kept, the Docker launcher is `~/.local/bin/japa-docker`.
Likewise a native install over the Docker launcher asks (Enter: no) and otherwise writes `~/.local/bin/japa-native`.
Without a terminal the existing launcher is always kept. Use those names wherever this README says `japa`.

### Installer flags

To pass flags through the pipe, use `sh -s --`:

```sh
curl -fsSL https://raw.githubusercontent.com/Darryl-Shi/japa/main/install.sh | sh -s -- --dir ~/apps/japa
```

| Flag | Env | Default | What it does |
| --- | --- | --- | --- |
| `--mode <docker\|native>` | `JAPA_INSTALL_MODE` | `docker` (asked in a terminal) | How to install; an existing install keeps its mode |
| `--instance <name>` | `JAPA_INSTANCE` | `$USER` (sanitised) | Docker: instance to create or upgrade (`[a-z0-9][a-z0-9-]*`) |
| `--desktop-port <n>` | | first free from 6080 | Docker: host port (on `127.0.0.1`) for the instance's desktop; skips ports other instances claimed or something listens on |
| `--webui-port <n>` | | first free from 7337 | Docker: host port for the instance's web UI; skips ports other instances claimed (desktop or web UI) or something listens on |
| `--webui-bind <ipv4>` | | `127.0.0.1` | Docker: host address the web UI is published on, e.g. a LAN or VPN address, or `0.0.0.0` for all (plain HTTP: see Web UI) |
| `--install-sysbox` | | off | Docker: install Sysbox if missing without asking (needs sudo, restarts Docker) |
| `--dir <path>` | `JAPA_INSTALL_DIR` | `~/.local/share/japa` | Native: where to install japa (ignored in Docker mode, with a note) |
| `--branch <name>` | `JAPA_BRANCH` | `main` | git branch to install |
| `--repo <url>` | `JAPA_REPO` | `https://github.com/Darryl-Shi/japa.git` | git repo to clone (Docker mode: a URL only) |
| `--non-interactive` | | off | No menu, and don't run `japa setup`; for scripted installs, see Non-interactive setup |
| `--no-service` | | off | Passed to `japa setup` (inside the container, in Docker mode): don't install or start the background service |
| `--skip-setup` | | off | Install but don't run `japa setup` |

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
   key, a Google sign-in (see Google) — are listed: pick any to set up now (none by default), or later by running
   `japa setup` again (the search keys also from Telegram's `/settings` once it's connected); until then japa doesn't
   see them. Anything with a default isn't asked about at all (the desktop just works, see Desktop); change it later
   by asking the CoS.
5. **Background service.** Installs and starts `japa service` (see Running), so japa keeps running after you log
   out — no question asked; pass `--no-service` to skip it. Setup then waits for japa to answer and prints
   `japa status`; without a service manager it tells you to run `japa daemon`.

A rerun shows a menu (Model and sign-in, Integrations, Web UI, Background service, Done) instead, with every current
value preselected; Enter keeps it. When you're done, if anything was saved and the service is running, it restarts
it.

The wizard covers models, sign-in, integrations, the web UI (a rerun's Web UI section: on/off, listen address,
port and host names, each picked from guided choices) and the service. Other settings — `jobs.*`,
`context.toolResultTokens`, `memory.*`, `safety.*`, `storage.adapter`, `secrets.adapter` — aren't in it; edit
`~/.japa/settings.json` directly, use Telegram's `/settings`, or ask the CoS. `jobs.keepFinishedDays` (default `7`)
is how many days finished jobs stay listed before they're cleared; `jobs.thinking` (default `medium`) is how hard
jobs think unless the CoS picks otherwise for one.

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

In a Docker instance, the host launcher passes only `TERM`, `LANG` and `TZ` into the container, so set the variables
inside it, through `shell`:

```sh
curl -fsSL https://raw.githubusercontent.com/Darryl-Shi/japa/main/install.sh | sh -s -- --mode docker --instance alice --non-interactive
~/.local/bin/japa --instance alice shell -c 'JAPA_PROVIDER=anthropic JAPA_MODEL=<model id> JAPA_API_KEY=<key> japa setup --non-interactive'
```

This sets `models.cos` and the key, installs the background service unless `--no-service`, and skips extensions.
`japa setup` without a terminal (no tty) behaves the same way, with or without the flag. It exits with an error
naming what's missing if `models.cos` is still unset afterwards.

## Running

If the background service is running (the default after `japa setup`), japa is already answering:

```sh
japa chat
```

or open the web UI at http://127.0.0.1:7337 (see Web UI).

Otherwise — you used `--no-service`, or are on Linux without a systemd
user session (common on WSL) — run the daemon yourself:

```sh
japa daemon     # terminal 1: runs japa in the foreground (Ctrl-C stops it)
japa chat       # terminal 2: chat with the CoS
```

In `japa chat`: Enter sends (while the CoS is replying, it steers the reply); Esc stops the current reply;
Ctrl-C quits the chat (the daemon keeps running). When an extension asks for a secret, a masked prompt replaces
the editor; Enter submits it, Esc hides it (it comes back when the pending requests change), and Ctrl-X declines
the request, which tells the CoS you said no. Your messages (and those from other surfaces) show after `› `; a
job's report shows under `◆ job "<title>" <status>`, and japa's own notes (schedule wakes, secret notes) are muted
lines after `· `.

### Docker instances

With a Docker install, `~/.local/bin/japa` on the host is a small script that forwards each command into an
instance: `docker exec` as user `japa` (with a TTY when you're in a terminal) running the japa inside, with your
arguments, and exiting with its status. So `japa chat`, `setup`, `status`, `service ...`, `update`, `check`,
`rollback`, `safe-mode` and `--version` behave as they do natively, masked prompts and Ctrl-C included; `japa service`
manages the systemd user service inside the container.

Which instance a command goes to:

1. `--instance <name>` as the first argument (`japa --instance alice chat`);
2. else `JAPA_INSTANCE`;
3. else the only instance on the host;
4. else the instance named after `$USER`.

Otherwise it lists the instances and exits non-zero. A stopped instance is started first; one that doesn't exist
is reported along with the ones that do.

A few commands are the launcher's own and run on the host:

| Command | What it does |
| --- | --- |
| `japa instances` | Lists every instance: name, state (running or stopped), branch, japa version, desktop URL, web UI URL (`-` for an instance from before it was published: re-run the installer) |
| `japa [--instance n] shell [args]` | A login shell as `japa` inside the container (args go to `bash -l`, e.g. `-c '<command>'`): to inspect `~/.japa`, or to hand a tenant a shell |
| `japa [--instance n] uninstall [--purge]` | Removes the instance, see Uninstall |

The instance's desktop is at `http://127.0.0.1:<port>/vnc.html` on the host (`japa instances` shows the port); from
another machine, `ssh -L <port>:localhost:<port> <server>` first. Google sign-in (and any other sign-in) can't come
back to japa by itself from your browser, so use the paste-the-redirect fallback: copy the address of the page that
fails to load and paste it where japa asks, as over SSH (see Google).

Its web UI is at `http://127.0.0.1:<web UI port>` (`japa instances` shows it; see Web UI); create a user to sign in
with: `japa --instance <name> webui users add <user>` (it asks for the password in your terminal).

### Service

`japa service <subcommand>` manages the background service — a systemd user unit — so japa keeps running after you
log out. `japa setup` offers to install it; this is the same thing by hand.
It runs the `japa` launcher or, when the launcher doesn't run this checkout (one you `npm link`ed, say), this
checkout's `src/cli/main.ts` directly on the Node you installed the service with; either way with the PATH (and
`JAPA_HOME`, if set) of the shell you installed it from.

| Subcommand | What it does |
| --- | --- |
| `install` | Write and enable the unit, then start it (while `japa daemon` runs in the foreground it's written and enabled but not started, with an error telling you to stop the foreground daemon) |
| `uninstall` | Stop and remove it |
| `start`, `stop`, `restart` | Control it (`start` is refused while `japa daemon` runs in the foreground) |
| `status` | The service manager's state, then `japa status` if the socket answers |
| `logs` | Tail its log (`journalctl --user -u japa -f`) |

Needs a systemd user session (`systemctl --user`); on WSL, add `systemd=true` under `[boot]` in
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
| `japa check <skill\|extension> <name>` | Checks a skill or extension in the current directory (a job runs this in its copy of `~/.japa`, and japa runs it before the job's changes go live) |
| `japa rollback <skill\|extension> <name> [to]` | Rolls it back to its last known good version, or to the git ref `to`; restart the daemon to apply |
| `japa safe-mode [--default-adapters]` | Restores the last working extensions and skills, and optionally the default storage and secrets adapters |
| `japa webui users add <name> [--password-stdin]` | Creates a web UI user (asks for the password twice; `--password-stdin` reads it from stdin's first line, for scripts) |
| `japa webui users passwd <name> [--password-stdin]` | Sets a web UI user's password, signing that user out everywhere |
| `japa webui users remove <name>` | Deletes a web UI user, signing them out everywhere |
| `japa webui users list` | Lists the web UI users and when each was created |
| `japa --version` | Print the installed version and git commit |

japa enters safe mode by itself after three crashes within five minutes. A setup that has run for
`safety.goodAfterMinutes` is tagged as the last known good one.

## Web UI

japa also serves a chat app in your browser, on by default, at **http://127.0.0.1:7337**. It shows the same
conversation as `japa chat` and Telegram — messages from any of them, the CoS's replies streaming in, tool calls,
job reports (each a "Job report" card with the job's title, a status pill and the report, long ones folded behind
Show more), and japa's own notes such as schedule wakes as muted lines — plus a live Jobs panel, a Desktop panel, Settings and a card for pending secret requests. Enter sends (while
the CoS is replying, it steers the reply), Shift+Enter adds a line, Stop or Esc stops the reply. Any number of
tabs and devices can be open; they all stay in sync, and reconnect on their own after a restart.

- **Signing in**: with a web UI user's name and password. Create one on the machine running japa with
  `japa webui users add <name>` (it asks for the password twice; 8 to 1024 characters; names are 1–32 lower-case
  letters, digits, `.`, `_` or `-`), then sign in. `japa webui users list` lists them, `passwd <name>` changes a
  password and `remove <name>` deletes a user; both sign that user out everywhere at once. No daemon restart is
  needed, and none of it needs the daemon running. Every user sees the same conversation, jobs and status: users
  are separate logins, not separate workspaces. A session lasts 30 days and survives restarts; Sign out (top bar)
  signs out that browser. Ten failed sign-ins within a minute from one address block further tries for the rest
  of that minute. Deleting `~/.japa/secrets/webui.session-key` and restarting signs everyone out. Scripts can pipe
  the password: `echo '<password>' | japa webui users add <name> --password-stdin`. (The old access token,
  `~/.japa/secrets/webui.token`, is no longer used: you can delete it.)
- **From another machine**: tunnel it over SSH, `ssh -L 7337:localhost:7337 <server>`, then open
  `http://localhost:7337`; or, to reach it from your phone, set `extensions.webui.bind` to the server's Tailscale
  address and open `http://<tailscale address>:7337`.
- **Docker instances**: the installer publishes each instance's web UI on the host at `127.0.0.1:<web UI port>`
  (first free from 7337; `--webui-port` picks it, `japa instances` shows it); inside the container it stays on
  loopback. To reach it from other machines, re-run the installer with `--webui-bind <host address>` (a LAN or VPN
  address, or `0.0.0.0` for all) and open `http://<that address>:<web UI port>`. Create a user for it with
  `japa --instance <name> webui users add <user>`.
- **Host names**: it answers to `localhost`, `127.0.0.1`, its `bind` address and any IP address (e.g.
  `http://10.1.2.3:7337`), on any port, so tunnels and published ports work. A DNS name (say `japa.example.corp`)
  must be listed in `hosts`; anything else is refused, which stops DNS-rebinding attacks.
- **Plain HTTP**: there's no TLS. Passwords keep strangers out, but on a shared network anyone who can watch the
  traffic sees them, the session cookies and the conversation: expose it only on networks you trust (a VPN, Tailscale), or tunnel it.
- **Settings** (`extensions.webui`), all optional: `bind` (default `"127.0.0.1"`), `port` (`7337`), `hosts` (extra
  DNS names it answers to, e.g. `["japa.example.corp"]`; default none) and `enabled` (`false` turns it off). Change
  them with `japa setup` → Web UI (which shows the addresses to open and offers this machine, each LAN/Tailscale
  address, all addresses or another IP), in `~/.japa/settings.json`, with Telegram's `/settings` or by asking the CoS.
  A change takes effect when japa restarts (`japa setup` restarts a running service for you).
- `japa status` shows its address under `webui` and how many users there are (or `no users yet`, or that it can't
  read `~/.japa/webui/users.json`), or why it isn't running: `not built` (run `npm run build` in the
  checkout) or `can't listen on …` (e.g. the port is taken). Either way the rest of japa keeps running.

- **Files**: attach files with the paperclip, by dropping them anywhere on the chat page, or by pasting (e.g. a
  screenshot); they show as chips (images with a thumbnail) and a message can be files only. At most 10 files and
  50 MB in total per message. japa saves them under `~/.japa/attachments/<date>/` as it does Telegram's, reads PDFs'
  text and shows images to a vision model. Your messages show what you typed plus a chip per file (from Telegram
  too); click one to download it. A file the CoS sends you (`send_file`) shows as a card with its caption and a
  Download button (images get a preview; images and PDFs also Open in a new tab). Only images and PDFs ever open in
  the browser: everything else, HTML and SVG included, downloads. A file deleted on japa's host says so instead.

### Settings in the browser

The gear button opens **Settings**, japa's control panel for a running, set-up japa (first-run setup is still
`japa setup` in a terminal). It covers what a re-run of `japa setup` and Telegram's `/settings` and `/update` cover:

- **Overview**: the CoS model, any errors (each naming its extension) and how many extensions are on, off or not set
  up. (This replaces the old Status sheet; `japa status` and Telegram's `/status` still work.)
- **Models**: the CoS, Worker and Memory upkeep models (Worker and Memory default to the CoS's), picked from the
  connected providers, and the jobs' thinking level. A change applies to the next message, no restart needed.
- **Providers**: sign in (a link, a device code, or a field to paste the redirect URL/code when your browser isn't on
  japa's host) or enter an API key. Keys are sent once and never shown again.
- **Extensions**: each extension's state, status line and errors; set its secrets (e.g. Telegram's bot token), sign
  in (e.g. Google), edit its settings, turn it off or on, or roll a workspace one back.
- **Schedules** (pause, resume, remove), **General** (job, memory, safety and context limits; clear finished jobs),
  **Recent changes** (with Undo) and **Update** (check, update now — japa restarts and the page reconnects — and
  roll back).

Every change goes through the same checks as Telegram's menu: an invalid value is shown as `Not changed: …`.

### Desktop in the browser

The **Desktop** button shows japa's desktop live, through the web UI's own address — an SSH tunnel to 7337, a
Tailscale address or a Docker instance's published web UI port is enough; port 6080 needn't be reachable. No
password to type. It opens **view-only**; **Take control** lets you click, type and paste (a Paste field sends text
to the desktop's clipboard, and what's copied there is shown for copying) until you **Stop controlling** or close
the panel. The CoS can keep using the desktop at the same time. On a wide screen it docks beside the chat; **Full
screen** fills the screen. When the desktop isn't running, it shows why and offers **Start desktop**.

It's served by the daemon itself (a SvelteKit app in `extensions/webui/app`, built by `install.sh`, `japa update`
and `npm install`), accepts only requests addressed to its own host names or an IP address, and loads nothing from
other sites.

## Jobs

The CoS hands anything longer than a quick lookup to a background job: an agent with `read`, `write`, `edit` and
`bash`, every skill and every extension's tools, on the worker model (`models.worker`, else the CoS's) at
`jobs.thinking`. At most `jobs.maxConcurrent` run at once. Jobs need bubblewrap (`bwrap`); without it, japa runs but
refuses to start jobs, and `japa status` says why.

Each job runs in a bubblewrap sandbox. It sees your files and the network as you do, except:

- `~/.japa` is the job's own clone of it (made at `~/.japa/.jobs/<id>`), without your secrets, `state.db` or japa's
  socket; `~/.japa/desktop/shared` is the real shared folder, `~/.japa/attachments` (the files you sent) and
  `~/.japa/settings.json` are the real ones, read-only, and `~/.japa/outbox` is the real one, writable: a job puts
  files meant for you there (by convention `~/.japa/outbox/<job id>/`), and the CoS sends them to you.
- `/tmp` and `/var/tmp` are private to the job.
- japa's install directory, the `japa` launcher, and your systemd user units and `environment.d` are read-only, so a
  job can't change what japa runs with your secrets.
- `sudo` and other setuid programs don't work, and Docker, `systemctl --user`, the D-Bus session bus and the ssh
  agent are out of reach. A job can't install system packages or start services that outlive it.
- It gets only `PATH`, `HOME`, `USER`, `SHELL`, `LANG`, `TZ`, `TERM` and `JAPA_HOME` from japa's environment, so
  provider keys set as environment variables don't reach it. Its `PATH` also has japa's Node and the `japa`
  launcher's directory (`~/.local/bin`), so `japa check` works there.

When a job finishes, its changes under `~/.japa/extensions/` and `~/.japa/skills/` go live: each changed one is
checked with `japa check` in the sandbox, then merged into `~/.japa` (a three-way merge, so changes made since the
job started are kept), loaded and logged as one change you can undo. Anything else it changed in `~/.japa` is
dropped. Its report to the CoS ends with the outcome: `Live: <paths> (change <id>).`, or `Not live: <why>. Kept at
~/.japa/.jobs/<id>.` when nothing went live, for example because the check failed, the merge conflicted or the
change failed to load (then it's reverted). When it changed other files, a `Live` line ends with `Dropped: <paths>.`,
and so does a `Not live` line, except one saying the job was stopped, its changes couldn't be committed, or
publishing failed, which may not name them. A job that changed only other files ends `Not live: the job changed
nothing under extensions/ or skills/. Kept at ~/.japa/.jobs/<id>. Dropped: <paths>.`; one that changed nothing in
`~/.japa` has no outcome line. While a job's changes go live it can't be messaged. A kept clone is deleted 7 days
after its job ends.

## Updating

```sh
japa update
```

Fetches the branch you're on (`main` by default) and fast-forwards your checkout to it. Local edits in the
checkout are stashed first and restored after; a history that has diverged (local commits that aren't upstream)
is refused rather than guessed at, leaving your checkout unchanged. It reinstalls dependencies if they changed,
downloads a newer private Node.js if one is needed, rebuilds the web UI, and validates the result before doing anything else; on
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

Re-running `install.sh` and choosing Update (the default when japa is installed) does the same thing: it runs
`japa update` instead of cloning again (writing the launcher first if it's missing or points at another install).
Without a terminal, or with `--non-interactive`, it updates without asking. Your `~/.japa` data —
settings, secrets, extensions, skills — is never touched by an update, except to record which extensions
it has told you about.

You can also update from Telegram (or any messaging extension) with `/update`, as described under Telegram.

In a Docker instance, `japa [--instance <name>] update` and `/update` work the same way, inside the container. They
update japa but not the container's image; re-run the installer for that (see Docker install).

### Uninstall

```sh
japa uninstall
```

Stops and removes the service and the `japa` launcher (if it runs this install), and removes the install
directory's `app/` and the private Node.js japa installed, then the directory itself once it's empty (a checkout you
cloned and linked yourself is left in place). Your data stays in `~/.japa`; the command prints where. Add `--purge`
to delete that too, once you type `delete` to confirm. The PATH line `install.sh` added to your shell's rc file is
left as it is; the command names the file. (A native install whose launcher is `~/.local/bin/japa-native` leaves
that file in place; remove it by hand.)

For a Docker instance:

```sh
japa [--instance <name>] uninstall [--purge]
```

runs on the host: it removes the container `japa-<name>` and its network, and says the data is kept in the volumes
`japa-<name>-home` and `japa-<name>-docker` — re-run the installer with `--instance <name>` to bring the instance
back. With `--purge` (needs a terminal) it deletes the volumes too, once you type the instance name to confirm. When
no instances remain, it removes the host launcher. The image `japa-host:<branch>` stays; remove it with
`docker image rm japa-host:<branch>`.

For a native install you can also re-run `install.sh` and choose Uninstall. It asks before removing anything, then whether to delete your data
too. This works even when japa itself can't run (a half-finished install, a missing or wrong Node, broken
dependencies, no launcher): when japa can run it hands over to `japa uninstall` (with `--purge` if you chose to
delete data); otherwise it removes the service unit, the `japa` launcher if it points at this install, `app/`, the
private Node.js japa installed, and the directory once it's empty. Either way `~/.japa` is kept unless you chose to
delete data and typed `delete`, and the PATH line in your rc file is only named, never edited.

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
message goes to the CoS again). The CoS's markdown — bold, links, nested lists, task lists
(☐/☑), code, quotes, `||spoilers||` — is shown as Telegram formatting; tables come out in monospace, and
long quotes collapse until you expand them. If Telegram still rejects a message, it's sent as plain text.

You can send files too: photos, documents, audio, voice notes, video and animations, with or without a caption
(Telegram lets bots download up to 20 MB). Each is saved under `~/.japa/attachments/<date>/` and handed to the CoS:
images inline when its model can see them, PDFs with their text extracted (also saved beside the PDF as `.txt`), and
anything else by its path, so the CoS can read it or start a job on it (say, to transcribe a voice note). Stickers,
locations, contacts and polls aren't read. The CoS can send files back, up to 50 MB, as a photo, audio, voice note,
video or document depending on the type, with a caption; a bigger one arrives as a message naming its path on
japa's host.

When japa needs a secret, it sends a prompt — ``japa needs `<name>`: <why>. Reply to this message with it;
I'll delete your reply at once.`` — with Telegram's reply box already open, then ``Don't want to provide
`<name>`?`` with a `Decline` button. Only a reply to the prompt (or to its Decline message) is taken as the
secret, and the bot deletes it at once; anything else you send goes to the CoS as usual. Several prompts can
be open at once; answer them in any order. `Decline` withdraws the request and tells the CoS you said no.

`/update` updates japa from the chat. It checks for new commits and lists them, with `Update now` and
`Cancel`. `Update now` runs `japa update` outside the daemon (a transient systemd unit when the
service is running, a detached process otherwise), which restarts the service; the
result — updated, failed and rolled back, or already up to date — is reported back in the chat you asked
from, with a `Roll back` button that returns to the commit you were on (it asks first, and works offline,
except when the two commits' dependencies differ: it reinstalls them, which needs the network). While one
runs, `/update` says so. Progress is recorded in `~/.japa/update.json` and logged to
`~/.japa/logs/update.log`. It needs japa running as the service or `japa daemon`; with a foreground daemon,
the report asks you to restart it yourself.

## Desktop

japa has its own computer: a Linux desktop with Chromium in a Docker container, which jobs use, one at a time, to
get things done on websites and in programs. There's nothing to set up: when japa starts, it builds the desktop's image
(a few minutes, the first time) and starts it in the background, so it's ready when first needed. It needs Docker,
installed and usable by the user running japa (on Linux: `sudo usermod -aG docker $USER`, then log in again);
`japa status` shows the desktop's line under the `desktop` extension, including what's wrong if it can't start.

- **Watch or take over** in the web UI's **Desktop** panel (view-only until you Take control), or in noVNC: `ssh -L 6080:localhost:6080 <server>`, then open
  `http://localhost:6080/vnc.html`; or set `extensions.desktop.bind` to a Tailscale address. The password is in
  `~/.japa/secrets/desktop.vncPassword`.
- **Files** are exchanged in `~/.japa/desktop/shared` (`/home/japa/shared` on the desktop); a job uploads a file in
  the browser by putting it there and uploading `~/shared/<name>`.
- **Settings** (`extensions.desktop`), all optional: `cpus` (default `2`), `memory` (`"4g"`), `shm` (`"2g"`),
  `bind` (`"127.0.0.1"`) and `autostart` (`true`; `false` builds and starts it on first use instead). A change recreates the container on the next use and keeps its home (`/home/japa`, with the
  browser's logins; those from the last ~30 s before a stop, recreate or reboot may be lost, as Chromium commits
  cookies every ~30 s).
- **Recovery.** If the desktop's container won't start (say, Docker lost its layers), japa removes it and creates it
  again, rebuilding the image if it's gone; if a new container won't run, japa rebuilds the image; if a build fails,
  japa clears Docker's build cache and tries once more. Each happens once until the desktop comes up again, so a
  lasting problem shows in `japa status` as before. The home volume is always kept; the chief of staff is told when
  software installed with apt was lost.

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
prompt in `japa chat`, or as a reply to its prompt in Telegram (the bot deletes it at once).
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
extensions/          extensions jobs built             (git-tracked)
skills/              skills jobs built                 (git-tracked)
.jobs/               each job's clone of ~/.japa and its private /tmp; failed ones kept 7 days (ignored by git)
secrets/             secrets, one file per secret      (ignored by git); webui.session-key signs web UI sessions
                     (a leftover webui.token is obsolete and can be deleted)
webui/users.json     the web UI's users: names, scrypt password hashes (mode 600; ignored by git, so jobs never see it)
attachments/         every file you sent (plus a `.txt` beside each PDF with its text), files from Google (ignored by git)
outbox/              files jobs made for you, for the CoS to send; not pruned automatically (ignored by git)
desktop/shared/      files shared with japa's desktop  (ignored by git)
logs/                update.log, `/update`'s log (ignored by git)
update.json          the last `/update`: how it went and whether it's been reported (ignored by git)
setup.json           extensions `japa setup` and `japa update` have already told you about (ignored by git)
state.db             conversations, jobs, memory, change log (SQLite; ignored by git)
japa.sock            the socket `japa chat` and `japa status` connect to
boots.json, daemon.lock, .cache/, node_modules/   runtime files
```

The tag `japa-lkg` marks the last known good commit. `git log` in `~/.japa` shows every job's merge, undo and rollback.

### Docker instances

A Docker instance `<name>` is the same layout inside its container, under user `japa`'s home, with everything kept
in Docker:

| Thing | What it holds |
| --- | --- |
| volume `japa-<name>-home` → `/home/japa` | the whole home: the checkout `~/.local/share/japa/app`, the inner launcher `~/.local/bin/japa`, `~/.japa` (settings, secrets, history, jobs' work), the service unit |
| volume `japa-<name>-docker` → `/var/lib/docker` | the instance's own Docker: the desktop's image, build cache, container and home (browser logins); the image configures the inner Docker (classic overlay2 store, not the containerd one) so all of it lives here |
| network `japa-<name>-net` | a bridge used by this instance only |
| container `japa-<name>` | labels `japa.instance=<name>`, `japa.branch=<branch>`, `japa.desktopPort=<port>`, `japa.webuiPort=<web UI port>`, `japa.webuiBind=<address>`; publishes only `127.0.0.1:<port>` (the desktop) and `<address>:<web UI port>` (the web UI, `127.0.0.1` by default) |
| image `japa-host:<branch>` | built from `docker/` (branch names with characters other than `A-Za-z0-9_.-` get `-` in the tag); shared by instances on that branch |

No host paths are mounted. On the host, only `~/.local/bin/japa` (and the PATH line in your shell's rc file, if it
was needed) is written. Recreating the container (a re-run after the image changed, or after `uninstall`) keeps both
volumes, so everything above survives; software installed with apt into the container's root filesystem doesn't.
`japa --instance <name> shell` is the way in to look around.

## Extending

Ask the CoS: "when I say standup, draft my standup from my notes", or "add a tool that ...". It picks a mechanism
(skill or extension) and builds it in a background job; when the job finishes, the change goes live if its check
passes (see Jobs), and the CoS tries it and tells you how to use it; "undo that" reverts it. The procedures it
follows are in `skills/`: `choosing-a-mechanism`, `writing-job-briefs`, `building-skills`, `building-extensions` and
`reporting-changes`.
Extensions import only from `japa/sdk` (`src/sdk.ts`); the packaged ones in `extensions/` are examples. For a model
provider it also exports pi-ai's `createProvider`, `envApiKeyAuth`, the Anthropic Messages, OpenAI Responses and Chat
Completions APIs, and what wrapping their streams takes (`createAssistantMessageEventStream`,
`isRetryableAssistantError`, `isContextOverflow`, and the types).

## Development

```sh
npm test            # vitest
npm run typecheck   # tsc --noEmit, then svelte-check on the web UI
npm run build       # builds the web UI (extensions/webui/app → extensions/webui/build); npm install runs it too
JAPA_DOCKER_TESTS=1 npx vitest --run test/desktop-docker.test.ts   # the desktop on Docker (builds its image)
JAPA_SYSBOX_TESTS=1 npx vitest --run test/sysbox.test.ts           # Docker installs end to end (needs Sysbox)
```

The Sysbox tests create real instances from `JAPA_SYSBOX_TEST_REPO` at `JAPA_SYSBOX_TEST_BRANCH` (default
`https://github.com/Darryl-Shi/japa.git` at `main`), so they test what's pushed there, not your working tree.

Set `JAPA_HOME` to a scratch directory to run a throwaway daemon.
