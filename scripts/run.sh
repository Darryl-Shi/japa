#!/bin/sh
# Without arguments: runs the japa daemon in the foreground from this checkout (Ctrl-C stops it). It serves the web UI
# at http://127.0.0.1:7337 (extensions.webui.bind/port) and the `japa chat` socket. With arguments: runs that CLI
# command instead, e.g. `scripts/run.sh chat`, `scripts/run.sh status`, `scripts/run.sh webui users add <name>` (a web
# UI user to sign in as), `scripts/run.sh --version`.
# JAPA_HOME picks the home (default ~/.japa; use a scratch dir for a throwaway daemon); the daemon needs a model
# configured there (`scripts/run.sh setup`). With JAPA_HOME set and no settings.json there at all, it writes a starter
# one (never into the default ~/.japa: a later `japa setup` would take it for a configured home) (the CoS on
# Anthropic's Claude Sonnet 4.5, no credentials yet) so the daemon boots: connect a provider or pick another model in
# the web UI's Settings (sign in as a user made with `scripts/run.sh webui users add <name>`). To install japa for real,
# use install.sh.
set -eu
cd "$(dirname "$0")/.."
if [ "$#" -eq 0 ] || [ "$1" = daemon ]; then
  [ -f extensions/webui/build/handler.js ] || npm run build
  home="${JAPA_HOME:-}"
  if [ -n "$home" ] && [ ! -f "$home/settings.json" ]; then
    mkdir -p "$home"
    printf '%s\n' '{"models":{"cos":{"provider":"anthropic","modelId":"claude-sonnet-4-5"}}}' > "$home/settings.json"
    echo "run.sh: wrote a starter $home/settings.json (no credentials yet): connect a provider in the web UI's" \
      "Settings → Providers, or run scripts/run.sh setup." >&2
  fi
  [ "$#" -eq 0 ] || shift
  exec node --disable-warning=ExperimentalWarning src/cli/main.ts daemon "$@"
fi
exec node --disable-warning=ExperimentalWarning src/cli/main.ts "$@"
