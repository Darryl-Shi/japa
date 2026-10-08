# japa — install, setup and update

Date: 2026-10-08
Status: Draft for review
Extends: `2026-10-07-japa-design.md` (the "main spec")

## 1. Purpose

Installing japa today means cloning the repo, running `npm install` and
`npm link`, hand-writing `~/.japa/settings.json`, creating secret files with
the right modes, and keeping `japa daemon` open in a terminal. Upgrading is an
undocumented `git pull`. This spec adds, modelled on Hermes Agent's flow:

1. **`install.sh`**: a one-line `curl -fsSL …/install.sh | sh` that installs
   japa (and a private Node.js when needed), puts `japa` on the PATH, and
   starts the setup wizard. Re-running it upgrades.
2. **`japa setup`**: an interactive wizard for models, API keys, and every
   default extension's secrets and settings, generated from the extension
   manifests. Re-running it is the settings editor.
3. **`japa update`**: a safe upgrade (fast-forward only, validate, roll back on
   failure, restart the service) that offers to configure anything new.
4. **`japa service`**: a systemd user unit (Linux) or launchd agent (macOS)
   that runs the daemon in the background.
5. **`japa uninstall`**.

Success: on a fresh Linux or macOS machine with only git and curl, one command
followed by a few prompts leaves japa running as a service and answering in
`japa chat`; `japa update` later brings it to the latest `main` without losing
data and tells the user about new extensions that need configuring.

### Changes to the main spec

- The manifest field `secrets` accepts `string | { name, description }` (§6).
- Extension settings schemas carry TypeBox `description`s (§6).
- The kernel-added messaging `owner` setting gets a description (§6).
- The workspace `IGNORED` list gains `setup.json` and `logs/` (§4.4, §7.2).
- New CLI commands: `setup`, `update`, `service`, `uninstall`, `--version`.

### Out of scope

Windows (outside WSL); system-wide (root) services; release channels other
than a git branch; data migrations of `~/.japa` (none are needed today; if one
ever is, it belongs in the daemon's boot, not in the updater); live API-key
test calls; an extension enable/disable switch.

## 2. Layout

```
~/.local/share/japa/          install dir ($JAPA_INSTALL_DIR, or --dir)
  app/                        git checkout of japa (branch main by default)
  node/                       private Node.js, only if the system one is missing or older than 24
~/.local/bin/japa             launcher
~/.japa/                      runtime home ($JAPA_HOME), unchanged
```

The launcher is a generated shell script:

```sh
#!/bin/sh
exec "<absolute path to node>" --disable-warning=ExperimentalWarning "<install dir>/app/src/cli/main.ts" "$@"
```

The absolute Node path means the launcher and the service work without nvm or
shell PATH setup. `japa update` rewrites it when the Node path changes.

`app/.node-version` (new, e.g. `24.14.1`) pins the Node version a private
install downloads.

## 3. `install.sh`

POSIX `sh`, at the repo root, served from
`https://raw.githubusercontent.com/Darryl-Shi/japa/main/install.sh`.

### 3.1 Steps

1. **Platform.** `uname -s` / `uname -m` → `linux` or `darwin`, `x64` or
   `arm64`. WSL counts as Linux. Anything else exits: "japa supports Linux
   and macOS on x64 or arm64".
2. **Prerequisites.** `git`, `tar`, and `curl` or `wget`. A missing one exits
   naming it and how to install it (apt, dnf, brew).
3. **Existing install.** If `<dir>/app/.git` exists, run its
   `japa update` (the launcher if present, else
   `node <dir>/app/src/cli/main.ts update` with any Node ≥ 24 found by
   step 5) with `--branch` passed through, and exit with its status. This is
   the upgrade path.
4. **Clone** `--repo` (default `https://github.com/Darryl-Shi/japa.git`) at
   `--branch` (default `main`) into `<dir>/app`.
5. **Node.**
   - If `node` is on PATH and its major version is ≥ 24, use it (its absolute
     path, from `command -v node`).
   - Otherwise download `node-v<ver>-<os>-<arch>.tar.gz` and
     `SHASUMS256.txt` from `https://nodejs.org/dist/v<ver>/` (ver from
     `.node-version`), verify the tarball's SHA-256 (`sha256sum` or
     `shasum -a 256`), and unpack it into `<dir>/node`.
