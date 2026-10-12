# japa: installer menu with Install / Update / Uninstall

Status: approved for build. This is an incremental change to japa's bootstrap installer (`install.sh`). The builder folds it into `docs/spec.md` and the README.

## 1. Purpose

Today `curl -fsSL …/install.sh | sh` installs japa, or upgrades an install that's already there. The only way to remove japa is `japa uninstall [--purge]`, which needs a working `japa` on the PATH.

With this change, running the installer in a terminal first shows a menu: **Install**, **Update**, **Uninstall** (plus Quit). You choose the action there, not with a command-line flag. Uninstall works whether the install is healthy or broken: half-finished, a missing or wrong Node, broken `node_modules`, or no launcher.

`japa uninstall` itself is unchanged.

## 2. Key technical decisions

### 2.1 The first menu
The menu is plain POSIX sh. Node may not exist yet, so it can't use clack. It is drawn on the terminal and read from `/dev/tty`, so it works under `curl | sh`. It appears after the platform check and before anything else happens. Install-specific steps (the prerequisites check, cloning, Node) run only after **Install** or **Update** is chosen.

```
==> japa installer (<dir>)
  1) Install
  2) Update
  3) Uninstall
  4) Quit
Choose [N]:
```

- **Header.** It names the install dir: `--dir` / `JAPA_INSTALL_DIR`, default `~/.local/share/japa`, canonicalised as today. When japa is already installed there (`<dir>/app` is a japa checkout), the header also says `installed`.
- **Default.** Enter picks the default: **Update** when installed, **Install** otherwise.
- **Input.**
  - Any input other than 1–4 or Enter re-asks.
  - EOF or Ctrl-C quits with nothing done and exit status 0. Ctrl-C at the menu exits 130.
  - **Quit** exits 0 with nothing done.
- **Actions that don't fit the install's state.** These print a line and show the menu again:
  - **Install** when already installed: `japa is already installed at <dir>; choose Update`.
  - **Update** when not installed: `no japa install at <dir>; choose Install`.
  - **Uninstall** when nothing at all is there (no `app/`, no japa `node/`, no launcher pointing at `<dir>/app`): `no japa install at <dir>`.
- **A foreign `app/`.** If `<dir>/app` exists but isn't a japa checkout, the existing refusal (`… isn't a japa checkout; remove it or choose another --dir`, exit 1) happens before the menu, and nothing is touched.

**When there's no menu.** The menu appears only when a controlling terminal can be opened (the existing `has_tty` probe) and `--non-interactive` isn't given. Otherwise the script behaves exactly as today: a fresh install, or the upgrade path when already installed. Scripted and CI installs keep working, and uninstall is never chosen without a person at the terminal.

**Flags.** No action flag is added. The existing flags keep their meanings:
- `--dir` chooses the install the menu acts on;
- `--branch` and `--repo` apply to Install and Update;
- `--no-service` and `--skip-setup` apply to Install;
- `--non-interactive` now also means "no menu".

### 2.2 Install and Update
- **Install** runs today's fresh-install path unchanged: prerequisites, clone, node, dependencies, build, launcher, then setup, with the same cleanup-on-failure trap and messages.
- **Update** runs today's upgrade path unchanged: write the launcher first if it's missing or points elsewhere, then `japa update`, forwarding `--branch` only when it was given, and exit with its status.

### 2.3 Uninstall
After **Uninstall** is chosen:

1. **Removal prompt.** The script prints what will be removed (the service, the launcher if it points here, `<dir>/app`, japa's `node/`) and asks `Uninstall japa from <dir>? [y/N]`. Anything but `y`/`yes` returns to the menu.
2. **Data prompt.** It asks `Also delete your data in <home> (settings, secrets, memory)? [y/N]`, where `<home>` is `$JAPA_HOME`, or `~/.japa` when that's unset. A yes means purge. The typed `delete` confirmation that follows comes from whichever mode runs in step 3 (`japa uninstall --purge`'s own prompt, or install.sh's equivalent). Any other answer there keeps everything: `purge cancelled; nothing was removed`, exit 0.
3. **Mode.** The script then delegates to the installed japa when it can, and falls back to removing things in shell when it can't (see below). There is one source of truth for the removal rules, `src/cli/uninstall.ts`. install.sh only re-implements them for the fallback.

**The probe: can the checkout run?** This is decided once, before anything is removed:
1. `<dir>/app` must be a japa checkout (the existing `is_japa_checkout` check).
2. A runner must be found, tried in this order:
   - the launcher, when it points at `<dir>/app` (`launcher_points_here`);
   - otherwise `<dir>/node/bin/node`, when it carries `.japa-node` and is Node ≥ 24;
   - otherwise a system `node` ≥ 24.

   A Node runner is used as `<node> --disable-warning=ExperimentalWarning <dir>/app/src/cli/main.ts`, exactly what the launcher execs.
3. `<runner> --version` must exit 0. This loads `main.ts`'s whole import graph, so it also catches broken dependencies.

**Delegated mode.** When the probe passes, the script prints `==> Uninstalling with japa uninstall` and runs `<runner> uninstall`, adding `--purge` if you chose to delete data.
- stdin comes from `/dev/tty`, and the environment is passed through unchanged.
- The script exits with that command's status. It never runs the fallback after a delegated run, so nothing is acted on twice.

**Fallback mode.** When the probe fails, the script prints `==> japa can't run from <dir>; removing it directly`, then mirrors `uninstall.ts`, in order:
1. **Purge confirmation.** Only if you chose to delete data: `Type "delete" to permanently remove <home>`. Any other answer prints `purge cancelled; nothing was removed` and exits 0.
2. **Service.** If `systemctl` exists, it runs `systemctl --user disable --now japa` and ignores failure. It removes `${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/japa.service`, then runs `systemctl --user daemon-reload` and ignores failure.
3. **Launcher.** `~/.local/bin/japa` is removed only if it points at `<dir>/app`.
4. **Install dir.** It removes `<dir>/app` and `<dir>/node`, but `node/` only if it carries `.japa-node`. It removes `<dir>` only if it is then empty.
5. **Data.** If purging, it removes `<home>` and prints `removed <home>`. Otherwise it prints `kept <home>`.
6. **PATH line.** It names any of `~/.bashrc`, `~/.zshrc` or `~/.config/fish/config.fish` that still holds install.sh's PATH line, and never edits them.

