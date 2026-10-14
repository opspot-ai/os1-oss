#!/usr/bin/env bash
set -euo pipefail

# Generates ios-native/Config/Local.xcconfig (gitignored) from the running
# bridge: its access token plus a host the phone can actually reach.
#
#   OS1_TOKEN_FILE   file holding the bridge access token
#   OS1_HOST         force a specific host/IP
#   OS1_URL          force the whole base URL
#   OS1_PORT         bridge port (default 8788)
#   OS1_BUNDLE_ID    iOS bundle identifier
#   DEVELOPMENT_TEAM Apple Developer Team ID

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TOKEN_FILE="${OS1_TOKEN_FILE:-${TMPDIR:-/tmp}/os1-bridge-token}"
PORT="${OS1_PORT:-8788}"
BUNDLE_ID="${OS1_BUNDLE_ID:-com.example.os1.native}"

if [[ ! -s "$TOKEN_FILE" ]]; then
  echo "No bridge token at $TOKEN_FILE. Start the bridge first (pwa/scripts/run-local.sh)," >&2
  echo "or point OS1_TOKEN_FILE at the file holding your token." >&2
  exit 66
fi

TOKEN="$(cat "$TOKEN_FILE")"

choose_host() {
  if [[ -n "${OS1_HOST:-}" ]]; then
    printf '%s\n' "$OS1_HOST"
    return
  fi

  # If a personal VPN (Tailscale) is available, prefer its address so the phone
  # can reach the bridge off your local Wi-Fi. Otherwise fall back to the LAN IP.
  if command -v tailscale >/dev/null 2>&1; then
    local tail_ip
    tail_ip="$(tailscale ip -4 2>/dev/null | awk '/^[0-9]+\./ { print; exit }' || true)"
    if [[ -n "$tail_ip" ]]; then
      printf '%s\n' "$tail_ip"
      return
    fi
  fi

  ipconfig getifaddr en0 || ipconfig getifaddr en1
}

if [[ -n "${OS1_URL:-}" ]]; then
  URL="$OS1_URL"
else
  IP="$(choose_host)"
  URL="http://${IP}:${PORT}"
fi

# xcconfig treats // as a comment, so use an empty build-setting expansion
# between the slashes. Xcode expands http:/$()/host back to http://host.
XCCONFIG_URL="$(printf '%s' "$URL" | sed 's#://#:/$()/#')"

mkdir -p "$ROOT/Config"
cat > "$ROOT/Config/Local.xcconfig" <<EOF
OS1_SERVER_URL = ${XCCONFIG_URL}
OS1_ACCESS_TOKEN = ${TOKEN}
DEVELOPMENT_TEAM = ${DEVELOPMENT_TEAM:-}
OS1_BUNDLE_ID = ${BUNDLE_ID}
EOF
chmod 600 "$ROOT/Config/Local.xcconfig"

cat > "$ROOT/Config/GeneratedBridgeConfig.swift" <<EOF
import Foundation

enum GeneratedBridgeConfig {
    static let serverURL = bundleValue("OS1ServerURL")
    static let accessToken = bundleValue("OS1AccessToken")

    private static func bundleValue(_ key: String) -> String {
        guard let value = Bundle.main.object(forInfoDictionaryKey: key) as? String else { return "" }
        return value.contains("\$(") ? "" : value.trimmingCharacters(in: .whitespacesAndNewlines)
    }
}
EOF
chmod 600 "$ROOT/Config/GeneratedBridgeConfig.swift"

echo "Wrote Config/Local.xcconfig and non-secret GeneratedBridgeConfig.swift for ${URL} with token redacted."
