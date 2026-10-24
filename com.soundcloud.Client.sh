#!/usr/bin/env bash
set -e
export TMPDIR="${XDG_RUNTIME_DIR:-/tmp}"
exec electron /app/main/main.js --no-sandbox --ozone-platform-hint=auto "$@"
