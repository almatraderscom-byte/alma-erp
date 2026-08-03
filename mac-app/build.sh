#!/bin/bash
# Build ALMA for Mac without Xcode project bookkeeping: swiftc straight to a .app.
# Small enough that a full project would be more machinery than the app itself.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
APP="$HERE/build/ALMA.app"
BASE_URL="${1:-https://alma-erp-six.vercel.app}"

rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"

cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>ALMA</string>
  <key>CFBundleDisplayName</key><string>ALMA</string>
  <key>CFBundleIdentifier</key><string>com.alma.mac</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>CFBundleShortVersionString</key><string>1.0</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleExecutable</key><string>ALMA</string>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
  <key>NSHighResolutionCapable</key><true/>
</dict>
</plist>
PLIST

echo "▸ compiling"
swiftc -O \
  -target arm64-apple-macos13.0 \
  -framework SwiftUI -framework WebKit -framework AppKit \
  -parse-as-library \
  -o "$APP/Contents/MacOS/ALMA" \
  "$HERE/AlmaMac/AlmaMacApp.swift"

echo "✓ built $APP"
echo "  run: ALMA_BASE_URL=$BASE_URL open '$APP'"
