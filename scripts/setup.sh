#!/bin/sh
# Installs the dev dependencies for working on this checkout (tests, typecheck). Needs Node 24+ with npm.
set -eu
cd "$(dirname "$0")/.."
node -e 'if (+process.versions.node.split(".")[0] < 24) { console.error("Node 24+ required"); process.exit(1) }'
npm ci
