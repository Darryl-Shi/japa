#!/bin/sh
# Installs japa's dependencies from the lockfile and builds the web UI (npm ci's `prepare` builds it too; the explicit
# build makes a failure obvious). Needs Node >= 24 with npm.
set -eu
cd "$(dirname "$0")/.."
npm ci
npm run build
