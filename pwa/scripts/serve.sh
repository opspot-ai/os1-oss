#!/usr/bin/env bash
# Launch the OS1 web shell.
#
#   DEMO (no credentials at all — verifies the whole UI):
#     ./scripts/serve.sh
#
#   LIVE against a remote Orgo computer:
#     export ORGO_API_KEY="…"        # never hard-code this; read it from your
#     export ORGO_COMPUTER_ID="…"    # secret manager or a gitignored .env
#     ./scripts/serve.sh
#
#   LIVE against a local agent CLI: use ./scripts/run-local.sh instead.
#
# Then on your phone (same network): open http://<your-mac-ip>:8787 in Safari
# and choose Share -> Add to Home Screen.

set -euo pipefail
cd "$(dirname "$0")/.."
PORT="${PORT:-8787}"
echo "OS1 web shell -> http://localhost:${PORT}"
exec node server/proxy.mjs
