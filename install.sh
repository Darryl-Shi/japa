#!/bin/sh
# japa bootstrap: curl -fsSL https://raw.githubusercontent.com/Darryl-Shi/japa/main/install.sh | sh
# See docs/superpowers/specs/2026-10-08-japa-install-design.md §3. Re-running this script upgrades an existing
# install (§3.1 step 3); it never touches $JAPA_HOME (~/.japa by default).
set -eu

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

# Sets NODE_BIN to an absolute path of a Node >= 24: the one on PATH if it qualifies, else a private download
# into $NODE_DIR (design doc §3.1 step 5).
NODE_BIN=""
ensure_node() {
  if command -v node >/dev/null 2>&1; then
    node_version=$(node -p 'process.versions.node' 2>/dev/null || echo 0.0.0)
    node_major=${node_version%%.*}
    if [ "$node_major" -ge 24 ] 2>/dev/null; then
      NODE_BIN=$(command -v node)
      return 0
    fi
  fi
  download_node
}

download_node() {
  say "Downloading Node.js"
  node_ver=$(cat "$APP_DIR/.node-version")
  dist="${OS}-${ARCH}"
  name="node-v${node_ver}-${dist}.tar.gz"
  base_url="https://nodejs.org/dist/v${node_ver}"
  tmp_tar="$DIR/node-download.tar.gz"

  fetch "$base_url/$name" >"$tmp_tar"
  shasums=$(fetch "$base_url/SHASUMS256.txt")
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

  rm -rf "$NODE_DIR"
  mkdir -p "$NODE_DIR"
  tar -xzf "$tmp_tar" -C "$NODE_DIR" --strip-components=1
  rm -f "$tmp_tar"
  NODE_BIN="$NODE_DIR/bin/node"
}

# --- Flags (design doc §3.2) ---
DIR="${JAPA_INSTALL_DIR:-$HOME/.local/share/japa}"
BRANCH="${JAPA_BRANCH:-main}"
REPO="${JAPA_REPO:-https://github.com/Darryl-Shi/japa.git}"
NON_INTERACTIVE=0
NO_SERVICE=0
SKIP_SETUP=0

while [ $# -gt 0 ]; do
  case "$1" in
    --dir)
      DIR=$2
      shift 2
      ;;
    --branch)
      BRANCH=$2
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

# --- Step 3: existing install -> upgrade path ---
if [ -e "$APP_DIR/.git" ]; then
  say "Updating existing install"
  status=0
  if [ -x "$LAUNCHER" ]; then
    "$LAUNCHER" update --branch "$BRANCH" || status=$?
  else
    ensure_node
    "$NODE_BIN" "$APP_DIR/src/cli/main.ts" update --branch "$BRANCH" || status=$?
  fi
  exit "$status"
fi

# --- Steps 4-7: fresh install. On failure, remove the app/ and node/ this run created. ---
mkdir -p "$DIR"
STEP=""
cleanup() {
  code=$?
  trap - EXIT
  if [ "$code" -ne 0 ]; then
    rm -rf "$APP_DIR" "$NODE_DIR"
    say_err "install failed at: $STEP"
  fi
  exit "$code"
}
trap cleanup EXIT

STEP="clone"
say "Cloning $REPO"
git clone --branch "$BRANCH" "$REPO" "$APP_DIR"

STEP="node"
say "Checking Node.js"
ensure_node

STEP="dependencies"
say "Installing dependencies"
(cd "$APP_DIR" && PATH="$(dirname "$NODE_BIN"):$PATH" npm ci)

STEP="launcher"
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
    fi
    say "added PATH line to $rcfile"
    echo 'open a new shell or run: export PATH="$HOME/.local/bin:$PATH"'
    ;;
esac

# The install itself is done; a failure past this point (setup) must not undo it.
trap - EXIT

# --- Step 8: setup ---
if [ "$SKIP_SETUP" -eq 1 ] || [ "$NON_INTERACTIVE" -eq 1 ] || [ ! -r /dev/tty ]; then
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
