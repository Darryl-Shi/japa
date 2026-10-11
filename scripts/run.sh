#!/bin/sh
# Runs the japa daemon in the foreground (home: $JAPA_HOME, default ~/.japa). Run `japa setup` first to configure a
# model; chat with it from another terminal with `node src/cli/main.ts chat`.
set -eu
cd "$(dirname "$0")/.."
exec node --disable-warning=ExperimentalWarning src/cli/main.ts daemon "$@"
