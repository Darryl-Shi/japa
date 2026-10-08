#!/bin/sh
# japa bootstrap: curl -fsSL https://raw.githubusercontent.com/Darryl-Shi/japa/main/install.sh | sh
# See docs/superpowers/specs/2026-10-08-japa-install-design.md §3. Re-running this script upgrades an existing
# install (§3.1 step 3); it never touches $JAPA_HOME (~/.japa by default).
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

# Sets NODE_BIN to an absolute path of a Node >= 24: the one on PATH if it qualifies, else japa's private Node in
# $NODE_DIR -- the one a previous run left there when it's still good (a rerun doesn't download it again), else a
# fresh download (design doc §3.1 step 5).
NODE_BIN=""
ensure_node() {
  system_node=$(command -v node 2>/dev/null || true)
  if [ -n "$system_node" ] && node_ok "$system_node"; then
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

# --- Flags (design doc §3.2) ---
DIR="${JAPA_INSTALL_DIR:-$HOME/.local/share/japa}"
BRANCH="${JAPA_BRANCH:-main}"
REPO="${JAPA_REPO:-https://github.com/Darryl-Shi/japa.git}"
# Undocumented override for test/install-sh.test.ts, mirroring src/cli/node.ts's ensurePrivateNode's baseUrl.
NODE_DIST_BASE_URL="${JAPA_NODE_DIST:-https://nodejs.org/dist}"
NON_INTERACTIVE=0
NO_SERVICE=0
SKIP_SETUP=0
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
      shift 2
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
  Darwin) OS=darwin ;;
  *)
    say_err "japa supports Linux and macOS on x64 or arm64"
    exit 1
    ;;
esac
case "$(uname -m)" in
  x86_64 | amd64) ARCH=x64 ;;
  arm64 | aarch64) ARCH=arm64 ;;
  *)
    say_err "japa supports Linux and macOS on x64 or arm64"
    exit 1
    ;;
esac

# --- Step 2: prerequisites ---
say "Checking prerequisites"
require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    say_err "$1 is required. Install it with: apt install $2 | dnf install $3 | brew install $4"
    exit 1
  fi
}
require_cmd git git git git
require_cmd tar tar tar gnu-tar
if ! command -v curl >/dev/null 2>&1 && ! command -v wget >/dev/null 2>&1; then
  say_err "curl or wget is required. Install one with: apt install curl | dnf install curl | brew install curl"
  exit 1
fi

APP_DIR="$DIR/app"
NODE_DIR="$DIR/node"
LAUNCHER="$HOME/.local/bin/japa"
# What this run created, so a failure removes exactly that (design doc §3.3) and nothing that was already there.
APP_CREATED=0
NODE_CREATED=0

# Step 7: writes the launcher for $NODE_BIN and, when ~/.local/bin isn't on PATH, a line to the shell's rc file.
install_launcher() {
  say "Writing launcher"
  mkdir -p "$(dirname "$LAUNCHER")"
  write_launcher "$NODE_BIN" "$APP_DIR" >"$LAUNCHER"
  chmod 755 "$LAUNCHER"

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

# Whether the launcher is there and runs this install's checkout (as src/cli/layout.ts's launcherPointsAt checks).
launcher_points_here() {
  [ -x "$LAUNCHER" ] && grep -qF "$(shell_quote "$APP_DIR/src/cli/main.ts")" "$LAUNCHER"
}

# --- Step 3: existing install -> upgrade path ---
if [ -e "$APP_DIR/.git" ]; then
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

if [ -e "$APP_DIR" ] || [ -L "$APP_DIR" ]; then
  say_err "$APP_DIR exists and isn't a japa checkout; remove it or choose another --dir"
  exit 1
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

STEP="launcher"
install_launcher

# The install itself is done; a failure past this point (setup) must not undo it.
trap - EXIT

# --- Step 8: setup ---
# `[ -r /dev/tty ]` only checks the device node's permissions (always 0666), not whether this process has a
# controlling terminal to open -- under `curl | sh` in CI/Docker/cloud-init there is none, so probe the open.
has_tty() {
  (exec 3</dev/tty) 2>/dev/null
}
if [ "$SKIP_SETUP" -eq 1 ] || [ "$NON_INTERACTIVE" -eq 1 ] || ! has_tty; then
  say "Skipping setup"
  echo "run \`japa setup\` to finish"
else
  say "Running setup"
  if [ "$NO_SERVICE" -eq 1 ]; then
    "$LAUNCHER" setup --no-service </dev/tty
  else
    "$LAUNCHER" setup </dev/tty
  fi
fi

}

main "$@"
