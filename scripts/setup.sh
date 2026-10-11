#!/bin/sh
# Installs japa's dependencies from the lockfile. Needs Node.js 24+ (and bubblewrap for job sandboxes).
set -eu
cd "$(dirname "$0")/.."
npm ci
