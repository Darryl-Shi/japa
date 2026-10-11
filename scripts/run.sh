#!/bin/sh
# Runs the japa daemon in the foreground from this checkout (Ctrl-C stops it). It serves the web UI at
# http://127.0.0.1:7337 (extensions.webui.bind/port) and the `japa chat` socket. JAPA_HOME picks the home
# (default ~/.japa); it needs a model configured there (`node src/cli/main.ts setup`).
set -eu
cd "$(dirname "$0")/.."
[ -f extensions/webui/build/handler.js ] || npm run build
exec node --disable-warning=ExperimentalWarning src/cli/main.ts daemon
