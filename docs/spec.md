# japa — Docker hosting (Sysbox system containers, named instances)

Status: spec for an incremental change to the existing japa product (repo `Darryl-Shi/japa`). The builder records the outcome in `docs/spec.md` and in the README (Install, Running, Where state lives, Uninstall).

## 1. Purpose

japa currently installs only "natively": a git checkout under `~/.local/share/japa`, a `~/.local/bin/japa` launcher, `~/.japa` data, a systemd user service, bubblewrap for jobs, and the host's Docker for the desktop. This change adds **Docker hosting**:

- **One installer, two modes.** `install.sh` asks whether to install natively or via Docker. Docker is the default.
- **Docker is a hosting backend, not a code path.** Each japa runs in its own Sysbox system container. That container is a small Linux machine with systemd as init, its own private dockerd and working bubblewrap. Inside it, japa is installed and runs exactly as it does natively today, with the same code, layout, service, update, sandbox and desktop. The kernel, the extensions, the CLI commands and the SDK contracts don't know or care whether they run in a container. There are no docker-specific adapters or branches in `src/` or `extensions/`.
- **Nothing outside the container.** A Docker instance keeps all of its state (app checkout, `~/.japa`, the user's home, the inner Docker's images and containers) in named Docker volumes. It never bind-mounts host paths and never talks to the host's Docker socket. Only two things exist on the host: the container with its volumes and network, and a host-side launcher script.
- **Multitenancy.** One operator can run several independent japas on one machine, one per tenant, each a named instance with its own container, volumes, network, settings, secrets, models, Telegram bot and desktop.

## 2. Key decisions

| Question | Decision |
|---|---|
| Container runtime | **Sysbox** (`--runtime=sysbox-runc`), never `--privileged` and never the host's docker.sock. Each instance is unprivileged and isolated from the host and from the other instances. |
| What runs inside | A system container image with systemd as PID 1, plus Node 24, git, tar, curl, bubblewrap, Docker Engine and the japa desktop's requirements. A non-root user `japa` (uid 1000) is in the inner `docker` group and has systemd lingering enabled. |
| How japa is installed inside | By the **native** install path of the same `install.sh`, run as user `japa` inside the container (git clone into `/home/japa/.local/share/japa/app`, launcher at `/home/japa/.local/bin/japa`, data in `/home/japa/.japa`). |
| Service | The existing `japa service` systemd **user** unit, running under the container's own systemd. The container uses `--restart unless-stopped`, so japa comes back after a host reboot. |
| Updates | Unchanged: `japa update` and Telegram `/update` (git fast-forward, validate, roll back, restart through `systemd-run --user`) run inside the container. |
| Jobs sandbox | Unchanged bubblewrap, which works inside a Sysbox container. The inner `/var/run/docker.sock` is masked from jobs by the existing rules. |
| Desktop | Unchanged desktop extension, using the **inner** dockerd. Its image and container live in the instance's docker volume. |
| Tenancy model | **Operator-managed named instances.** One admin with host Docker access creates and manages instances. Tenants reach their japa through Telegram, or through a shell the admin opens for them in their own container. |
| Image source | Built locally on the host from the repo's `docker/` directory at the installed branch, using a git build context. No registry dependency. |

## 3. Host-side shape of a Docker instance

For an instance named `<name>`:

| Thing | Name / value |
|---|---|
| Container | `japa-<name>`, labels `japa.instance=<name>`, `japa.branch=<branch>`, `japa.desktopPort=<port>` |
| Volumes | `japa-<name>-home` → `/home/japa` (app checkout, `~/.japa`, the rest of the home); `japa-<name>-docker` → `/var/lib/docker` (inner images and containers, including the desktop and its home volume) |
| Network | `japa-<name>-net`, a user-defined bridge used by that instance only, so instances can't reach each other's ports |
| Image | `japa-host:<branch>`, built from `docker/` in the repo |
| Ports | One host port, `127.0.0.1:<desktop port>`, forwarded to the instance's noVNC. Nothing else is published. |

- **Instance names** match `[a-z0-9][a-z0-9-]*`. The default is the host `$USER`, lower-cased and sanitised. The installer refuses to create an instance whose name is already used by a container that is not a japa instance.
- **Desktop port.** The default is the first free port from 6080 upward that no other japa instance has claimed (`--desktop-port <n>` overrides it). It is recorded in the container label.
  - Inside the container, the image forwards that published port to the desktop's noVNC on the container's loopback. japa's own `extensions.desktop` settings and defaults are not changed.
  - To reach it from another machine: `ssh -L <port>:localhost:<port> <server>`.
