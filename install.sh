#!/bin/sh
# japa bootstrap: curl -fsSL https://raw.githubusercontent.com/Darryl-Shi/japa/main/install.sh | sh
# See docs/superpowers/specs/2026-10-08-japa-install-design.md §3 and docs/spec.md (installer menu, Docker hosting).
# With a terminal (and without --non-interactive) it first shows a menu: Install, Update, Uninstall, Quit. Without
# one it installs fresh, or upgrades an existing install (§3.1 step 3), and never uninstalls. Install and Update
# never touch $JAPA_HOME (~/.japa by default); Uninstall deletes it only when asked and confirmed with "delete".
# Two modes (docs/spec.md, "Docker hosting"): --mode native is the install above; --mode docker (the default for a
# fresh install) runs each japa in its own Sysbox system container, where this same script's native mode installs it.
set -eu

# Wrapped in main(), invoked by the last line: under `curl | sh` a stream truncated mid-download then parses to
# a prefix of function definitions and never reaches the final `main "$@"`, so nothing destructive ever runs.
main() {

# dash runs the EXIT trap only on exit, not when a signal kills it: turn Ctrl-C, a closed terminal or a kill into
# an exit, so a fresh install interrupted mid-way still removes what it created.
trap 'exit 130' INT TERM HUP

say() {
  printf '==> %s\n' "$1"
}

say_err() {
  printf '==> %s\n' "$1" >&2
}

# A controlling terminal (or, in tests only, JAPA_INSTALL_TTY's stand-in) for the menu, prompts and setup.
TTY="${JAPA_INSTALL_TTY:-/dev/tty}"
# 1 once the menu has opened $TTY on fd 3; every terminal read then goes through fd 3.
HAVE_MENU=0
# `[ -r /dev/tty ]` only checks the device node's permissions (always 0666), not whether this process has a
# controlling terminal to open -- under `curl | sh` in CI/Docker/cloud-init there is none, so probe the open.
has_tty() {
  (exec 3<"$TTY") 2>/dev/null
}

# Asks $1 on the terminal and reads the answer into ANSWER. Only call it when has_tty.
ask() {
  ANSWER=""
  if [ "$HAVE_MENU" -eq 1 ]; then
    printf '%s ' "$1" >&4
    IFS= read -r ANSWER <&3 || ANSWER=""
  else
    printf '%s ' "$1" >/dev/tty
    IFS= read -r ANSWER </dev/tty || ANSWER=""
  fi
}

# Asks a yes/no question $1 on the terminal; $2 (y or n) is what Enter means. Succeeds for yes.
confirm() {
  while :; do
    ask "$1"
    case "$ANSWER" in
      "") [ "$2" = y ] && return 0 || return 1 ;;
      y | Y | yes | Yes | YES) return 0 ;;
      n | N | no | No | NO) return 1 ;;
    esac
  done
}

# Wraps $1 in single quotes for POSIX sh, escaping an embedded ' the same way src/cli/layout.ts's shellQuote does.
# Pure parameter expansion (no sed/awk) so this behaves identically everywhere POSIX sh runs.
shell_quote() {
  value=$1
  result=""
  rest=$value
  while [ -n "$rest" ]; do
    case "$rest" in
      *\'*)
        before=${rest%%\'*}
        result="$result$before'\\''"
        rest=${rest#*\'}
        ;;
      *)
        result="$result$rest"
        rest=""
        ;;
    esac
  done
  printf "'%s'" "$result"
}

# The launcher script's text: must stay byte-identical to src/cli/layout.ts's launcherText().
write_launcher() {
  node_bin=$1
  app_dir=$2
  printf '#!/bin/sh\nexec %s --disable-warning=ExperimentalWarning %s "$@"\n' "$(shell_quote "$node_bin")" "$(shell_quote "$app_dir/src/cli/main.ts")"
}

fetch() {
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL "$1"
  else
    wget -qO- "$1"
  fi
}

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    shasum -a 256 "$1" | awk '{print $1}'
  fi
}

# Sets NODE_BIN to an absolute path of a Node >= 24: the one on PATH if it qualifies and has npm, else japa's
# private Node in $NODE_DIR -- the one a previous run left there when it's still good (a rerun doesn't download it
# again), else a fresh download (design doc §3.1 step 5).
NODE_BIN=""
ensure_node() {
  system_node=$(command -v node 2>/dev/null || true)
  if [ -n "$system_node" ] && node_ok "$system_node" && has_npm "$system_node"; then
    NODE_BIN=$system_node
    return 0
  fi
  if [ -e "$NODE_DIR/$NODE_MARKER" ] && node_ok "$NODE_DIR/bin/node"; then
    NODE_BIN="$NODE_DIR/bin/node"
    return 0
  fi
  download_node
}

# Whether the node binary $1 runs and is version 24 or newer.
node_ok() {
  node_version=$("$1" -p 'process.versions.node' 2>/dev/null) || return 1
  [ "${node_version%%.*}" -ge 24 ] 2>/dev/null
}

# Whether `npm ci` can run for the node binary $1: npm beside it, or on PATH (distros may package npm separately).
has_npm() {
  [ -x "$(dirname "$1")/npm" ] || command -v npm >/dev/null 2>&1
}

# A node/ is japa's own private Node only if it holds this marker (src/cli/node.ts's NODE_MARKER): any other
# node/ under the install dir is the user's, and is never replaced or removed.
NODE_MARKER=.japa-node

download_node() {
  if [ -e "$NODE_DIR" ] && [ ! -e "$NODE_DIR/$NODE_MARKER" ]; then
    say_err "$NODE_DIR exists and wasn't installed by japa; remove it or choose another --dir"
    exit 1
  fi
  say "Downloading Node.js"
  node_ver=$(cat "$APP_DIR/.node-version")
  dist="${OS}-${ARCH}"
  name="node-v${node_ver}-${dist}.tar.gz"
  base_url="${NODE_DIST_BASE_URL}/v${node_ver}"
  tmp_tar="$DIR/node-download.tar.gz"

  if ! fetch "$base_url/$name" >"$tmp_tar"; then
    rm -f "$tmp_tar"
    say_err "could not download $base_url/$name"
    exit 1
  fi
  if ! shasums=$(fetch "$base_url/SHASUMS256.txt"); then
    rm -f "$tmp_tar"
    say_err "could not download $base_url/SHASUMS256.txt"
    exit 1
  fi
  expected=$(printf '%s\n' "$shasums" | awk -v n="$name" '{ fn = $2; sub(/^\*/, "", fn); if (fn == n) { print $1; exit } }')
  if [ -z "$expected" ]; then
    rm -f "$tmp_tar"
    say_err "$name is not in SHASUMS256.txt"
    exit 1
  fi
  actual=$(sha256_of "$tmp_tar")
  if [ "$(printf '%s' "$expected" | tr 'A-F' 'a-f')" != "$(printf '%s' "$actual" | tr 'A-F' 'a-f')" ]; then
    rm -f "$tmp_tar"
    say_err "checksum mismatch for $name"
    exit 1
  fi

  NODE_CREATED=1
  rm -rf "$NODE_DIR"
  mkdir -p "$NODE_DIR"
  tar -xzf "$tmp_tar" -C "$NODE_DIR" --strip-components=1
  : >"$NODE_DIR/$NODE_MARKER"
  rm -f "$tmp_tar"
  NODE_BIN="$NODE_DIR/bin/node"
}

# When ~/.local/bin isn't on PATH, adds it in the shell's rc file.
ensure_path_line() {
  case ":$PATH:" in
    *":$HOME/.local/bin:"*) ;;
    *)
      case "${SHELL:-}" in
        */zsh)
          rcfile="$HOME/.zshrc"
          line='export PATH="$HOME/.local/bin:$PATH"'
          ;;
        */fish)
          rcfile="$HOME/.config/fish/config.fish"
          line='fish_add_path $HOME/.local/bin'
          ;;
        *)
          rcfile="$HOME/.bashrc"
          line='export PATH="$HOME/.local/bin:$PATH"'
          ;;
      esac
      if [ ! -f "$rcfile" ] || ! grep -qF "$line" "$rcfile"; then
        mkdir -p "$(dirname "$rcfile")"
        printf '%s\n' "$line" >>"$rcfile"
        say "added PATH line to $rcfile"
      fi
      echo 'open a new shell or run: export PATH="$HOME/.local/bin:$PATH"'
      ;;
  esac
}