In fallback mode, the steps after the confirmation are best-effort. A failed step is reported, the remaining steps still run, and the exit status is non-zero if any step failed.

**Safety in uninstall.**
- The prerequisites check (git, tar, curl/wget) is skipped, since uninstalling needs none of them.
- The install `cleanup` trap is not armed.
- The script stays wrapped in `main()` (truncated-download safety), and `sh -n` must accept it.

### 2.4 Tests
- **Where.** `test/install-sh.test.ts` drives the menu against the mini-japa fixture. It gives the script a pseudo-terminal, or an overridable tty path used only by tests (in the same spirit as `JAPA_NODE_DIST`), so answers can be scripted. It uses a temporary `HOME`/`XDG_CONFIG_HOME`/`JAPA_HOME` and a fake `systemctl` on PATH that records its calls.
- **Delegated mode.** It's observed through the fixture's `main.ts` `uninstall` stand-in. The real `uninstall.ts` stays covered by `test/uninstall.test.ts`.
- **Fallback mode.** It's exercised by breaking the probe, for example by removing `node_modules`.
- **No-terminal path.** The existing tests keep passing unchanged.

## 3. Docs
- **README Install section.** It describes the menu: what each choice does, the default, and that there's no menu without a terminal or with `--non-interactive`.
- **README Updating and Uninstall sections.** They mention re-running the installer and choosing Update or Uninstall, next to `japa update` / `japa uninstall`. They also note that the installer's Uninstall works even when japa itself can't run.
- **Script and specs.** The install.sh header comment, `docs/spec.md` and `PROGRESS.md` are updated.

## Acceptance behaviours

1. **Menu on a fresh machine.** Running `curl -fsSL …/install.sh | sh` in a terminal shows a menu with Install, Update, Uninstall and Quit, naming the install dir, with Install as the default. Pressing Enter installs japa exactly as before, including setup.
2. **Menu on an installed machine.** Running it again on that machine shows the menu marked `installed`, with Update as the default. Enter runs `japa update`.
3. **Mismatched choices.** On a fresh machine, choosing Update says `no japa install at <dir>; choose Install` and shows the menu again. On an installed one, choosing Install says it's already installed and shows the menu again.
4. **Quit.** Choosing Quit, or closing input, exits without changing anything.
5. **Uninstall on a healthy install.** Choose Uninstall, answer `y`, then `N` to deleting data. It prints `Uninstalling with japa uninstall`. The service is disabled and its unit file removed, and `~/.local/bin/japa`, `<dir>/app` and japa's `<dir>/node` are gone, along with `<dir>` once it's empty. `~/.japa` remains, and the output says it was kept.
6. **Declined removal.** Choose Uninstall and answer `N` to the removal prompt: the menu returns and nothing is removed.
7. **Uninstall with data.** Choose Uninstall, answer `y` to both prompts, then type `delete`: `~/.japa` (or `$JAPA_HOME`) is also removed. Typing anything other than `delete` prints `purge cancelled; nothing was removed`, and everything is still there.
8. **Broken install.** With `<dir>/app/node_modules` deleted, or no usable Node 24, Uninstall prints `japa can't run from <dir>; removing it directly` and still removes the service unit, the launcher pointing here, `app/` and the marked `node/`. It keeps `~/.japa` and exits 0.
9. **Other people's files survive.** A launcher pointing at another install, an `npm link` symlink, a `node/` without `.japa-node`, and extra files under `<dir>` are all left untouched, and `<dir>` is then kept.
10. **Foreign `app/`.** If `<dir>/app` isn't a japa checkout, the script refuses before the menu, exits 1 and touches nothing.
11. **PATH line named.** If install.sh had added a PATH line to `~/.bashrc`, the uninstall output names that file and leaves it unchanged.
12. **No terminal.** Without a terminal (CI, `curl | sh` with no tty), or with `--non-interactive`, no menu appears. The script installs fresh, or updates an existing install, exactly as before, and never uninstalls.
13. **Checks pass.** `sh -n install.sh`, `npm test` and `npm run typecheck` pass.
