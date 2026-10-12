# japa: `install.sh --uninstall`

Status: approved for build. This is an incremental change to japa's bootstrap installer. The builder folds it into `docs/spec.md` and the README.

## 1. Purpose

You install japa with `curl -fsSL …/install.sh | sh`, but the only way to remove it today is `japa uninstall [--purge]`, which needs a working `japa` on your PATH. This change lets the same installer script uninstall:

```sh
curl -fsSL https://raw.githubusercontent.com/Darryl-Shi/japa/main/install.sh | sh -s -- --uninstall [--purge] [--dir <path>]
```

`install.sh --uninstall` removes the install at `--dir` (or `JAPA_INSTALL_DIR`, default `~/.local/share/japa`). It works whether that install is healthy or broken: a half-finished install, a missing or wrong Node, broken `node_modules`, or a missing launcher.

`japa uninstall` itself does not change.

## 2. Key technical decisions

### 2.1 Delegate first, shell fallback second
There is one source of truth for the removal rules: `src/cli/uninstall.ts` (`japa uninstall`). `install.sh` hands off to it whenever the installed checkout can run. It does the removal in POSIX sh only when the checkout can't run.

**Can the checkout run? (the probe)** This is decided once, before anything is removed:
1. `<dir>/app` must be a japa checkout. The existing `is_japa_checkout` check applies: `<dir>/app/.git` exists and `package.json` is named `japa`.
2. A runner must be found, tried in this order:
   - the launcher `~/.local/bin/japa`, when it points at `<dir>/app` (the existing `launcher_points_here` test);
   - otherwise `<dir>/node/bin/node`, when `node/` carries the `.japa-node` marker and is Node ≥ 24;
   - otherwise a system `node` ≥ 24 on PATH.

   With a Node runner, the command is `<node> --disable-warning=ExperimentalWarning <dir>/app/src/cli/main.ts`, exactly what the launcher would exec.
3. Running that runner with `--version` must exit 0. This loads `main.ts`'s full import graph, so it also catches broken dependencies.

**Delegated mode.** When the probe passes, install.sh prints `==> Uninstalling with japa uninstall` and runs `<runner> uninstall`, adding `--purge` when it was given.
- stdin comes from `/dev/tty` so the purge confirmation works under `curl | sh`.
- The environment (`JAPA_HOME`, `XDG_CONFIG_HOME`, `PATH`) is passed through unchanged.
- install.sh exits with that command's exit status. It does **not** run the shell fallback after a delegated run, even one that failed, so nothing is acted on twice.

**Fallback mode.** When the probe fails, install.sh prints `==> japa can't run from <dir>; removing it directly`, then applies the same rules as `uninstall.ts`, in the same order:
1. **Purge confirmation first** (only with `--purge`). It prompts on `/dev/tty`: `Type "delete" to permanently remove <home>`. Any other answer prints `purge cancelled; nothing was removed` and exits 0 without touching anything.
2. **Service.** If `systemctl` exists, it runs `systemctl --user disable --now japa` and ignores failure. It removes `${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/japa.service`, then runs `systemctl --user daemon-reload` and ignores failure. Without `systemctl`, it only removes the unit file if present.
3. **Launcher.** `~/.local/bin/japa` is removed only if it points at `<dir>/app`, using the same quoted-path test as today. A launcher for another install, or an `npm link` symlink, is left alone.
4. **Install dir.** It removes `<dir>/app` and `<dir>/node`, but `node/` only if it carries `.japa-node`. It removes `<dir>` only if it is then empty. Nothing else under `<dir>` is touched.
5. **Data.** With a confirmed purge, it removes `<home>` and prints `removed <home>`. Otherwise it prints `kept <home>`. Here `<home>` is `$JAPA_HOME`, or `~/.japa` when that's unset.
6. **PATH line.** If install.sh's PATH line is still in `~/.bashrc`, `~/.zshrc` or `~/.config/fish/config.fish`, it names those files and leaves them unedited. The lines checked are the same ones `uninstall.ts` checks.

In fallback mode, the steps after the purge confirmation are best-effort. A step that fails is reported, the remaining steps still run, and the exit status is non-zero if any step failed.