# --- Docker mode (docs/spec.md, "Docker hosting") ---
# Each instance <name> is the Sysbox system container japa-<name>, its volumes japa-<name>-home (/home/japa) and
# japa-<name>-docker (/var/lib/docker), its network japa-<name>-net and the image japa-host:<branch>; inside it,
# japa is installed by this script's native mode and runs exactly as it does natively.

# Undocumented overrides for test/install-docker.test.ts, like JAPA_NODE_DIST above.
OS_RELEASE="${JAPA_OS_RELEASE:-/etc/os-release}"
PROC_NET="${JAPA_PROC_NET:-/proc/net}"
SYSBOX_VERSION=0.7.1
SYSBOX_BASE_URL="${JAPA_SYSBOX_BASE_URL:-https://github.com/nestybox/sysbox/releases/download/v$SYSBOX_VERSION}"
SYSBOX_SHA256_AMD64=9d6d5484f980d0a17f86c492c1262015c2afb66280bdb97215b79fde6a0261c5
SYSBOX_SHA256_ARM64=04ca894ae0b53f0fa54eaacc173ce40363c9a95ea5450f773716a84ef650a69b
SYSBOX_DOCS="https://github.com/nestybox/sysbox/blob/master/docs/user-guide/install-package.md"
# The port the image forwards to the desktop's noVNC on its loopback (docker/japa-novnc-forward.service).
NOVNC_FORWARD_PORT=16080
# The port the image forwards to japa's web UI on its loopback, 127.0.0.1:7337 (docker/japa-webui-forward.service).
WEBUI_FORWARD_PORT=17337
DOCKER_LAUNCHER_MARKER="# japa-docker-launcher"

# A host $USER as an instance name: lower-cased, anything outside [a-z0-9-] as "-", starting with [a-z0-9].
sanitize_name() {
  name=$(printf '%s' "$1" | tr 'A-Z' 'a-z' | tr -c 'a-z0-9-' '-')
  while [ "${name#-}" != "$name" ]; do name=${name#-}; done
  if [ -z "$name" ]; then name=japa; fi
  printf '%s' "$name"
}

valid_name() {
  case "$1" in
    "" | [!a-z0-9]* | *[!a-z0-9-]*) return 1 ;;
  esac
  return 0
}

# Whether $1 is a launcher this script wrote for Docker mode.
is_docker_launcher() {
  [ -f "$1" ] && grep -qF "$DOCKER_LAUNCHER_MARKER" "$1" 2>/dev/null
}

# Whether the Docker instance $INSTANCE exists: its container, or its home volume (kept by `japa uninstall`).
docker_instance_exists() {
  command -v docker >/dev/null 2>&1 || return 1
  valid_name "$INSTANCE" || return 1
  label=$(docker container inspect -f '{{index .Config.Labels "japa.instance"}}' "japa-$INSTANCE" 2>/dev/null) || label=""
  [ "$label" = "$INSTANCE" ] && return 0
  docker volume inspect "japa-$INSTANCE-home" >/dev/null 2>&1
}

sysbox_registered() {
  docker info --format '{{json .Runtimes}}' 2>/dev/null | grep -q '"sysbox-runc"'
}

# Ubuntu or Debian with apt: where Sysbox's .deb installs (for x64 and arm64, the only arches japa runs on).
sysbox_installable() {
  [ -r "$OS_RELEASE" ] || return 1
  command -v apt-get >/dev/null 2>&1 || return 1
  ids=$(. "$OS_RELEASE" >/dev/null 2>&1; printf '%s %s' "${ID:-}" "${ID_LIKE:-}")
  case " $ids " in
    *" ubuntu "* | *" debian "*) return 0 ;;
  esac
  return 1
}

install_sysbox() {
  case "$ARCH" in
    x64) deb_arch=amd64; expected=$SYSBOX_SHA256_AMD64 ;;
    *) deb_arch=arm64; expected=$SYSBOX_SHA256_ARM64 ;;
  esac
  name="sysbox-ce_${SYSBOX_VERSION}.linux_${deb_arch}.deb"
  tmp_dir=$(mktemp -d)
  say "Downloading Sysbox $SYSBOX_VERSION"
  if ! fetch "$SYSBOX_BASE_URL/$name" >"$tmp_dir/$name"; then
    rm -rf "$tmp_dir"
    say_err "could not download $SYSBOX_BASE_URL/$name"
    return 1
  fi
  if [ "$(sha256_of "$tmp_dir/$name")" != "$expected" ]; then
    rm -rf "$tmp_dir"
    say_err "checksum mismatch for $name"
    return 1
  fi
  say "Installing Sysbox (sudo apt-get install); Docker restarts"
  status=0
  sudo apt-get install -y "$tmp_dir/$name" || status=$?
  rm -rf "$tmp_dir"
  [ "$status" -eq 0 ] || return 1
  sysbox_registered
}

# §4.2: Docker usable by this user, and the Sysbox runtime registered with it. Offers to install Sysbox, and when
# it's still missing, in a terminal, to install natively instead (MODE=native); otherwise exits non-zero.
docker_prereqs() {
  say "Checking Docker"
  if ! command -v docker >/dev/null 2>&1; then
    say_err "Docker is required to install japa via Docker: install it (https://docs.docker.com/engine/install/), or install natively with --mode native"
    exit 1
  fi
  if ! docker info >/dev/null 2>&1; then
    say_err "Docker isn't usable by ${USER:-this user}: install or start it, or let this user use it with \`sudo usermod -aG docker \$USER\` and log in again"
    exit 1
  fi
  say "Checking Sysbox"
  if sysbox_registered; then
    return 0
  fi
  if sysbox_installable; then
    if [ "$INSTALL_SYSBOX" -eq 1 ]; then
      if install_sysbox; then return 0; fi
    elif has_tty; then
      say "japa's Docker mode runs each japa in a Sysbox system container, and Sysbox (sysbox-runc) isn't installed."
      say "Installing it needs sudo, and restarts Docker: running containers stop briefly."
      if confirm "Install Sysbox now? [Y/n]" y; then
        if install_sysbox; then return 0; fi
      fi
    else
      say_err "japa's Docker mode needs the Sysbox runtime (sysbox-runc), which isn't registered with Docker. Re-run with --install-sysbox to install it (needs sudo, restarts Docker), install it yourself ($SYSBOX_DOCS), or install natively with --mode native"
      exit 1
    fi
  fi
  say_err "japa's Docker mode needs the Sysbox runtime (sysbox-runc), which isn't registered with Docker. Install it: $SYSBOX_DOCS"
  if has_tty && confirm "Install japa natively instead? [Y/n]" y; then
    MODE=native
    return 0
  fi
  exit 1
}

# Host TCP ports something listens on, one per line (from /proc/net/tcp and tcp6: state 0A is LISTEN).
listening_ports() {
  cat "$PROC_NET/tcp" "$PROC_NET/tcp6" 2>/dev/null | awk '
    BEGIN { for (i = 0; i < 16; i++) hex[substr("0123456789ABCDEF", i + 1, 1)] = i }
    $4 == "0A" { p = $2; sub(/.*:/, "", p); p = toupper(p); n = 0; for (i = 1; i <= length(p); i++) n = n * 16 + hex[substr(p, i, 1)]; print n }'
}

# Host ports published by japa instances other than $INSTANCE (desktop and web UI), one per line.
claimed_ports() {
  docker ps -a --filter label=japa.instance --format '{{.Label "japa.instance"}} {{.Label "japa.desktopPort"}} {{.Label "japa.webuiPort"}}' 2>/dev/null |
    awk -v me="$INSTANCE" '$1 != me { if ($2 != "") print $2; if ($3 != "") print $3 }'
}

