#!/bin/bash
# ALMA Mac Agent — install as a launchd LaunchAgent (runs as the owner, never root).
#
#   bash install.sh <PAIRING-CODE> [BASE_URL]
#
# What it does:
#   1. copies the daemon to ~/.alma-mac-agent/
#   2. pairs it with the one-time code
#   3. installs + starts a LaunchAgent that keeps it running and restarts it on crash
#
# There is no sudo here on purpose: a LaunchAgent in ~/Library/LaunchAgents runs
# with the owner's own privileges, which is exactly as much power as this should have.
set -euo pipefail

CODE="${1:-}"
BASE_URL="${2:-https://alma-erp-six.vercel.app}"
SRC_DIR="$(cd "$(dirname "$0")" && pwd)"
DEST_DIR="$HOME/.alma-mac-agent"
PLIST_LABEL="com.alma.macagent"
PLIST_PATH="$HOME/Library/LaunchAgents/$PLIST_LABEL.plist"
NODE_BIN="$(command -v node || true)"

if [ -z "$CODE" ]; then
  echo "usage: bash install.sh <PAIRING-CODE> [BASE_URL]" >&2
  echo "Ask the agent in chat: \"Mac agent pair code dao\"" >&2
  exit 1
fi

if [ -z "$NODE_BIN" ]; then
  echo "node not found on PATH — install Node first (brew install node)" >&2
  exit 1
fi

echo "▸ installing to $DEST_DIR"
mkdir -p "$DEST_DIR"
chmod 700 "$DEST_DIR"
cp "$SRC_DIR/agent.mjs" "$SRC_DIR/policy.mjs" "$DEST_DIR/"
# M2 session driver ships alongside when present.
[ -f "$SRC_DIR/sessions.mjs" ] && cp "$SRC_DIR/sessions.mjs" "$DEST_DIR/"

echo "▸ pairing"
ALMA_BASE_URL="$BASE_URL" "$NODE_BIN" "$DEST_DIR/agent.mjs" pair "$CODE"

echo "▸ installing LaunchAgent"
mkdir -p "$HOME/Library/LaunchAgents"
cat > "$PLIST_PATH" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$PLIST_LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE_BIN</string>
    <string>$DEST_DIR/agent.mjs</string>
    <string>run</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>ALMA_BASE_URL</key><string>$BASE_URL</string>
    <key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:$HOME/.local/bin</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$DEST_DIR/stdout.log</string>
  <key>StandardErrorPath</key><string>$DEST_DIR/stderr.log</string>
  <key>ProcessType</key><string>Background</string>
</dict>
</plist>
PLIST

launchctl unload "$PLIST_PATH" 2>/dev/null || true
launchctl load "$PLIST_PATH"

echo "✓ ALMA Mac Agent installed and running"
echo
echo "  status : node $DEST_DIR/agent.mjs status"
echo "  logs   : tail -f $DEST_DIR/agent.log"
echo "  pause  : touch $DEST_DIR/PAUSED     (resume: rm that file)"
echo "  remove : launchctl unload $PLIST_PATH && rm -rf $DEST_DIR $PLIST_PATH"
