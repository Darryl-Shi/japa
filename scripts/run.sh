#!/bin/sh
# Runs the japa CLI from this checkout, e.g. `scripts/run.sh daemon`, `scripts/run.sh chat`, `scripts/run.sh --version`.
# Set JAPA_HOME to a scratch directory for a throwaway daemon. To install japa for real, use install.sh.
set -eu
cd "$(dirname "$0")/.."
exec node --disable-warning=ExperimentalWarning src/cli/main.ts "$@"