# Whether $1 is a TCP port number, 1-65535.
valid_port() {
  case "$1" in
    "" | *[!0-9]*) return 1 ;;
  esac
  [ "$1" -ge 1 ] && [ "$1" -le 65535 ]
}

# Whether $1 is an IPv4 address in dotted-quad form (0.0.0.0 included).
valid_ipv4() {
  case "$1" in
    "" | *[!0-9.]* | .* | *. | *..*) return 1 ;;
  esac
  saved_ifs=$IFS
  IFS=.
  # shellcheck disable=SC2086 # split on the dots; only digits and dots, so no globbing
  set -- $1
  IFS=$saved_ifs
  [ "$#" -eq 4 ] || return 1
  for octet in "$@"; do
    case "$octet" in
      0?*) return 1 ;;
    esac
    [ "${#octet}" -le 3 ] && [ "$octet" -le 255 ] || return 1
  done
}

# --webui-port and --webui-bind, checked before anything is built.
check_webui_flags() {
  if [ "$WEBUI_PORT_GIVEN" -eq 1 ] && ! valid_port "$WEBUI_PORT_OPT"; then
    say_err "invalid --webui-port: $WEBUI_PORT_OPT"
    exit 1
  fi
  if [ "$WEBUI_BIND_GIVEN" -eq 1 ] && ! valid_ipv4 "$WEBUI_BIND_OPT"; then
    say_err "invalid --webui-bind: $WEBUI_BIND_OPT (use an IPv4 address, e.g. 127.0.0.1, a VPN or LAN address, or 0.0.0.0 for all)"
    exit 1
  fi
}

# Sets PORT: --desktop-port, else $1 (the instance's recorded port, on a recreate), else the first free from 6080
# (not --webui-port).
choose_port() {
  claimed=$(claimed_ports)
  if [ -n "$DESKTOP_PORT" ]; then
    case "$DESKTOP_PORT" in
      "" | *[!0-9]*)
        say_err "invalid --desktop-port: $DESKTOP_PORT"
        exit 1
        ;;
    esac
    if [ "$DESKTOP_PORT" -lt 1 ] || [ "$DESKTOP_PORT" -gt 65535 ]; then
      say_err "invalid --desktop-port: $DESKTOP_PORT"
      exit 1
    fi
    if printf '%s\n' "$claimed" | grep -qx "$DESKTOP_PORT"; then
      say_err "port $DESKTOP_PORT is already published by another japa instance; choose another with --desktop-port"
      exit 1
    fi
    PORT=$DESKTOP_PORT
  elif [ -n "${1:-}" ]; then
    PORT=$1
  else
    busy=$(listening_ports)
    PORT=6080
    while printf '%s\n%s\n%s\n' "$claimed" "$busy" "$WEBUI_PORT_OPT" | grep -qx "$PORT"; do
      PORT=$((PORT + 1))
    done
  fi
}

# Sets WEBUI_PORT and WEBUI_BIND, after choose_port: --webui-port, else $1 (the recorded port, on a recreate), else
# the first free from 7337 (not the desktop's $PORT); --webui-bind, else $2 (the recorded one), else 127.0.0.1.
choose_webui() {
  claimed=$(claimed_ports)
  if [ "$WEBUI_PORT_GIVEN" -eq 1 ]; then
    if printf '%s\n' "$claimed" | grep -qx "$WEBUI_PORT_OPT"; then
      say_err "port $WEBUI_PORT_OPT is already published by another japa instance; choose another with --webui-port"
      exit 1
    fi
    WEBUI_PORT=$WEBUI_PORT_OPT
  elif [ -n "${1:-}" ]; then
    WEBUI_PORT=$1
  else
    busy=$(listening_ports)
    WEBUI_PORT=7337
    while printf '%s\n%s\n%s\n' "$claimed" "$busy" "$PORT" | grep -qx "$WEBUI_PORT"; do
      WEBUI_PORT=$((WEBUI_PORT + 1))
    done
  fi
  if [ "$WEBUI_PORT" = "$PORT" ]; then
    say_err "the desktop and the web UI can't share port $PORT; choose another with --webui-port or --desktop-port"
    exit 1
  fi
  if [ "$WEBUI_BIND_GIVEN" -eq 1 ]; then
    WEBUI_BIND=$WEBUI_BIND_OPT
  elif [ -n "${2:-}" ]; then
    WEBUI_BIND=$2
  else
    WEBUI_BIND=127.0.0.1
  fi
}

# The web UI's URL on the host: its bind address, or loopback when it's published on every address.
webui_url() {
  if [ "$WEBUI_BIND" = 0.0.0.0 ]; then
    printf 'http://127.0.0.1:%s' "$WEBUI_PORT"
  else
    printf 'http://%s:%s' "$WEBUI_BIND" "$WEBUI_PORT"
  fi
}

# Waits for the container's systemd to finish booting (running, or degraded: some unit failed but it's up).
wait_for_systemd() {
  say "Waiting for $CONTAINER to boot"
  i=0
  state=""
  while [ "$i" -lt 180 ]; do
    state=$(docker exec "$CONTAINER" systemctl is-system-running 2>/dev/null) || true
    case "$state" in
      running | degraded) return 0 ;;
    esac
    i=$((i + 1))
    sleep 1
  done
  say_err "$CONTAINER's systemd didn't finish starting (state: ${state:-unknown})"
  return 1
}

# The image, from the repo's docker/ directory at $BRANCH, as a git build context.
build_image() {
  say "Building $IMAGE from $REPO ($BRANCH)"
  docker build -t "$IMAGE" "$REPO#$BRANCH:docker"
}

run_container() {
  say "Starting $CONTAINER"
  docker run -d --name "$CONTAINER" --hostname "$CONTAINER" --runtime=sysbox-runc --restart unless-stopped \
    --network "$NETWORK" -v "$VOL_HOME:/home/japa" -v "$VOL_DOCKER:/var/lib/docker" \
    -p "127.0.0.1:$PORT:$NOVNC_FORWARD_PORT" -p "$WEBUI_BIND:$WEBUI_PORT:$WEBUI_FORWARD_PORT" \
    --label "japa.instance=$INSTANCE" --label "japa.branch=$BRANCH" --label "japa.desktopPort=$PORT" \
    --label "japa.webuiPort=$WEBUI_PORT" --label "japa.webuiBind=$WEBUI_BIND" \
    "$IMAGE" >/dev/null
}

# Runs this script's native mode inside the container as japa, from a throwaway clone of $REPO at $BRANCH: a fresh
# install clones, runs npm ci and writes the inner launcher; an existing one runs `japa update`, as a native re-run.
install_inside() {
  set -- --mode native --skip-setup --repo "$REPO"
  if [ "$INSTALL_FRESH" -eq 1 ] || [ "$BRANCH_GIVEN" -eq 1 ]; then
    set -- "$@" --branch "$BRANCH"
  fi
  docker exec -u japa -w /home/japa -e HOME=/home/japa -e USER=japa -e XDG_RUNTIME_DIR=/run/user/1000 \
    -e DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus -e LANG -e TZ "$CONTAINER" \
    sh -c 't=$(mktemp -d) && trap "rm -rf \"\$t\"" EXIT && git clone -q --depth 1 --branch "$1" "$2" "$t/japa" && shift 2 && sh "$t/japa/install.sh" "$@"' \
    sh "$BRANCH" "$REPO" "$@"
}

