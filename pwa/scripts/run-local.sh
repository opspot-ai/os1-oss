#!/usr/bin/env bash
# Start the OS1 bridge against a local agent CLI.
#
# Configuration comes from a .env file at the repository root (copy
# .env.example and fill it in). Anything already exported in your shell wins
# over the .env file.
#
# An access token is generated on first run and stored in OS1_TOKEN_FILE; the
# iOS bootstrap script reads that same file.
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO_ROOT="$(cd "$APP_DIR/.." && pwd)"
ENV_FILE="${OS1_ENV_FILE:-$REPO_ROOT/.env}"
TOKEN_FILE="${OS1_TOKEN_FILE:-${TMPDIR:-/tmp}/os1-bridge-token}"

if [[ -f "$ENV_FILE" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
fi

if [[ ! -s "$TOKEN_FILE" ]]; then
  uuidgen | tr '[:upper:]' '[:lower:]' > "$TOKEN_FILE"
  echo "Generated a new bridge token at $TOKEN_FILE"
fi
chmod 600 "$TOKEN_FILE"

export OS1_BACKEND="${OS1_BACKEND:-local}"
export OS1_ACCESS_TOKEN="${OS1_ACCESS_TOKEN:-$(cat "$TOKEN_FILE")}"
export HOST="${HOST:-0.0.0.0}"
export PORT="${PORT:-8788}"

cd "$APP_DIR"
exec node server/proxy.mjs
