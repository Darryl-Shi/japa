#!/bin/sh
# Installs japa's dependencies from the lockfile and builds the web UI (npm ci's `prepare` builds it too; the explicit
# build makes a failure obvious). Needs Node.js 24+ with npm (and bubblewrap for job sandboxes).
set -eu
cd "$(dirname "$0")/.."
node -e 'if (+process.versions.node.split(".")[0] < 24) { console.error("Node 24+ required"); process.exit(1) }'
npm ci
npm run build
