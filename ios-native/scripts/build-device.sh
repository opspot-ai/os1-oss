#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DERIVED="$ROOT/DerivedData"
PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
UDID="${OS1_DEVICE_UDID:-$(idevice_id -l 2>/dev/null | head -1 || true)}"
COREDEVICE_ID="${OS1_COREDEVICE_ID:-$(xcrun devicectl list devices 2>/dev/null | awk '/iPhone/ && $0 !~ /unavailable/ { print $3; found=1; exit } END { if (!found) exit 1 }' || xcrun devicectl list devices 2>/dev/null | awk '/iPhone/ { print $3; exit }' || true)}"

cd "$ROOT"
scripts/bootstrap-config.sh
scripts/generate-project.sh

if ! xcrun --find devicectl >/dev/null 2>&1; then
  echo "devicectl missing. Full Xcode/iPhoneOS SDK is required." >&2
  exit 78
fi

DESTINATION="generic/platform=iOS"
if [[ -n "$UDID" ]] && xcodebuild -project OS1Native.xcodeproj -scheme OS1Native -showdestinations 2>/dev/null | grep -q "id:$UDID"; then
  DESTINATION="id=$UDID"
fi

xcodebuild \
  -project OS1Native.xcodeproj \
  -scheme OS1Native \
  -configuration Debug \
  -destination "$DESTINATION" \
  -derivedDataPath "$DERIVED" \
  -allowProvisioningUpdates \
  -allowProvisioningDeviceRegistration \
  build

APP_PATH="$DERIVED/Build/Products/Debug-iphoneos/OS1.app"
if [[ ! -d "$APP_PATH" ]]; then
  APP_PATH="$(find "$DERIVED/Build/Products/Debug-iphoneos" -maxdepth 1 -name 'OS1.app' -type d | head -1)"
fi
if [[ -z "$APP_PATH" ]]; then
  echo "No built .app found under $DERIVED/Build/Products/Debug-iphoneos" >&2
  exit 1
fi

if [[ -z "$COREDEVICE_ID" ]]; then
  echo "Built $APP_PATH, but no CoreDevice iPhone identifier is available for install." >&2
  echo "Connect/unlock the iPhone, trust this Mac, enable Developer Mode, then rerun this script." >&2
  exit 75
fi

if xcrun devicectl list devices | awk -v id="$COREDEVICE_ID" '$0 ~ id && $0 ~ /unavailable/ { found=1 } END { exit found ? 0 : 1 }'; then
  echo "Built $APP_PATH, but the iPhone is unavailable to CoreDevice." >&2
  echo "On iPhone: Settings > Privacy & Security > Developer Mode > On > Restart; after reboot unlock and tap Turn On." >&2
  exit 75
fi

xcrun devicectl device install app --device "$COREDEVICE_ID" "$APP_PATH"
echo "Installed $APP_PATH on $COREDEVICE_ID"