# Sets HOST_LAUNCHER: ~/.local/bin/japa, unless that's a native (or other) launcher the user won't have replaced
# (§5.4), then ~/.local/bin/japa-docker.
choose_host_launcher() {
  HOST_LAUNCHER="$HOME/.local/bin/japa"
  alt="$HOME/.local/bin/japa-docker"
  if [ ! -e "$HOST_LAUNCHER" ] && [ ! -L "$HOST_LAUNCHER" ]; then return 0; fi
  if is_docker_launcher "$HOST_LAUNCHER"; then return 0; fi
  if is_docker_launcher "$alt"; then
    HOST_LAUNCHER=$alt
    return 0
  fi
  if has_tty && confirm "$HOST_LAUNCHER is another japa launcher (a native install). Replace it with the Docker launcher? [y/N]" n; then
    return 0
  fi
  HOST_LAUNCHER=$alt
  say "keeping $HOME/.local/bin/japa; the Docker launcher is $HOST_LAUNCHER"
}

write_host_launcher() {
  say "Writing launcher"
  mkdir -p "$(dirname "$HOST_LAUNCHER")"
  if [ ! -e "$HOST_LAUNCHER" ] && [ ! -L "$HOST_LAUNCHER" ]; then LAUNCHER_CREATED=1; fi
  rm -f "$HOST_LAUNCHER"
  docker_launcher_text >"$HOST_LAUNCHER"
  chmod 755 "$HOST_LAUNCHER"
  ensure_path_line
}

docker_install() {
  if [ "$DIR_GIVEN" -eq 1 ]; then
    say "note: --dir is ignored in Docker mode (japa lives in the instance's volumes)"
  fi
  if ! valid_name "$INSTANCE"; then
    say_err "invalid instance name: $INSTANCE (use lower-case letters, digits and -, starting with a letter or digit)"
    exit 1
  fi
  check_webui_flags
  case "$REPO" in
    http://* | https://* | git://* | ssh://* | git@*) ;;
    *)
      say_err "Docker mode needs --repo to be a URL Docker and the container can clone (not $REPO)"
      exit 1
      ;;
  esac
  CONTAINER="japa-$INSTANCE"
  NETWORK="japa-$INSTANCE-net"
  VOL_HOME="japa-$INSTANCE-home"
  VOL_DOCKER="japa-$INSTANCE-docker"

  existing=0
  if docker container inspect "$CONTAINER" >/dev/null 2>&1; then
    label=$(docker container inspect -f '{{index .Config.Labels "japa.instance"}}' "$CONTAINER")
    if [ "$label" != "$INSTANCE" ]; then
      say_err "a container named $CONTAINER already exists and isn't a japa instance; choose another --instance"
      exit 1
    fi
    existing=1
    if [ "$BRANCH_GIVEN" -eq 0 ]; then
      BRANCH=$(docker container inspect -f '{{index .Config.Labels "japa.branch"}}' "$CONTAINER")
      [ -n "$BRANCH" ] || BRANCH=main
    fi
  fi
  INSTALL_FRESH=1
  if [ "$existing" -eq 1 ] || docker volume inspect "$VOL_HOME" >/dev/null 2>&1; then
    INSTALL_FRESH=0
  fi
  IMAGE="japa-host:$(printf '%s' "$BRANCH" | tr -c 'A-Za-z0-9_.-' '-')"
  LAUNCHER_CREATED=0
  HOST_LAUNCHER=""

  if [ "$INSTALL_FRESH" -eq 0 ]; then
    status=0
    docker_upgrade "$existing" || status=$?
    exit "$status"
  fi

  # --- Fresh install (§4.3). On failure, remove what this run created and nothing else. ---
  NET_CREATED=0
  VOL_HOME_CREATED=0
  VOL_DOCKER_CREATED=0
  CONTAINER_CREATED=0
  STEP=""
  docker_cleanup() {
    code=$?
    trap - EXIT
    if [ "$code" -ne 0 ]; then
      if [ "$CONTAINER_CREATED" -eq 1 ]; then docker rm -f "$CONTAINER" >/dev/null 2>&1 || true; fi
      if [ "$VOL_HOME_CREATED" -eq 1 ]; then docker volume rm "$VOL_HOME" >/dev/null 2>&1 || true; fi
      if [ "$VOL_DOCKER_CREATED" -eq 1 ]; then docker volume rm "$VOL_DOCKER" >/dev/null 2>&1 || true; fi
      if [ "$NET_CREATED" -eq 1 ]; then docker network rm "$NETWORK" >/dev/null 2>&1 || true; fi
      if [ "$LAUNCHER_CREATED" -eq 1 ]; then rm -f "$HOST_LAUNCHER"; fi
      say_err "install failed at: $STEP"
    fi
    exit "$code"
  }
  trap docker_cleanup EXIT

  STEP="image"
  build_image

  STEP="instance"
  choose_port ""
  choose_webui "" ""
  if ! docker network inspect "$NETWORK" >/dev/null 2>&1; then
    NET_CREATED=1
    docker network create --label "japa.instance=$INSTANCE" "$NETWORK" >/dev/null
  fi
  VOL_HOME_CREATED=1
  docker volume create --label "japa.instance=$INSTANCE" "$VOL_HOME" >/dev/null
  if ! docker volume inspect "$VOL_DOCKER" >/dev/null 2>&1; then
    VOL_DOCKER_CREATED=1
    docker volume create --label "japa.instance=$INSTANCE" "$VOL_DOCKER" >/dev/null
  fi
  CONTAINER_CREATED=1
  run_container
  wait_for_systemd

  STEP="install japa inside"
  say "Installing japa inside $CONTAINER"
  install_inside

  STEP="launcher"
  choose_host_launcher
  write_host_launcher

  # The instance is installed; a failure past this point (setup) must not undo it.
  trap - EXIT

  launcher_name=$(basename "$HOST_LAUNCHER")
  say "japa instance $INSTANCE is installed; its desktop: http://127.0.0.1:$PORT/vnc.html"
  say "its web UI: $(webui_url) (sign in with the token from \`$launcher_name --instance $INSTANCE shell -c 'cat ~/.japa/secrets/webui.token'\`)"
  if [ "$SKIP_SETUP" -eq 1 ] || [ "$HAVE_MENU" -eq 0 ]; then
    say "Skipping setup"
    echo "run \`$launcher_name --instance $INSTANCE setup\` to finish"
  else
    say "Running setup"
    if [ "$NO_SERVICE" -eq 1 ]; then
      "$HOST_LAUNCHER" --instance "$INSTANCE" setup --no-service <&3
    else
      "$HOST_LAUNCHER" --instance "$INSTANCE" setup <&3
    fi
  fi
}

