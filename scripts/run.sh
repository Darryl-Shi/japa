#!/bin/sh
# Without arguments: runs the japa daemon in the foreground from this checkout (Ctrl-C stops it). It serves the web UI
# at http://127.0.0.1:7337 (extensions.webui.bind/port) and the `japa chat` socket. With arguments: runs that CLI
# command instead, e.g. `scripts/run.sh chat`, `scripts/run.sh status`, `scripts/run.sh webui users add <name>` (a web
# UI user to sign in as), `scripts/run.sh --version`.
# JAPA_HOME picks the home (default ~/.japa; use a scratch dir for a throwaway daemon); the daemon needs a model
# configured there (`scripts/run.sh setup`). To install japa for real, use install.sh.
set -eu
cd "$(dirname "$0")/.."
if [ "$#" -eq 0 ] || [ "$1" = daemon ]; then
  [ -f extensions/webui/build/handler.js ] || npm run build
  [ "$#" -eq 0 ] || shift
  exec node --disable-warning=ExperimentalWarning src/cli/main.ts daemon "$@"
fi
exec node --disable-warning=ExperimentalWarning src/cli/main.ts "$@"