- **Persistence across recreation.** Recreating the container from a newer image keeps both volumes. Software installed with apt in the container's root filesystem is lost, everything under `/home/japa` and the inner Docker state are kept. This mirrors the desktop's existing contract.

## 4. The installer (`install.sh`)

### 4.1 Mode choice

- **New flag** `--mode <docker|native>`, with env var `JAPA_INSTALL_MODE`.
- **Without the flag, on a fresh install:**
  - With a terminal, the installer asks "Install japa via Docker (recommended) or natively?" and Enter picks Docker.
  - Without a terminal it uses Docker.
- **An existing native install** at `--dir` is upgraded natively, exactly as today, without asking.
- **An existing Docker instance** of the chosen name is upgraded (§4.4), without asking.
- **Native mode** is today's installer, byte-for-byte in behaviour, plus the new flag parsing.

### 4.2 Docker mode prerequisites

Checked in order. Each failure names the problem and how to fix it.

1. **Linux on x64 or arm64**, as today.
2. **Docker present and usable** by the invoking user (`docker info` succeeds). If not, the installer prints the existing guidance: install Docker, or `sudo usermod -aG docker $USER` and log in again.
3. **The Sysbox runtime is registered** with the host's Docker (`sysbox-runc` appears in `docker info`'s runtimes).
   - If it's missing on a supported distro (Ubuntu or Debian, with the Sysbox `.deb` available for the architecture), the installer offers to install it.
     - This needs sudo, so the installer asks first.
     - It warns that installing Sysbox restarts the host's Docker daemon, which briefly stops running containers.
     - Enter means yes in a terminal. Without a terminal it only installs Sysbox with `--install-sysbox`.
   - Otherwise (unsupported distro, declined, or a failed install) it explains what's missing and links Sysbox's install docs.
     - In a terminal it then offers to install natively instead.
     - Without a terminal it exits non-zero.

### 4.3 Docker mode fresh install

1. **Build the host image** `japa-host:<branch>` from the repo's `docker/` directory at `--branch`, using a git build context (`--repo` and `--branch` are honoured).
2. **Create the instance resources:** the network and the two volumes, then start `japa-<name>` with `--runtime=sysbox-runc`, `--restart unless-stopped`, the hostname `japa-<name>` and the desktop port. The installer waits for the container's systemd to reach a running state.
3. **Install japa inside.** Run the native install inside the container as user `japa` with `--mode native --skip-setup` (same `--repo` and `--branch`). This clones, runs `npm ci` and writes the inner launcher.
4. **Write the host launcher** to `~/.local/bin/japa` (§5). Add the PATH line exactly as today. A native launcher already there is not overwritten without asking (§5.3).
5. **Setup.** With a terminal, run `japa --instance <name> setup` through the host launcher, so the wizard runs inside the container and installs the service there. Without a terminal, or with `--skip-setup` or `--non-interactive`, it prints `run \`japa --instance <name> setup\` to finish`.

If any step fails or is interrupted, the installer names the step. It removes the container, volumes, network and launcher entry that this run created, and nothing that existed before.

### 4.4 Re-running on an existing instance

Re-running `install.sh --mode docker [--instance <name>]` on an existing instance upgrades it:

- **Base image.** It rebuilds `japa-host:<branch>`. If the image changed, it recreates the container with the same name, volumes, network, labels and port. The volumes are kept.
- **japa itself.** It then runs `japa update` inside, exactly as a native re-run does.

### 4.5 New flags

| Flag | Env | Default | What it does |
|---|---|---|---|
| `--mode <docker\|native>` | `JAPA_INSTALL_MODE` | `docker` (asked in a terminal) | How to install |
| `--instance <name>` | `JAPA_INSTANCE` | `$USER` (sanitised) | Docker instance to create or upgrade |
| `--desktop-port <n>` | | first free from 6080 | Host port for the instance's noVNC |
| `--install-sysbox` | | off | Allow installing Sysbox without asking (needs sudo) |

The existing flags (`--dir`, `--branch`, `--repo`, `--non-interactive`, `--no-service`, `--skip-setup`) keep their meaning. In Docker mode, `--dir` is ignored (a note is printed), and `--no-service` and `--non-interactive` are passed through to the setup inside the container.

## 5. The host launcher in Docker mode

### 5.1 Forwarding

`~/.local/bin/japa` becomes a small POSIX sh script that forwards commands into an instance.