# §4.4: rebuild the image, recreate the container (same name, volumes, network, labels, ports) when it changed, its
# ports or web UI address changed, it predates the web UI's publish, or it's gone (`japa uninstall` keeps the
# volumes), then upgrade japa inside as a native re-run does.
docker_upgrade() {
  had_container=$1
  STEP="image"
  build_image || { say_err "upgrade failed at: $STEP"; return 1; }
  new_image=$(docker image inspect -f '{{.Id}}' "$IMAGE") || { say_err "upgrade failed at: $STEP"; return 1; }
  recorded_port=""
  recorded_webui_port=""
  recorded_webui_bind=""
  recreate=1
  STEP="instance"
  if [ "$had_container" -eq 1 ]; then
    recorded_port=$(docker container inspect -f '{{index .Config.Labels "japa.desktopPort"}}' "$CONTAINER")
    recorded_webui_port=$(docker container inspect -f '{{index .Config.Labels "japa.webuiPort"}}' "$CONTAINER")
    recorded_webui_bind=$(docker container inspect -f '{{index .Config.Labels "japa.webuiBind"}}' "$CONTAINER")
    old_image=$(docker container inspect -f '{{.Image}}' "$CONTAINER")
    old_branch=$(docker container inspect -f '{{index .Config.Labels "japa.branch"}}' "$CONTAINER")
    if [ "$old_image" = "$new_image" ] && [ "$old_branch" = "$BRANCH" ] &&
      { [ -z "$DESKTOP_PORT" ] || [ "$DESKTOP_PORT" = "$recorded_port" ]; } &&
      [ -n "$recorded_webui_port" ] && [ -n "$recorded_webui_bind" ] &&
      { [ "$WEBUI_PORT_GIVEN" -eq 0 ] || [ "$WEBUI_PORT_OPT" = "$recorded_webui_port" ]; } &&
      { [ "$WEBUI_BIND_GIVEN" -eq 0 ] || [ "$WEBUI_BIND_OPT" = "$recorded_webui_bind" ]; }; then
      recreate=0
    fi
  fi
  choose_port "$recorded_port"
  choose_webui "$recorded_webui_port" "$recorded_webui_bind"
  if [ "$recreate" -eq 1 ]; then
    if [ "$had_container" -eq 1 ]; then
      say "Recreating $CONTAINER from the new image (its volumes are kept)"
      docker rm -f "$CONTAINER" >/dev/null || { say_err "upgrade failed at: $STEP"; return 1; }
    fi
    if ! docker network inspect "$NETWORK" >/dev/null 2>&1; then
      docker network create --label "japa.instance=$INSTANCE" "$NETWORK" >/dev/null || { say_err "upgrade failed at: $STEP"; return 1; }
    fi
    if ! docker volume inspect "$VOL_DOCKER" >/dev/null 2>&1; then
      docker volume create --label "japa.instance=$INSTANCE" "$VOL_DOCKER" >/dev/null || { say_err "upgrade failed at: $STEP"; return 1; }
    fi
    run_container || { say_err "upgrade failed at: $STEP"; return 1; }
  elif [ "$(docker container inspect -f '{{.State.Running}}' "$CONTAINER")" != true ]; then
    say "Starting $CONTAINER"
    docker start "$CONTAINER" >/dev/null || { say_err "upgrade failed at: $STEP"; return 1; }
  fi
  wait_for_systemd || { say_err "upgrade failed at: $STEP"; return 1; }

  # Always rewritten (it's this installer's own file), so launcher changes reach hosts that only ever upgrade.
  STEP="launcher"
  choose_host_launcher
  write_host_launcher || { say_err "upgrade failed at: $STEP"; return 1; }

  STEP="update japa inside"
  say "Updating japa inside $CONTAINER"
  status=0
  install_inside || status=$?
  if [ "$status" -ne 0 ]; then
    say_err "upgrade failed at: $STEP"
    return "$status"
  fi
  say "japa instance $INSTANCE is up to date; its desktop: http://127.0.0.1:$PORT/vnc.html, its web UI: $(webui_url)"
}

# The host launcher (§5): a POSIX sh script forwarding japa commands into an instance, plus the host-only
# `instances`, `shell` and `uninstall`. One launcher serves every instance on the host.
docker_launcher_text() {
  cat <<'LAUNCHER'
#!/bin/sh
# japa-docker-launcher: forwards japa commands into a japa Docker instance (a Sysbox container japa-<name>).
# Written by install.sh --mode docker; see docs/spec.md "Docker hosting" and the README.
set -u

say_err() {
  printf 'japa: %s\n' "$1" >&2
}

# The instance names on this host, one per line (containers labelled japa.instance).
instance_names() {
  docker ps -a --filter label=japa.instance --format '{{.Label "japa.instance"}}' | sort -u
}

list_names() {
  names=$(instance_names | tr '\n' ' ')
  if [ -n "$names" ]; then
    say_err "japa instances on this host: ${names% }"
  else
    say_err "there are no japa instances on this host; install one with install.sh --mode docker"
  fi
}

sanitize_name() {
  name=$(printf '%s' "$1" | tr 'A-Z' 'a-z' | tr -c 'a-z0-9-' '-')
  while [ "${name#-}" != "$name" ]; do name=${name#-}; done
  printf '%s' "${name:-japa}"
}

has_tty() {
  (exec 3</dev/tty) 2>/dev/null
}

# Waits for the container's systemd to finish booting, after starting it.
wait_for_systemd() {
  i=0
  while [ "$i" -lt 120 ]; do
    case "$(docker exec "$1" systemctl is-system-running 2>/dev/null)" in
      running | degraded) return 0 ;;
    esac
    i=$((i + 1))
    sleep 1
  done
  say_err "$1 didn't finish starting"
  return 1
}

list_instances() {
  rows=$(docker ps -a --filter label=japa.instance --format '{{.Label "japa.instance"}}	{{.State}}	{{.Label "japa.branch"}}	{{.Label "japa.desktopPort"}}	{{.Label "japa.webuiPort"}}	{{.Label "japa.webuiBind"}}' | sort)
  if [ -z "$rows" ]; then
    echo "no japa instances on this host"
    return 0
  fi
  printf '%-16s %-8s %-12s %-32s %-31s %s\n' NAME STATE BRANCH VERSION DESKTOP "WEB UI"
  printf '%s\n' "$rows" | while IFS='	' read -r name state branch port webui_port webui_bind; do
    version=-
    if [ "$state" = running ]; then
      version=$(docker exec -u japa "japa-$name" /home/japa/.local/bin/japa --version 2>/dev/null </dev/null | head -n 1)
      [ -n "$version" ] || version=-
    else
      state=stopped
    fi
    # An instance from before the web UI was published has no japa.webuiPort; 0.0.0.0 is reachable on loopback.
    webui=-
    if [ -n "$webui_port" ]; then
      case "${webui_bind:-127.0.0.1}" in
        0.0.0.0) webui="http://127.0.0.1:$webui_port" ;;
        *) webui="http://${webui_bind:-127.0.0.1}:$webui_port" ;;
      esac
    fi
    printf '%-16s %-8s %-12s %-32s %-31s %s\n' "$name" "$state" "${branch:--}" "$version" "http://127.0.0.1:$port/vnc.html" "$webui"
  done
}

INSTANCE=""
case "${1:-}" in
  --instance)
    if [ $# -lt 2 ]; then
      say_err "--instance needs a name"
      exit 2
    fi
    INSTANCE=$2
    shift 2
    ;;
  --instance=*)
    INSTANCE=${1#--instance=}
    shift
    ;;
esac

if [ "${1:-}" = instances ]; then
  list_instances
  exit $?
fi

if [ -z "$INSTANCE" ] && [ -n "${JAPA_INSTANCE:-}" ]; then
  INSTANCE=$JAPA_INSTANCE
fi
if [ -z "$INSTANCE" ]; then
  names=$(instance_names)
  count=$(printf '%s\n' "$names" | grep -c .)
  me=$(sanitize_name "${USER:-$(id -un 2>/dev/null)}")
  if [ "$count" -eq 1 ]; then
    INSTANCE=$names
  elif printf '%s\n' "$names" | grep -qx "$me"; then
    INSTANCE=$me
  else
    if [ "$count" -eq 0 ]; then
      list_names
    else
      say_err "several japa instances: $(printf '%s' "$names" | tr '\n' ' ')- pick one with --instance <name> or JAPA_INSTANCE"
    fi
    exit 1
  fi
fi

CONTAINER="japa-$INSTANCE"
label=$(docker container inspect -f '{{index .Config.Labels "japa.instance"}}' "$CONTAINER" 2>/dev/null) || label=""
EXISTS=0
if [ -n "$label" ] && [ "$label" = "$INSTANCE" ]; then EXISTS=1; fi

if [ "${1:-}" = uninstall ]; then
  shift
  PURGE=0
  for arg in "$@"; do
    case "$arg" in
      --purge) PURGE=1 ;;
      *)
        say_err "unknown option for uninstall: $arg"
        exit 2
        ;;
    esac
  done
  HAS_VOLUMES=0
  if docker volume inspect "japa-$INSTANCE-home" >/dev/null 2>&1 || docker volume inspect "japa-$INSTANCE-docker" >/dev/null 2>&1; then
    HAS_VOLUMES=1
  fi
  if [ "$EXISTS" -eq 0 ] && [ "$HAS_VOLUMES" -eq 0 ]; then
    say_err "there is no japa instance named $INSTANCE"
    list_names
    exit 1
  fi
  if [ "$PURGE" -eq 1 ]; then
    if ! has_tty; then
      say_err "uninstall --purge needs a terminal to confirm"
      exit 1
    fi
    printf "This deletes all of %s's data: the volumes japa-%s-home and japa-%s-docker. Type the instance name to confirm: " "$INSTANCE" "$INSTANCE" "$INSTANCE" >/dev/tty
    IFS= read -r answer </dev/tty || answer=""
    if [ "$answer" != "$INSTANCE" ]; then
      say_err "not confirmed; nothing was removed"
      exit 1
    fi
  fi
  if [ "$EXISTS" -eq 1 ]; then
    docker rm -f "$CONTAINER" >/dev/null || exit 1
  fi
  docker network rm "japa-$INSTANCE-net" >/dev/null 2>&1 || true
  echo "Removed $CONTAINER and its network."
  if [ "$PURGE" -eq 1 ]; then
    docker volume rm "japa-$INSTANCE-home" "japa-$INSTANCE-docker" >/dev/null 2>&1 || true
    echo "Deleted its data: the volumes japa-$INSTANCE-home and japa-$INSTANCE-docker."
  else
    echo "Its data is kept in the volumes japa-$INSTANCE-home and japa-$INSTANCE-docker: re-run the installer with --instance $INSTANCE to bring it back, or run \`japa --instance $INSTANCE uninstall --purge\` to delete them."
  fi
  if [ -z "$(instance_names)" ] && [ -f "$0" ] && grep -qF "# japa-docker-launcher" "$0" 2>/dev/null; then
    rm -f "$0"
    echo "No japa instances remain: removed the launcher $0."
  fi
  exit 0