### 2.2 Safety guards (both modes)
- **Not a japa checkout.** If `<dir>/app` exists but isn't one, the uninstall is refused with `<dir>/app exists and isn't a japa checkout; remove it or choose another --dir`, exit 1, and nothing is touched. This is the same guard the install path uses.
- **Nothing installed.** If `<dir>` has no `app/` and no japa `node/`, and the launcher doesn't point at `<dir>/app`, install.sh prints `no japa install at <dir>` and exits 0 without touching anything. Fallback mode still runs for leftovers: a launcher pointing here, a marked `node/`, or an empty `<dir>`. In that case it also removes the service unit, as `japa uninstall` does.
- **Purge needs a terminal.** `--purge` without a usable controlling terminal is refused before anything is removed: `--purge needs a terminal to confirm`, exit 1. Terminal detection reuses the existing `has_tty` open probe. Plain `--uninstall` needs no terminal.
- **Unsupported platform.** The existing platform check (step 1) still runs, so a non-Linux system is refused.
- **Steps skipped.** The prerequisites check (git, tar, curl/wget) is skipped for `--uninstall`, since none of them are needed.
- **No install cleanup.** The install's `cleanup` EXIT trap is not armed in uninstall mode.
- **Script structure.** The script remains wrapped in `main()` (truncated-download safety), and `sh -n` must still accept it.

### 2.3 Flags
- **`--uninstall`** (new): uninstall instead of install or upgrade.
- **`--purge`** (new): also delete japa's data (`$JAPA_HOME` or `~/.japa`) after the typed confirmation. It is only valid with `--uninstall`. Alone, it fails with `--purge only works with --uninstall`, exit 1.
- **`--dir` and `JAPA_INSTALL_DIR`**: choose the install to remove. The directory is canonicalised the same way as for install: made absolute, with trailing slashes stripped.
- **Ignored flags.** `--branch`, `--repo`, `--non-interactive`, `--no-service` and `--skip-setup` are accepted and ignored when combined with `--uninstall`.
- **Unknown options** still fail as today.

### 2.4 Tests
- `test/install-sh.test.ts` covers both modes against the mini-japa fixture, using a temporary `HOME`/`XDG_CONFIG_HOME`/`JAPA_HOME` and a fake `systemctl` on PATH that records its calls.
- For delegated mode, the fixture's `main.ts` gets (or already has) a stand-in `uninstall` that the test can observe. The real `uninstall.ts` behaviour stays covered by `test/uninstall.test.ts`.
- Fallback mode is exercised by breaking the probe, for example by removing `node_modules` or making `--version` fail.

## 3. Docs
- **README, Install section.** The flags table gains `--uninstall` and `--purge`.
- **README, Uninstall subsection.** It shows the `curl … | sh -s -- --uninstall` form alongside `japa uninstall` and explains that it works even when japa can't run. It also notes that `--purge` asks for `delete` on the terminal.
- **install.sh.** The header comment mentions `--uninstall`.
- **`docs/spec.md`.** Updated to describe the installer's uninstall mode. `PROGRESS.md` gets a line.

## Acceptance behaviours

1. **Healthy install, delegated.** After a normal install (with the service installed), `sh install.sh --uninstall` prints `Uninstalling with japa uninstall` and exits 0. The service is disabled and its unit file is gone, as are `~/.local/bin/japa` and `<dir>/app`. `<dir>/node` and `<dir>` are gone too when japa created them. `~/.japa` still exists, and the output says `kept ~/.japa` (with the real path).
2. **Same with `curl | sh`.** Piping the script (`… | sh -s -- --uninstall`) gives the same result.
3. **Purge through delegation.** `--uninstall --purge` from a terminal asks you to type `delete`. Typing `delete` also removes `~/.japa` (or `$JAPA_HOME`). Typing anything else prints `purge cancelled; nothing was removed`, and the install, service, launcher and data are all still there.
4. **Purge without a terminal.** `--uninstall --purge` with no controlling terminal (for example in CI) prints `--purge needs a terminal to confirm`, exits non-zero and removes nothing.
5. **Broken install, fallback.** With `<dir>/app/node_modules` deleted, or the private Node removed and no system Node 24, `--uninstall` prints `japa can't run from <dir>; removing it directly`. It still removes the service unit (calling `systemctl --user disable --now japa` and `daemon-reload` when systemctl exists), the launcher pointing at this install, `app/` and the marked `node/`, then `<dir>` once empty. It keeps `~/.japa` and exits 0.
6. **Purge in fallback.** In fallback mode, `--purge` asks for `delete` on the terminal before removing anything, and deletes the data only on `delete`.
7. **Other launchers survive.** If `~/.local/bin/japa` points at another install, or is an `npm link` symlink, it is left untouched in both modes.
8. **Foreign files survive.** A `node/` without the `.japa-node` marker, or any extra file under `<dir>`, is left in place, and `<dir>` is then kept because it isn't empty.
9. **Not a japa checkout.** If `<dir>/app` exists but isn't a japa checkout, `--uninstall` refuses with the "isn't a japa checkout" message, exits 1 and touches nothing.
10. **Nothing installed.** `--uninstall --dir /some/empty/place` prints `no japa install at …` and exits 0.
11. **`--purge` alone.** `--purge` without `--uninstall` fails with `--purge only works with --uninstall` and installs nothing.
12. **PATH line named.** If install.sh had added a PATH line to `~/.bashrc`, the uninstall output names `~/.bashrc` and the file is unchanged.
13. **Install behaviour unchanged.** Running install.sh without `--uninstall` behaves exactly as before: a fresh install, the upgrade path on a re-run, and cleanup on failure.
14. **Checks pass.** `sh -n install.sh`, `npm test` and `npm run typecheck` pass.
