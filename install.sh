#!/usr/bin/env bash
set -euo pipefail
umask 077

# Install from a checkout. No sudo, global npm install, or service manager changes.
case "${1:-}" in
  ""|--no-start) ;;
  --help) printf 'Usage: ./install.sh [--no-start]\nRequires Node.js 24+ and npm. Installs a private app copy and a japa launcher.\nOverride JAPA_INSTALL_DIR or JAPA_BIN_DIR to change installation paths.\n'; exit 0 ;;
  *) printf 'Unknown option; use --help\n' >&2; exit 1 ;;
esac
command -v node >/dev/null && command -v npm >/dev/null || { printf 'Install Node.js 24+ (including npm) from https://nodejs.org, then rerun this script.\n' >&2; exit 1; }
node -e 'if (Number(process.versions.node.split(".")[0]) < 24) process.exit(1)' || { printf 'Japa requires Node.js 24 or newer.\n' >&2; exit 1; }
source_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
app_dir="${JAPA_INSTALL_DIR:-${XDG_DATA_HOME:-$HOME/.local/share}/japa}"
bin_dir="${JAPA_BIN_DIR:-$HOME/.local/bin}"
mkdir -p -- "$(dirname -- "$app_dir")" "$bin_dir"
app_dir="$(cd -- "$(dirname -- "$app_dir")" && pwd)/$(basename -- "$app_dir")"
bin_dir="$(cd -- "$bin_dir" && pwd)"
if [[ -e "$app_dir" && ! -f "$app_dir/.japa-install" ]]; then
  printf 'Refusing to overwrite an unmanaged directory: %s\n' "$app_dir" >&2
  exit 1
fi
if [[ -e "$bin_dir/japa" ]] && ! grep -q '^# Japa managed launcher$' "$bin_dir/japa"; then
  printf 'Refusing to overwrite an unrelated launcher: %s\n' "$bin_dir/japa" >&2
  exit 1
fi
stage="$(mktemp -d "$(dirname -- "$app_dir")/.japa-install.XXXXXX")"
trap 'rm -rf -- "$stage"' EXIT
cp -- "$source_dir/package.json" "$source_dir/package-lock.json" "$source_dir/tsconfig.json" "$stage/"
cp -R -- "$source_dir/src" "$source_dir/examples" "$stage/"
printf 'Installing Japa dependencies...\n'
npm ci --prefix "$stage" --no-audit --no-fund
touch "$stage/.japa-install"
if [[ -e "$app_dir" ]]; then
  # Keep the previous app for recovery; never move or erase the user's state.
  backup="$(mktemp -d "${app_dir}.previous.XXXXXX")"
  rmdir -- "$backup"
  mv -- "$app_dir" "$backup"
  printf 'Previous installation retained at %s\n' "$backup"
fi
mv -- "$stage" "$app_dir"
launcher="$(mktemp "$bin_dir/.japa-launcher.XXXXXX")"
{
  printf '#!/usr/bin/env bash\n# Japa managed launcher\nset -euo pipefail\n'
  printf 'app_dir=%q\n' "$app_dir"
  printf 'export JAPA_HOME="${JAPA_HOME:-${XDG_STATE_HOME:-$HOME/.local/state}/japa}"\n'
  printf 'exec node "$app_dir/node_modules/tsx/dist/cli.mjs" "$app_dir/src/cli.ts" "$@"\n'
} > "$launcher"
chmod 755 "$launcher"
mv -- "$launcher" "$bin_dir/japa"
printf '\nInstalled %s/japa\n' "$bin_dir"
case ":${PATH:-}:" in *":$bin_dir:"*) ;; *) printf 'Add %s to your PATH, or run the launcher by its full path.\n' "$bin_dir" ;; esac
printf 'State defaults to ${XDG_STATE_HOME:-$HOME/.local/state}/japa; set JAPA_HOME to reuse an existing home.\nStop Japa before reinstalling. This installer does not create an always-on service.\n'
if [[ "${1:-}" != --no-start && -t 0 && -t 1 ]]; then
  exec "$bin_dir/japa"
fi
printf 'Run %s/japa to open provider setup and start chatting.\n' "$bin_dir"