fi

if [ "$EXISTS" -eq 0 ]; then
  say_err "there is no japa instance named $INSTANCE"
  list_names
  exit 1
fi
if [ "$(docker container inspect -f '{{.State.Running}}' "$CONTAINER")" != true ]; then
  printf 'japa: starting %s\n' "$CONTAINER" >&2
  docker start "$CONTAINER" >/dev/null || exit 1
  wait_for_systemd "$CONTAINER" || exit 1
fi

# As uid 1000, with its user manager's runtime dir and session bus: `systemctl --user`, `japa service *`,
# `systemd-run --user` and /update work as they do natively. -t only when stdin is a terminal.
if [ -t 0 ]; then TTY=-t; else TTY=""; fi
if [ "${1:-}" = shell ]; then
  shift
  exec docker exec -i $TTY -u japa -w /home/japa -e HOME=/home/japa -e USER=japa -e XDG_RUNTIME_DIR=/run/user/1000 \
    -e DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus -e TERM -e LANG -e TZ "$CONTAINER" bash -l "$@"
fi
exec docker exec -i $TTY -u japa -w /home/japa -e HOME=/home/japa -e USER=japa -e XDG_RUNTIME_DIR=/run/user/1000 \
  -e DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus -e TERM -e LANG -e TZ "$CONTAINER" \
  /home/japa/.local/bin/japa "$@"
LAUNCHER
}

# --- Flags (design doc §3.2) ---
DIR="${JAPA_INSTALL_DIR:-$HOME/.local/share/japa}"
BRANCH="${JAPA_BRANCH:-main}"
REPO="${JAPA_REPO:-https://github.com/Darryl-Shi/japa.git}"
# Undocumented override for test/install-sh.test.ts, mirroring src/cli/node.ts's ensurePrivateNode's baseUrl.
NODE_DIST_BASE_URL="${JAPA_NODE_DIST:-https://nodejs.org/dist}"
NON_INTERACTIVE=0
NO_SERVICE=0
SKIP_SETUP=0
MODE="${JAPA_INSTALL_MODE:-}"
INSTANCE="${JAPA_INSTANCE:-}"
DESKTOP_PORT=""
WEBUI_PORT_OPT=""
WEBUI_PORT_GIVEN=0
WEBUI_BIND_OPT=""
WEBUI_BIND_GIVEN=0
INSTALL_SYSBOX=0
DIR_GIVEN=0
# Whether --branch was given explicitly (flag or env): only then is it forwarded to the update path (step 3), so
# a bare re-run doesn't force a managed checkout back to main (design doc §3.1 step 3; constraints.md's update
# default is "the checkout's current branch").
BRANCH_GIVEN=0
if [ -n "${JAPA_BRANCH:-}" ]; then
  BRANCH_GIVEN=1
fi

while [ $# -gt 0 ]; do
  case "$1" in
    --dir)
      DIR=$2
      DIR_GIVEN=1
      shift 2
      ;;
    --mode)
      MODE=$2
      shift 2
      ;;
    --instance)
      INSTANCE=$2
      shift 2
      ;;
    --desktop-port)
      DESKTOP_PORT=$2
      shift 2
      ;;
    --webui-port)
      WEBUI_PORT_OPT=$2
      WEBUI_PORT_GIVEN=1
      shift 2
      ;;
    --webui-bind)
      WEBUI_BIND_OPT=$2
      WEBUI_BIND_GIVEN=1
      shift 2
      ;;
    --install-sysbox)
      INSTALL_SYSBOX=1
      shift
      ;;
    --branch)
      BRANCH=$2
      BRANCH_GIVEN=1
      shift 2
      ;;
    --repo)
      REPO=$2
      shift 2
      ;;
    --non-interactive)
      NON_INTERACTIVE=1
      shift
      ;;
    --no-service)
      NO_SERVICE=1
      shift
      ;;
    --skip-setup)
      SKIP_SETUP=1
      shift
      ;;
    *)
      say_err "unknown option: $1"
      exit 1
      ;;
  esac
done

case "$MODE" in
  "" | docker | native) ;;
  *)
    say_err "unknown mode: $MODE (use --mode docker or --mode native)"
    exit 1
    ;;
esac