- **Command:** `docker exec` as user `japa`, with `-i` always and `-t` when stdin is a terminal, into `japa-<instance>`, running the inner launcher with the same arguments.
- **Environment it sets:** `XDG_RUNTIME_DIR` and `DBUS_SESSION_BUS_ADDRESS` for uid 1000, so that `systemctl --user`, `japa service *`, `systemd-run --user` and `/update` all work. It also passes `TERM`, `LANG` and `TZ` through.
- **Exit status:** the inner command's exit status is the launcher's.

So `japa chat`, `japa setup`, `japa status`, `japa service logs`, `japa update`, `japa check`, `japa rollback`, `japa safe-mode` and `japa --version` all behave as they do natively. The masked secret prompts, the TUI and Ctrl-C/Esc handling work over the TTY.

### 5.2 Choosing the instance

The launcher picks the instance in this order:

1. `--instance <name>` as the first argument (stripped before forwarding).
2. `JAPA_INSTANCE`.
3. The only japa instance on the host, found by the container label `japa.instance`.
4. The instance named after `$USER`.

If none of these applies, it lists the instances and asks for `--instance`. If the chosen container exists but is stopped, it is started first. If it doesn't exist, the launcher says so and lists the existing instances.

### 5.3 Host-only subcommands

These are handled by the launcher and never forwarded:

| Command | What it does |
|---|---|
| `japa instances` | Lists each instance: name, state (running or stopped), branch, inner japa version (`japa --version` when running) and its noVNC URL `http://127.0.0.1:<port>/vnc.html` |
| `japa [--instance n] shell` | An interactive login shell as `japa` inside the container. This is how an admin hands a tenant a shell, or inspects `~/.japa` |
| `japa [--instance n] uninstall [--purge]` | Stops and removes the container and network. Prints that the data is kept in the two named volumes. With `--purge`, it deletes the volumes once the admin types the instance name to confirm. The launcher is removed when no instances remain. |

### 5.4 Native and Docker installs on the same machine

Native and Docker installs can coexist on one host, but only one owns `~/.local/bin/japa`.

- A Docker install over a native launcher asks before replacing it. If declined, the Docker launcher is written as `~/.local/bin/japa-docker` instead.
- A native install leaves an existing Docker launcher alone in the same way.

## 6. Inside the container

