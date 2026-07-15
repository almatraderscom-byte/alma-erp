#!/usr/bin/env bash
# Render every Dynamic Panel state to a PNG — the spec §20 snapshot pass.
#
# WHY THIS EXISTS: a Live Activity's lock-screen view normally can only be seen
# on a real device, because `ActivityViewContext` has no public initialiser and
# so the view can't be constructed in a test. PulseLockScreenView therefore takes
# a plain (title, state, mode) instead, which lets this throwaway harness compile
# the REAL widget source and render it offscreen with ImageRenderer. The PNGs are
# proof of the shipping code, not of a mock.
#
# Renders each state in light + dark, plus a long-Bengali/large-count stress case
# and an accessibilityLarge case (spec §18).
#
# ⚠️ The simulator is SHARED with the owner's other Claude sessions — only run
# this when he has said the sim is free (see the no-sim-driving owner rule).
#
# Usage: bash scripts/pulse-snapshot/render.sh [outdir]
set -euo pipefail

UDID="${ALMA_SIM_UDID:-94E0186B-5CDA-4708-9368-53B4FF7274E7}"
OUT="${1:-/tmp/pulse-shots}"
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
WORK="$(mktemp -d)"
BUNDLE_ID="com.almatraders.pulsesnap"

echo "▸ compiling harness against the real widget source…"
SDK="$(xcrun --sdk iphonesimulator --show-sdk-path)"
mkdir -p "$WORK/Snap.app"
swiftc -sdk "$SDK" -target arm64-apple-ios17.0-simulator -parse-as-library \
  -o "$WORK/Snap.app/Snap" \
  "$REPO/scripts/pulse-snapshot/main.swift" \
  "$REPO/ios/App/App/PulseActivityAttributes.swift" \
  "$REPO/ios/App/AlmaWidget/PulseLiveActivity.swift"

cat > "$WORK/Snap.app/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleExecutable</key><string>Snap</string>
  <key>CFBundleIdentifier</key><string>com.almatraders.pulsesnap</string>
  <key>CFBundleName</key><string>Snap</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>CFBundleShortVersionString</key><string>1.0</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>LSRequiresIPhoneOS</key><true/>
  <key>UIDeviceFamily</key><array><integer>1</integer></array>
  <key>MinimumOSVersion</key><string>17.0</string>
  <key>UILaunchScreen</key><dict/>
</dict>
</plist>
PLIST

echo "▸ installing + running in sim $UDID…"
xcrun simctl boot "$UDID" 2>/dev/null || true
xcrun simctl install "$UDID" "$WORK/Snap.app"
xcrun simctl launch --console-pty "$UDID" "$BUNDLE_ID" 2>&1 | grep PULSESNAP_DONE || true
sleep 2

CONTAINER="$(xcrun simctl get_app_container "$UDID" "$BUNDLE_ID" data)"
mkdir -p "$OUT"
cp "$CONTAINER/Documents/"*.png "$OUT/" 2>/dev/null || { echo "✗ no PNGs rendered"; exit 1; }

# Leave the sim exactly as we found it.
xcrun simctl uninstall "$UDID" "$BUNDLE_ID" >/dev/null 2>&1 || true
rm -rf "$WORK"

echo "✓ rendered $(ls -1 "$OUT"/*.png | wc -l | tr -d ' ') states → $OUT"
ls -1 "$OUT"
