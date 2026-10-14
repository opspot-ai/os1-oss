#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

if [[ ! -f Config/Local.xcconfig || ! -f Config/GeneratedBridgeConfig.swift ]]; then
  scripts/bootstrap-config.sh
fi

if ! command -v xcodegen >/dev/null 2>&1; then
  echo "xcodegen is missing. Install with: brew install xcodegen" >&2
  exit 127
fi

xcodegen generate