6. **Dependencies.** `npm ci` in `<dir>/app` with that Node. (Dev dependencies
   are needed: `japa check` runs japa's own `tsc` and `vitest`.)
7. **Launcher.** Write `~/.local/bin/japa` (mode 755). If `~/.local/bin` is
   not on PATH, append the right line to `~/.bashrc`, `~/.zshrc` or
   `~/.config/fish/config.fish` (from `$SHELL`) and print "open a new shell
   or run: export PATH=…".
8. **Setup.** Run `japa setup` with stdin from `/dev/tty`, so prompts work
   under `curl | sh`. Skipped with `--skip-setup`; with `--non-interactive`
   or when `/dev/tty` cannot be opened, skipped with "run `japa setup` to
   finish". `--no-service` is passed through.

### 3.2 Flags

| Flag | Env | Default |
| --- | --- | --- |
| `--dir <path>` | `JAPA_INSTALL_DIR` | `~/.local/share/japa` |
| `--branch <name>` | `JAPA_BRANCH` | `main` |
| `--repo <url>` | `JAPA_REPO` | `https://github.com/Darryl-Shi/japa.git` |
| `--non-interactive` | | off |
| `--no-service` | | off |
| `--skip-setup` | | off |

### 3.3 Failure

Each step prints a one-line heading. On a fresh install, a failing step prints
which step failed and its output, removes the `app/` and `node/` it created,
and exits non-zero. `install.sh` never touches `~/.japa`.

## 4. `japa setup`

`src/cli/setup.ts`, command `setup` in `src/cli/main.ts`.

### 4.1 Mechanics

- Uses pi-tui (`SelectList` with filtering, `Input`, a masked input as in
  `japa chat`'s secret prompt), so it looks like `japa chat`.
- Needs no daemon. Calls `ensureWorkspace(home)` first.
- Discovers manifests with the existing loader (`discoverExtensions` over the
  packaged and workspace extension dirs) and imports them.
- Opens the configured secrets adapter the same way boot does
  (`settings.secrets.adapter` from the loaded extensions), so custom secrets
  adapters work. Secrets are written only through it.
- Settings are read with `readUserSettings` and written with `saveSettings`,
  so keys the wizard does not touch are preserved. Every write is validated
  with `validateSettings` against the extensions' schemas first.
- Model choices come from pi-ai's built-in providers (the `providers`
  extension's `builtinProviders()`): providers with at least one model, then
  that provider's models. The chosen ref is checked with `checkModel`.

### 4.2 First run

Runs when `models.cos` is unset. Linear:

1. **CoS model.** Pick a provider, then a model.
2. **API key.** For the CoS provider. If its environment variable is set,
   say so and still offer to store it (a service does not inherit the shell's
   environment). Masked input; written as the secret `<provider>.apiKey`. If
   the secret already exists, Enter keeps it.
3. **Worker and consolidation.** "Use the CoS model for workers and memory
   consolidation? [Y/n]". On no, steps 1–2 for each role; a key is asked for
   only for a provider without one.
4. **Extensions.** §4.4.
5. **Service.** Unless `--no-service`: "Run japa in the background? [Y/n]" →
   `service install` (§7). On a machine without a usable service manager,
   print why and "run `japa daemon` yourself".
6. **Summary.** If the service was started, wait up to 30 s for the daemon's
   socket and print `japa status` (model and key errors, extension errors,
   each extension's status line such as the desktop's). Otherwise print
   "start japa with: japa daemon".

### 4.3 Reruns

When `models.cos` is set, a menu instead: **Models** (steps 1–3, current
values preselected), **Extensions** (§4.4, all configurable extensions),
**Service** (install, start, stop, uninstall, status), **Done**. After
anything was saved, if the service is running: "Restart japa to apply? [Y/n]".

### 4.4 Extensions step

The configurable extensions are those whose manifest declares `secrets` or a
`settings` schema. For each, in name order:

- The header shows the name, `summary`, and `(configured)` when every
  declared secret exists and, if it has a settings schema,
  `settings.extensions.<name>` is set.
- "Configure <name>? [y/N]" (default no; `(configured)` ones default no too).
- On yes:
  - **Each secret:** masked input, with the secret's `description` (§6) as
    help. Enter keeps the current value or leaves it unset.
  - **Each property** of the settings schema's top-level object, prompted by
    its type, with its `description` as help and its current value, else its
    schema `default`, prefilled:
    - string → text input; number/integer → text input parsed as a number;
    - boolean → yes/no select; enum or union of literals → select.
    - Enter on an empty optional property leaves it unset.
    - Properties of other types (objects, arrays) are not prompted; the
      wizard notes "edit `extensions.<name>.<key>` in settings.json or ask
      the CoS".
  - The resulting `extensions.<name>` object is validated; on failure the
    wizard shows the error and re-prompts the failing property.

After the step, every configurable extension's secret names and property names
are recorded in `~/.japa/setup.json` as offered (§5.2), whether or not the
user configured it:

```json
{ "offered": { "telegram": ["secret:telegram.botToken", "setting:owner"] } }
```

`setup.json` is added to the workspace `IGNORED` list.

### 4.5 Non-interactive

`japa setup --non-interactive` reads `JAPA_PROVIDER`, `JAPA_MODEL` and
`JAPA_API_KEY`, writes `models.cos` and the key when given, installs the
service unless `--no-service`, and skips extensions. If `models.cos` is still
unset afterwards it prints what is missing and exits 1. `japa setup` without
the flag and without a tty behaves the same way.

## 5. `japa update`

`src/cli/update.ts`. Usage:
`japa update [--check] [--branch <b>] [--to <sha>] [--no-restart]`.
It works on the checkout containing the running `main.ts`.

### 5.1 Steps

1. **Preflight.** The checkout must be a git repo on a branch (else exit with
   the reason). Uncommitted changes are stashed
   (`git stash push -u -m "japa update <date>"`) and reapplied at the end; if
   reapplying conflicts, the stash is kept and the command prints
   `git stash list` / `git stash pop` instructions.
2. **Fetch.** `git fetch origin <branch>` (`--branch` defaults to the current
   branch; a different branch is checked out after the fetch). With `--to`,
   the target is that commit, which must exist after the fetch. If HEAD equals
   the target: "japa is up to date (<short sha>)", exit 0. `--check` prints
   the number and `git log --oneline` of incoming commits and exits without
   changing anything.
3. **Apply.** Record the old sha. `git merge --ff-only <target>`; with `--to`,
   `git checkout -B <branch> <sha>`. A non-fast-forward without `--to`
   (diverged history) stops: "your checkout has diverged from origin/<branch>;
   nothing changed".
4. **Node.** If `.node-version` changed and the private `node/` is in use, or
   the Node in use is now below 24: download and verify the new version into
   `node.new/` (the same procedure as §3.1 step 5, in TypeScript with `fetch`
   and `node:crypto`), then rename it over `node/`, keeping the old one as
   `node.old/` until step 6 passes. Rewrite the launcher.
5. **Dependencies.** If `package-lock.json` changed: `npm ci`.
6. **Validate.** Run `<node> app/src/cli/main.ts --version`. `--version` is a
   new command that imports the kernel's boot module and prints
   `package.json`'s version and the git sha, which catches syntax and import
   breakage.
   - If step 4, 5 or 6 fails: `git reset --hard <old sha>`, restore
     `node.old/` and the launcher, `npm ci` if the lockfile had
     changed, and print "update failed at <step>: <error>; still on <old
     sha>". Exit 1.
7. **What's new.** §5.2, run by the new code (`<node> <app>/src/cli/main.ts
   setup --whats-new`; the updating process can't re-import changed modules),
   before the restart so one restart applies code and configuration.
8. **Restart.** Unless `--no-restart`: if the service is installed, restart
   it through the service manager and wait up to 30 s for the socket.
   Otherwise, if `daemon.lock` names a live pid, print "restart `japa daemon`
   to apply". A foreground daemon is never killed.
9. **Report.** `<old short sha> → <new short sha>` and `git log --oneline
   old..new` (first 20 lines).

`~/.japa` (settings, secrets, `state.db`, workspace extensions) is not touched
except `setup.json`. If `setup.json` is missing when update starts, the
pre-update manifests are recorded as offered first, so the first update does
not present every extension as new.

### 5.2 What's new

Load the manifests of all extensions (packaged and workspace) and compare
each configurable extension's secret and property names against
`setup.json`'s `offered`. The unseen ones are new extensions, or new secrets or
settings in existing extensions.

- Interactive (a tty): list them, e.g.
  "New: `calendar` — needs `calendar.oauthToken`" and
  "`web` has a new setting `region`", then "Configure now? [Y/n]". Yes runs
  §4.4 for just those extensions.
- Otherwise: print the list and "run `japa setup` to configure".
- Either way, mark them offered.
- New extensions with nothing to configure are listed in the report with
  their summary.

If the user skips configuring, the CoS still sees the extension's summary and
can ask for its secret when needed, as with Telegram today.

### 5.3 Going back

Packaged extensions are not in `~/.japa`'s git history, so `japa rollback`
does not cover them. `japa update --to <sha>` checks out an older commit with
the same validate-and-roll-back steps.

## 6. Manifest changes

- `JapaExtension.secrets` becomes `(string | { name: string; description: string })[]`.
  A helper `secretNames(extension)` returns the names; `boot.ts`'s
  `declared` check (its only consumer today) uses it.
- Settings schema properties carry TypeBox `description`s, used as the
  wizard's help text.
- `telegram`: `secrets: [{ name: "telegram.botToken", description: "Bot token from @BotFather (/newbot)" }]`.
  The kernel already adds `owner` to every messaging extension's settings
  schema (`settingsSchema` in `settings-tools.ts`); it gains the description
  "Your <extension> user id. Leave blank, message the bot, and it replies with
  your id."
- `web`: a description for `web.brave.apiKey` ("Brave Search API key, for
  web_search").
- `desktop`: descriptions for `desktop.vncPassword` and for `cpus`, `memory`,
  `shm`, `bind`, with their defaults stated.
- The `building-extensions` skill mentions descriptions for secrets and
  settings, so CoS-built extensions are configurable in the wizard too.

## 7. `japa service`

`src/cli/service.ts`. Usage:
`japa service <install|uninstall|start|stop|restart|status|logs>`. Setup and
update call the same functions.

### 7.1 Linux: systemd user unit

`~/.config/systemd/user/japa.service`:

```ini
[Unit]
Description=japa
After=network-online.target

[Service]
ExecStart=<launcher> daemon
Restart=on-failure
RestartSec=5
Environment=PATH=<PATH at install time>
Environment=JAPA_HOME=<home>          # only when JAPA_HOME is set

[Install]
WantedBy=default.target
```

- Available when `systemctl --user show-environment` succeeds. If it does not
  (WSL without systemd, containers): print the reason and the options (enable
  systemd in `/etc/wsl.conf` with `[boot] systemd=true`, or run
  `japa daemon` yourself), and return without failing setup.
- `install`: write the unit, `systemctl --user daemon-reload`,
  `enable --now japa`, then `loginctl enable-linger $USER`; if lingering
  fails, print "to keep japa running after you log out: sudo loginctl
  enable-linger $USER".
- `logs`: `journalctl --user -u japa -f`.

### 7.2 macOS: launchd agent

`~/Library/LaunchAgents/dev.japa.daemon.plist`: `ProgramArguments`
`[<launcher>, daemon]`, `RunAtLoad`, `KeepAlive` `{ SuccessfulExit: false }`,
`EnvironmentVariables` (PATH, `JAPA_HOME` when set), stdout and stderr to
`~/.japa/logs/daemon.log`. Start and stop with
`launchctl bootstrap|bootout gui/$UID <plist>`; restart with
`launchctl kickstart -k gui/$UID/dev.japa.daemon`. `logs`:
`tail -f ~/.japa/logs/daemon.log`. `logs/` is added to `IGNORED`.

### 7.3 Shared behaviour

- `install` is idempotent: it rewrites the unit or plist only when its content
  changed, and reloads it then (this picks up a new launcher path after an
  update).
- `start` (and `install`'s start) refuses while `daemon.lock` is held by a
  live process that the service manager did not start, with "japa is
  already running in the foreground (pid N); stop it first".
- `status`: the service manager's state, then `japa status` if the socket
  answers.
- The daemon's crash counting and safe mode are unchanged: boots are counted
  in `boots.json` whoever restarts the daemon.

## 8. `japa uninstall`

`japa uninstall [--purge]`: `service uninstall`, remove the launcher and the
install dir, and print that `~/.japa` was kept and where. `--purge` also
deletes `~/.japa` after the user types `delete`. Lines appended to shell rc
files are left (and named in the output).

## 9. Errors

- Every command prints a one-line heading per step and, on failure, the step,
  the command that failed and its stderr, then exits non-zero.
- Network failures (clone, fetch, Node download) name the URL.
- Ctrl-C in the wizard exits without saving the current step; steps already
  completed stay saved.

## 10. Testing

Vitest, in `test/`:

- **Pure units:** schema → prompt mapping; the `setup.json` unseen diff;
  systemd unit and plist rendering; Node tarball name per platform and
  SHA-256 verification against a fixture `SHASUMS256.txt`; launcher text;
  `secretNames`.
- **Update** against a local bare repo in a tmp dir (npm and the Node
  download stubbed): up to date; fast-forward; diverged (refuses, unchanged);
  local edits (stashed and reapplied); lockfile changed (runs `npm ci`);
  validation failure (back to the old sha); `--to`; `--check` changes
  nothing; what's-new lists a new extension and a new secret once.
- **Setup** through a `Prompter` interface driven by a scripted fake (the
  pi-tui prompter is thin and checked manually): a first run writes the expected `settings.json` and secret files; a rerun
  with Enter everywhere changes nothing; an invalid property re-prompts.
- **install.sh:** `--dir <tmp> --repo <local bare> --non-interactive
  --no-service --skip-setup` produces the layout and a launcher for which
  `japa --version` works; a second run takes the update path.
- **Manual checklist** (in the plan): systemd on Linux, WSL without systemd,
  launchd on macOS, `curl | sh` from the real URL.

## 11. Documentation

README: Install, First run and Running are rewritten around
`curl … | sh`, `japa setup` and `japa service`; a new Updating section covers
`japa update`, `--check`, `--to` and `japa uninstall`. The manual steps stay
as "Install from a checkout" for development.