# Canonicalize DIR: absolute, no trailing slash, so "$DIR/app" matches src/cli/layout.ts's join(installDir, "app")
# byte for byte -- launcherPointsAt() and the service unit both depend on that.
case "$DIR" in
  /*) ;;
  *) DIR="$PWD/$DIR" ;;
esac
while [ "${DIR%/}" != "$DIR" ]; do
  DIR=${DIR%/}
done

# --- Step 1: platform ---
say "Checking platform"
case "$(uname -s)" in
  Linux) OS=linux ;;
  Darwin)
    say_err "japa runs on Linux only (WSL works)."
    exit 1
    ;;
  *)
    say_err "japa supports Linux on x64 or arm64"
    exit 1
    ;;
esac
case "$(uname -m)" in
  x86_64 | amd64) ARCH=x64 ;;
  arm64 | aarch64) ARCH=arm64 ;;
  *)
    say_err "japa supports Linux on x64 or arm64"
    exit 1
    ;;
esac

# Docker mode's instance name (docs/spec.md §3): default $USER, sanitised.
if [ -z "$INSTANCE" ] && [ "$MODE" != native ]; then
  INSTANCE=$(sanitize_name "${USER:-$(id -un 2>/dev/null || echo japa)}")
fi

APP_DIR="$DIR/app"
NODE_DIR="$DIR/node"
LAUNCHER="$HOME/.local/bin/japa"
# ~/.local/bin/japa belongs to a Docker install (docs/spec.md §5.4): then this native install's launcher is
# ~/.local/bin/japa-native, unless the user lets it replace the Docker one (asked by choose_native_launcher, only
# once Install or Update is under way -- never before the menu).
DOCKER_OWNS_LAUNCHER=0
if is_docker_launcher "$LAUNCHER"; then
  DOCKER_OWNS_LAUNCHER=1
  LAUNCHER="$HOME/.local/bin/japa-native"
fi
choose_native_launcher() {
  [ "$DOCKER_OWNS_LAUNCHER" -eq 1 ] || return 0
  native_alt="$HOME/.local/bin/japa-native"
  if [ -x "$native_alt" ] && ! is_docker_launcher "$native_alt"; then
    LAUNCHER=$native_alt
  elif has_tty && confirm "$HOME/.local/bin/japa runs japa's Docker instances. Replace it with this native install's launcher? [y/N]" n; then
    LAUNCHER="$HOME/.local/bin/japa"
  else
    LAUNCHER=$native_alt
    say "keeping the Docker launcher at $HOME/.local/bin/japa; this install's launcher is $LAUNCHER"
  fi
}
# What this run created, so a failure removes exactly that (design doc §3.3) and nothing that was already there.
APP_CREATED=0
NODE_CREATED=0

# Step 7: writes the launcher for $NODE_BIN and, when ~/.local/bin isn't on PATH, a line to the shell's rc file.
install_launcher() {
  say "Writing launcher"
  mkdir -p "$(dirname "$LAUNCHER")"
  # Replace, never write through, a symlink (`npm link` makes one to a checkout's main.ts).
  rm -f "$LAUNCHER"
  write_launcher "$NODE_BIN" "$APP_DIR" >"$LAUNCHER"
  chmod 755 "$LAUNCHER"
  ensure_path_line
}

# Whether the launcher is there and runs this install's checkout (as src/cli/layout.ts's launcherPointsAt checks).
launcher_points_here() {
  [ -x "$LAUNCHER" ] && grep -qF "$(shell_quote "$APP_DIR/src/cli/main.ts")" "$LAUNCHER"
}

# Whether $APP_DIR is japa's own checkout, so Uninstall may remove it. (Without --mode docker a foreign app/ was
# already refused; with it, the menu's Uninstall must still never touch someone else's app/.)
app_is_ours() {
  [ -e "$APP_DIR/.git" ] && is_japa_checkout
}

# Whether $APP_DIR's package.json names it japa.
is_japa_checkout() {
  [ -f "$APP_DIR/package.json" ] && grep -q '^[[:space:]]*"name"[[:space:]]*:[[:space:]]*"japa"' "$APP_DIR/package.json"
}

# A foreign app/ is refused before anything else (the menu included) and nothing is touched. (--mode docker
# ignores --dir, so there it doesn't matter.)
if [ "$MODE" != docker ] && { [ -e "$APP_DIR" ] || [ -L "$APP_DIR" ]; } && ! { [ -e "$APP_DIR/.git" ] && is_japa_checkout; }; then
  say_err "$APP_DIR exists and isn't a japa checkout; remove it or choose another --dir"
  exit 1
fi
# What's installed: a native install at $DIR (unless --mode docker), else a Docker instance $INSTANCE (unless
# --mode native). A native one wins, as an existing install decides the mode (docs/spec.md §4.1).
NATIVE_INSTALLED=0
DOCKER_INSTALLED=0
if [ "$MODE" != docker ] && [ -e "$APP_DIR/.git" ]; then
  NATIVE_INSTALLED=1
elif [ "$MODE" != native ] && docker_instance_exists; then
  DOCKER_INSTALLED=1
fi
INSTALLED=$((NATIVE_INSTALLED + DOCKER_INSTALLED))

# --- The menu (docs/spec.md "installer menu"): only with a terminal and without --non-interactive. ---
if [ "$NON_INTERACTIVE" -eq 0 ] && has_tty; then
  exec 3<"$TTY"
  # The menu and its prompts are drawn on the terminal (fd 4), so they stay visible with stdout redirected; with the
  # tests' JAPA_INSTALL_TTY stand-in (a file of answers) they go to stdout.
  if [ "$TTY" = /dev/tty ] && (exec 4>/dev/tty) 2>/dev/null; then
    exec 4>/dev/tty
  else
    exec 4>&1
  fi
  HAVE_MENU=1
else
  HAVE_MENU=0
fi

# Reads one line from the terminal (fd 3) into $answer; fails on EOF.
menu_ask() {
  printf '%s' "$1" >&4
  answer=""
  IFS= read -r answer <&3 || { [ -n "$answer" ]; } || { echo >&4; return 1; }
}

is_yes() {
  case "$1" in
    y | Y | yes | Yes | YES) return 0 ;;
    *) return 1 ;;
  esac
}

# Whether japa's own private Node is there (marked as src/cli/node.ts marks it).
has_japa_node() {
  [ -e "$NODE_DIR/$NODE_MARKER" ]
}

JAPA_HOME_DIR="${JAPA_HOME:-$HOME/.japa}"
UNIT_FILE="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/japa.service"

# The probe (can this checkout run?): sets RUNNER_KIND to "launcher" or "node" (with RUNNER_NODE), or fails.
RUNNER_KIND=""
RUNNER_NODE=""
run_japa() {
  if [ "$RUNNER_KIND" = launcher ]; then
    "$LAUNCHER" "$@"
  else
    "$RUNNER_NODE" --disable-warning=ExperimentalWarning "$APP_DIR/src/cli/main.ts" "$@"
  fi
}
probe_japa() {
  [ -e "$APP_DIR/.git" ] && is_japa_checkout || return 1
  if launcher_points_here; then
    RUNNER_KIND=launcher
  elif has_japa_node && node_ok "$NODE_DIR/bin/node"; then
    RUNNER_KIND=node
    RUNNER_NODE="$NODE_DIR/bin/node"
  else
    system_node=$(command -v node 2>/dev/null || true)
    if [ -n "$system_node" ] && node_ok "$system_node"; then
      RUNNER_KIND=node
      RUNNER_NODE=$system_node
    else
      return 1
    fi
  fi
  run_japa --version >/dev/null 2>&1
}

# Fallback: mirrors src/cli/uninstall.ts in shell, for an install japa itself can't run from. Best-effort after
# the purge confirmation: a failed step is reported, the rest still run, and the exit status says so.
uninstall_directly() {
  purge=$1
  failed=0
  if [ "$purge" -eq 1 ]; then
    if ! menu_ask "Type \"delete\" to permanently remove $JAPA_HOME_DIR: " || [ "$answer" != delete ]; then
      echo "purge cancelled; nothing was removed"
      exit 0
    fi
  fi

  if command -v systemctl >/dev/null 2>&1; then
    systemctl --user disable --now japa >/dev/null 2>&1 || true
  fi
  if [ -e "$UNIT_FILE" ] || [ -L "$UNIT_FILE" ]; then
    if rm -f "$UNIT_FILE"; then
      echo "removed $UNIT_FILE"
    else
      say_err "could not remove $UNIT_FILE"
      failed=1
    fi
  fi
  if command -v systemctl >/dev/null 2>&1; then
    systemctl --user daemon-reload >/dev/null 2>&1 || true
  fi

  # As uninstall.ts: only ~/.local/bin/japa (a japa-native launcher, next to a Docker one, is left in place).
  if [ "$LAUNCHER" = "$HOME/.local/bin/japa" ] && launcher_points_here; then
    if rm -f "$LAUNCHER"; then
      echo "removed $LAUNCHER"
    else
      say_err "could not remove $LAUNCHER"
      failed=1
    fi
  fi

  if app_is_ours; then
    if rm -rf "$APP_DIR"; then
      echo "removed $APP_DIR"
    else
      say_err "could not remove $APP_DIR"
      failed=1
    fi
  fi
  if has_japa_node; then
    if rm -rf "$NODE_DIR"; then
      echo "removed $NODE_DIR"
    else
      say_err "could not remove $NODE_DIR"
      failed=1
    fi
  fi
  if [ -d "$DIR" ] && [ -z "$(ls -A "$DIR" 2>/dev/null)" ]; then
    rmdir "$DIR" 2>/dev/null || { say_err "could not remove $DIR"; failed=1; }
  fi

  if [ "$purge" -eq 1 ]; then
    if rm -rf "$JAPA_HOME_DIR"; then
      echo "removed $JAPA_HOME_DIR"
    else
      say_err "could not remove $JAPA_HOME_DIR"
      failed=1
    fi
  else
    echo "kept $JAPA_HOME_DIR"
  fi

  rc_files=""
  add_rc_if_holds "$HOME/.bashrc" 'export PATH="$HOME/.local/bin:$PATH"'
  add_rc_if_holds "$HOME/.zshrc" 'export PATH="$HOME/.local/bin:$PATH"'
  add_rc_if_holds "$HOME/.config/fish/config.fish" 'fish_add_path $HOME/.local/bin'
  if [ -n "$rc_files" ]; then
    echo "the PATH line install.sh added is still in $rc_files"
  fi

  exit "$failed"
}

# Appends $1 to $rc_files when that rc file still holds install.sh's PATH line $2 (src/cli/uninstall.ts's PATH_LINES).
add_rc_if_holds() {
  if [ -f "$1" ] && grep -qF "$2" "$1"; then
    rc_files="${rc_files:+$rc_files, }$1"
  fi
}

# The menu's Uninstall: returns (to the menu) when the user declines, otherwise exits.
uninstall_flow() {
  echo "This will remove:"
  echo "  the japa service (systemd user unit), if installed"
  if [ "$LAUNCHER" = "$HOME/.local/bin/japa" ] && launcher_points_here; then echo "  the launcher $LAUNCHER"; fi
  if app_is_ours; then echo "  $APP_DIR"; fi
  if [ "$LAUNCHER" != "$HOME/.local/bin/japa" ] && [ -e "$LAUNCHER" ]; then
    echo "(not removed: the launcher $LAUNCHER -- remove it by hand)"
  fi
  if has_japa_node; then echo "  $NODE_DIR (japa's Node.js)"; fi
  if ! menu_ask "Uninstall japa from $DIR? [y/N] " || ! is_yes "$answer"; then
    return 0
  fi
  purge=0
  if menu_ask "Also delete your data in $JAPA_HOME_DIR (settings, secrets, memory)? [y/N] " && is_yes "$answer"; then
    purge=1
  fi

  if probe_japa; then
    say "Uninstalling with japa uninstall"
    set -- uninstall
    if [ "$purge" -eq 1 ]; then
      set -- "$@" --purge
    fi
    status=0
    run_japa "$@" <&3 3<&- || status=$?
    exit "$status"
  fi
  say "japa can't run from $DIR; removing it directly"
  uninstall_directly "$purge"
}

if [ "$HAVE_MENU" -eq 1 ]; then
  ACTION=""
  while [ -z "$ACTION" ]; do
    if [ "$NATIVE_INSTALLED" -eq 1 ]; then
      say "japa installer ($DIR, installed)" >&4
      default=2
    elif [ "$DOCKER_INSTALLED" -eq 1 ]; then
      say "japa installer ($DIR; Docker instance $INSTANCE installed)" >&4
      default=2
    else
      say "japa installer ($DIR)" >&4
      default=1
    fi
    printf '  1) Install\n  2) Update\n  3) Uninstall\n  4) Quit\n' >&4
    if ! menu_ask "Choose [$default]: "; then
      exit 0
    fi
    choice=$answer
    # Trim surrounding blanks.
    choice=${choice#"${choice%%[![:space:]]*}"}
    choice=${choice%"${choice##*[![:space:]]}"}
    if [ -z "$choice" ]; then
      choice=$default
    fi
    case "$choice" in
      1)
        if [ "$NATIVE_INSTALLED" -eq 1 ]; then
          echo "japa is already installed at $DIR; choose Update"
        elif [ "$DOCKER_INSTALLED" -eq 1 ]; then
          echo "japa is already installed as Docker instance $INSTANCE; choose Update"
        else
          ACTION=install
        fi
        ;;
      2)
        if [ "$INSTALLED" -eq 1 ]; then
          ACTION=update
        else
          echo "no japa install at $DIR; choose Install"
        fi
        ;;
      3)
        if app_is_ours || has_japa_node || launcher_points_here; then
          uninstall_flow
        else
          echo "no japa install at $DIR"
          if [ "$DOCKER_INSTALLED" -eq 1 ]; then
            echo "(Docker instance $INSTANCE is removed with: japa --instance $INSTANCE uninstall)"
          fi
        fi
        ;;
      4) exit 0 ;;
      *) ;;
    esac
  done
elif [ "$INSTALLED" -ge 1 ]; then
  ACTION=update
else
  ACTION=install
fi

# --- Mode (docs/spec.md §4.1): an existing install decides it; else ask in a terminal (Enter: Docker), else Docker.
if [ -z "$MODE" ]; then
  if [ "$NATIVE_INSTALLED" -eq 1 ]; then
    MODE=native
  elif [ "$DOCKER_INSTALLED" -eq 1 ]; then
    MODE=docker
  elif has_tty; then
    while [ -z "$MODE" ]; do
      ask "Install japa via Docker (recommended) or natively? [Docker/native]"
      case "$ANSWER" in
        "" | d | D | docker | Docker) MODE=docker ;;
        n | N | native | Native) MODE=native ;;
      esac
    done
  else
    MODE=docker
  fi
fi

if [ "$MODE" = docker ]; then
  docker_prereqs # may switch to native, when Sysbox is missing and the user picks that instead
fi
if [ "$MODE" = docker ]; then
  docker_install
  exit 0
fi
# Native from here on; Docker mode may have handed over to it (no Sysbox) for an instance that isn't native.
if [ "$NATIVE_INSTALLED" -eq 0 ]; then
  ACTION=install
fi
choose_native_launcher

# --- Step 2: prerequisites ---
say "Checking prerequisites"
require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    say_err "$1 is required. Install it with: apt install $2 | dnf install $3"
    exit 1
  fi
}
require_cmd git git git
require_cmd tar tar tar
if ! command -v curl >/dev/null 2>&1 && ! command -v wget >/dev/null 2>&1; then
  say_err "curl or wget is required. Install one with: apt install curl | dnf install curl"
  exit 1
fi

# --- Step 3: existing install -> upgrade path ---
if [ "$ACTION" = update ]; then
  # An install interrupted before its launcher step, or a launcher since taken over by another install: (re)write
  # it, so the update below -- and every later `japa` -- runs this checkout.
  if ! launcher_points_here; then
    ensure_node
    install_launcher
  fi
  say "Updating existing install"
  status=0
  set -- update
  if [ "$BRANCH_GIVEN" -eq 1 ]; then
    set -- "$@" --branch "$BRANCH"
  fi
  "$LAUNCHER" "$@" || status=$?
  exit "$status"
fi

# --- Steps 4-7: fresh install. On failure, remove the app/ and node/ this run created. ---
mkdir -p "$DIR"
STEP=""
cleanup() {
  code=$?
  trap - EXIT
  if [ "$code" -ne 0 ]; then
    if [ "$APP_CREATED" -eq 1 ]; then rm -rf "$APP_DIR"; fi
    if [ "$NODE_CREATED" -eq 1 ]; then rm -rf "$NODE_DIR"; fi
    say_err "install failed at: $STEP"
  fi
  exit "$code"
}
trap cleanup EXIT

STEP="clone"
say "Cloning $REPO"
APP_CREATED=1
git clone --branch "$BRANCH" "$REPO" "$APP_DIR"

STEP="node"
say "Checking Node.js"
ensure_node

STEP="dependencies"
say "Installing dependencies"
(cd "$APP_DIR" && PATH="$(dirname "$NODE_BIN"):$PATH" npm ci)

STEP="build"
say "Building the web UI"
(cd "$APP_DIR" && PATH="$(dirname "$NODE_BIN"):$PATH" npm run build)

STEP="launcher"
install_launcher

# The install itself is done; a failure past this point (setup) must not undo it.
trap - EXIT

# --- Step 8: setup ---
if [ "$SKIP_SETUP" -eq 1 ] || [ "$HAVE_MENU" -eq 0 ]; then
  say "Skipping setup"
  echo "run \`japa setup\` to finish"
else
  say "Running setup"
  if [ "$NO_SERVICE" -eq 1 ]; then
    "$LAUNCHER" setup --no-service <&3
  else
    "$LAUNCHER" setup <&3
  fi
fi

}

main "$@"