- **No source changes for container awareness.** `src/kernel`, `extensions/*` and the CLI commands have none. Existing behaviour that depends on the environment (the bwrap probe, the desktop's Docker checks, the systemd availability check in setup, update launch via `systemd-run`, and service detection) simply finds a normal Linux machine.
- **The image** (`docker/Dockerfile` plus its support files) provides:
  - systemd as init;
  - dockerd enabled as a system service;
  - the `japa` user with lingering;
  - Node 24 on PATH, so the native installer uses it rather than downloading a private Node;
  - bubblewrap, git, tar and curl;
  - the noVNC port forward (§3).
- **Google sign-in** uses the existing paste-the-redirect-URL fallback, because the OAuth loopback isn't reachable from the host browser. This is the same as over SSH today.
- **Inner Docker state stays in the instance.** The desktop's image builds and its home volume live in the inner Docker, so they are per instance and survive container recreation through `japa-<name>-docker`.

## 7. Out of scope

- Rootless Docker on the host, Podman, Kubernetes and macOS hosts.
- A `--privileged` fallback.
- Publishing images to a registry.
- Per-instance CPU or memory limits for the outer container.
- Tenants managing their own instances without host Docker access.
- Migrating an existing native install's `~/.japa` into a container.

## 8. Testing

- **Unit tests** (`vitest`, always run) cover the installer's mode selection, flags and refusal paths, and the host launcher's instance resolution and argument forwarding. Both are exercised with a fake `docker` on PATH.
- **End-to-end tests** create real Sysbox instances. They are gated behind `JAPA_SYSBOX_TESTS=1` and need Sysbox on the host, as the existing desktop Docker tests are gated behind `JAPA_DOCKER_TESTS=1`.

## Acceptance behaviours

1. On a Linux host with Docker and Sysbox, `curl -fsSL …/install.sh | sh` in a terminal asks native or Docker. Pressing Enter installs via Docker, runs the setup wizard, and leaves `japa chat` answering. `docker ps` shows `japa-$USER` running with runtime `sysbox-runc`, and no japa-related file or directory was created on the host other than `~/.local/bin/japa` (and the PATH line in the shell rc, if needed).
2. `docker inspect japa-$USER` shows no bind mounts and no host docker.sock: only the volumes `japa-$USER-home` and `japa-$USER-docker`, the network `japa-$USER-net`, and one published port on `127.0.0.1`.
3. Inside a Docker instance, `japa status` shows the model and extensions. `japa service status` reports the systemd user service as active. A job started by the CoS runs under bubblewrap, and `japa status` reports no "Jobs can't run" error.
4. Asking the CoS to use the desktop works in a Docker instance: the desktop image builds in the instance's own dockerd, and `http://127.0.0.1:<desktop port>/vnc.html` on the host shows it. On the host, `docker ps` does not list a desktop container.
5. `install.sh --mode docker --instance alice` followed by `--instance bob` creates two instances. Each has its own setup, secrets, Telegram bot and desktop port. `japa instances` lists both. `japa --instance alice chat` talks only to alice's japa, and a secret set in bob is absent from alice's `japa --instance alice shell` view of `~/.japa/secrets`.
6. With exactly one instance on the host, plain `japa chat` reaches it. With two instances and no `$USER` match, `JAPA_INSTANCE`, or `--instance`, `japa chat` exits non-zero and lists the instance names.
7. `docker restart japa-alice` (or a host reboot) brings alice's japa back up answering `japa --instance alice chat`, with its conversation history intact.
8. `/update` from Telegram in a Docker instance updates japa inside the container, restarts its service, and reports the result in the chat, the same as natively. `japa --instance alice update --check` lists incoming commits.
9. Re-running the installer for an existing instance after the image definition changes recreates the container. Settings, secrets, history, jobs' workspace changes and the desktop's browser logins are all kept.
10. `japa --instance alice uninstall` removes alice's container and network but keeps both volumes, and says so. Re-running the installer for `alice` brings it back with its data. `uninstall --purge` (after typing `alice`) removes the volumes too.
11. Without Sysbox and without a terminal, `install.sh` (default Docker mode) exits non-zero with a message naming Sysbox and how to install it. In a terminal, declining the Sysbox install offers the native install instead.
12. `install.sh --mode native` behaves exactly as the installer did before this change. Re-running the installer over an existing native install upgrades it natively without asking about the mode.
13. `git grep -n -i "docker\|sysbox\|container"` in `src/` shows no new code paths that branch on running inside a container; only the pre-existing bwrap docker-socket masking appears.

## Outcome

Built as specified, with no container-aware code in `src/` or `extensions/`. What exists and the decisions taken:

**Files.** `install.sh` gained `--mode`/`JAPA_INSTALL_MODE`, `--instance`/`JAPA_INSTANCE`, `--desktop-port` and `--install-sysbox`, the Docker-mode functions (prerequisites, image build, instance creation, upgrade, cleanup) and the host launcher, embedded as `docker_launcher_text()`. `docker/Dockerfile` (Ubuntu 24.04, systemd as `/sbin/init`, Docker CE from Docker's apt repo, Node 24 from NodeSource, bubblewrap, git, socat; the `japa` user, uid 1000, in the `docker` group with lingering; udev/console units masked and journald not reading `/dev/kmsg`) and `docker/japa-novnc-forward.service`. README: Requirements, Install (Native install, Docker install, Installer flags), Non-interactive setup, Running → Docker instances, Updating, Uninstall, Where state lives → Docker instances, Development.

**Decisions.**

| Topic | Decision |
|---|---|
| Desktop port forward | The container publishes `127.0.0.1:<port>` → container port **16080**, where `japa-novnc-forward.service` (`socat TCP-LISTEN:16080,fork,reuseaddr TCP:127.0.0.1:6080`) forwards to the desktop noVNC the inner dockerd publishes on the container's loopback at japa's default 6080. `extensions.desktop` is unchanged. |
| Default desktop port | First port from 6080 up that no other instance claims (`japa.desktopPort` labels) and nothing listens on (read from `/proc/net/tcp{,6}`). An explicit `--desktop-port` claimed by another instance is refused. A re-run keeps the recorded port unless `--desktop-port` is given. |
| Booted check | `systemctl is-system-running` inside the container may report `running` **or `degraded`** (some unit failed, e.g. one that can't work in a container); both count as booted. Timeout 180 s in the installer, 120 s when the launcher starts a stopped instance. |
| `--repo` in Docker mode | Must be a URL (`http(s)://`, `git://`, `ssh://`, `git@`): the image is built from a git build context `<repo>#<branch>:docker` and the container clones the repo itself, so neither can use a host path. Anything else is refused before changes are made. |
| Install inside | `docker exec -u japa` into the container clones `install.sh`'s repo at `--branch` into a temp dir and runs `install.sh --mode native --skip-setup --repo <repo> [--branch <b>]`; `--branch` is forwarded on a fresh install or when given explicitly. On a re-run the same command takes the native upgrade path (`japa update`). |
| Instance detection | An instance "exists" if its container carries `japa.instance=<name>` or its `japa-<name>-home` volume exists (so an instance removed by `japa uninstall` is re-created with its data by a re-run). Without `--mode`, an existing native `<dir>/app` wins, then an existing instance, then the question (tty) or Docker (no tty). |
| Upgrade | Rebuild the image; recreate the container only if the image id, the branch label or the requested port changed (or the container is gone); else just start it if stopped. The branch defaults to the container's `japa.branch` label, not `main`. An upgrade failure names the step but removes nothing. |
| Fresh-install cleanup | An EXIT trap (with INT/TERM/HUP turned into exits) removes only the container, `-home`/`-docker` volumes, network and launcher file this run created, then reports `install failed at: <step>` (steps: image, instance, install japa inside, launcher). Setup failing afterwards doesn't undo the install. |
| Image tag | `japa-host:<branch>` with every character outside `A-Za-z0-9_.-` replaced by `-` (e.g. `feat/x` → `japa-host:feat-x`). The image is shared by instances on that branch and isn't removed by uninstall. |
| Instance name | `[a-z0-9][a-z0-9-]*`; the default is `$USER` lower-cased, other characters → `-`, leading `-` stripped (`japa` if empty). The same sanitisation picks the `$USER` instance in the launcher. |
| Launcher coexistence | The Docker launcher is marked by the line `# japa-docker-launcher`. Docker over a native launcher asks `[y/N]` (**default no**); declined or without a tty, the Docker launcher is `~/.local/bin/japa-docker`. Native over a Docker launcher asks `[y/N]` (default no); otherwise `~/.local/bin/japa-native`. Existing `japa-docker`/`japa-native` launchers are reused on re-runs. Native `japa uninstall` only removes `~/.local/bin/japa`, so a `japa-native` launcher is left for the user to remove. |
| Launcher environment | `docker exec -i [-t when stdin is a tty] -u japa -w /home/japa` with `HOME`, `USER`, `XDG_RUNTIME_DIR=/run/user/1000`, `DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus`, and `TERM`, `LANG`, `TZ` passed through; nothing else. Non-interactive setup therefore sets `JAPA_PROVIDER`/`JAPA_MODEL`/`JAPA_API_KEY` inside via `japa --instance <n> shell -c '…'` (`shell` passes its arguments to `bash -l`). |
| Launcher uninstall | `japa [--instance n] uninstall [--purge]`: removes the container and `japa-<n>-net`, reports the kept volumes; `--purge` needs a tty and the typed instance name. The launcher deletes itself when no instance containers remain (and only if it carries the marker). |
| `--non-interactive`, `--no-service`, `--dir` | In Docker mode `--non-interactive` (like `--skip-setup` or no tty) skips setup and prints `run \`japa --instance <n> setup\` to finish`; `--no-service` is passed to the setup run inside; `--dir` is ignored with a printed note. |
| Sysbox | Offered on Ubuntu/Debian (by `ID`/`ID_LIKE` in `/etc/os-release`, with `apt-get`) as the **Sysbox CE 0.7.1** `.deb` from the nestybox GitHub release, verified against a **pinned sha256** per arch (amd64, arm64), installed with `sudo apt-get install -y`, then re-checked in `docker info`'s runtimes. In a tty: warning that Docker restarts, `[Y/n]`; without one only with `--install-sysbox`, else exit non-zero naming Sysbox, `--install-sysbox` and the install docs. When still missing, a tty user is offered the native install `[Y/n]`. |
| Native mode | Unchanged apart from flag parsing and the launcher-coexistence check. The fresh default became Docker, so the existing installer tests set `JAPA_INSTALL_MODE=native`. |
| Tests | Unit tests with a fake `docker` on PATH (`test/install-docker.test.ts`, using the undocumented `JAPA_OS_RELEASE`, `JAPA_PROC_NET`, `JAPA_SYSBOX_BASE_URL` overrides); end to end `JAPA_SYSBOX_TESTS=1 npx vitest --run test/sysbox.test.ts`, against `JAPA_SYSBOX_TEST_REPO`/`JAPA_SYSBOX_TEST_BRANCH` (default the GitHub repo, `main`). |
