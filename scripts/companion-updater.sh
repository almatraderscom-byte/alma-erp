#!/bin/sh
# ALMA Companion auto-updater — keeps the unpacked Chrome extension folder on
# THIS machine in sync with what production serves (which republishes on every
# main merge). The extension reloads itself when it sees the newer version on
# disk, so updates need zero clicks after the one-time setup.
#
#   Sync once :  sh companion-updater.sh [target-folder]
#   Install   :  sh companion-updater.sh --install [target-folder]
#                (macOS: writes a LaunchAgent that syncs every 30 min + at login)
#
# Default target folder: ~/alma-companion   (pass a path to override, e.g. the
# existing ~/Desktop/alma-companion load location)
set -eu

SITE="${ALMA_SITE:-https://alma-erp-six.vercel.app}"

MODE="sync"
if [ "${1:-}" = "--install" ]; then MODE="install"; shift; fi
TARGET="${1:-$HOME/alma-companion}"

sync_once() {
  META="$(curl -fsSL "$SITE/companion-version.json")" || { echo "version fetch failed"; exit 0; }
  RVER="$(printf '%s' "$META" | /usr/bin/python3 -c 'import sys,json;print(json.load(sys.stdin)["version"])')"
  LVER="$(/usr/bin/python3 -c 'import sys,json;print(json.load(open(sys.argv[1]))["version"])' "$TARGET/manifest.json" 2>/dev/null || echo none)"
  if [ "$RVER" = "$LVER" ]; then
    echo "already up to date (v$LVER)"
    return 0
  fi
  TMP="$(mktemp -d)"
  trap 'rm -rf "$TMP"' EXIT
  printf '%s' "$META" | /usr/bin/python3 -c 'import sys,json;[print(f) for f in json.load(sys.stdin)["files"]]' | while IFS= read -r f; do
    case "$f" in *..*) echo "skipping suspicious path: $f"; continue;; esac
    mkdir -p "$TMP/$(dirname "$f")"
    curl -fsSL "$SITE/companion/$f" -o "$TMP/$f"
  done
  # Sanity: only overwrite if we really downloaded the ALMA Companion manifest.
  grep -q '"ALMA Companion"' "$TMP/manifest.json" || { echo "sanity check failed — aborting"; exit 1; }
  mkdir -p "$TARGET"
  rsync -a --delete "$TMP/" "$TARGET/"
  echo "updated $TARGET: v$LVER → v$RVER (extension reloads itself within a few minutes)"
}

install_agent() {
  # Keep a stable copy of this script for launchd to run.
  mkdir -p "$HOME/.alma"
  SELF="$HOME/.alma/companion-updater.sh"
  if [ "$(cd "$(dirname "$0")" && pwd)/$(basename "$0")" != "$SELF" ]; then
    cp "$0" "$SELF" 2>/dev/null || curl -fsSL "$SITE/companion-updater.sh" -o "$SELF"
  fi
  chmod +x "$SELF"

  PLIST="$HOME/Library/LaunchAgents/com.alma.companion-updater.plist"
  mkdir -p "$HOME/Library/LaunchAgents"
  cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.alma.companion-updater</string>
  <key>ProgramArguments</key><array>
    <string>/bin/sh</string><string>$SELF</string><string>$TARGET</string>
  </array>
  <key>StartInterval</key><integer>1800</integer>
  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>$HOME/.alma/companion-updater.log</string>
  <key>StandardErrorPath</key><string>$HOME/.alma/companion-updater.log</string>
</dict></plist>
EOF
  launchctl unload "$PLIST" 2>/dev/null || true
  launchctl load "$PLIST"
  echo "installed: syncs $TARGET every 30 min (+ at login); log: ~/.alma/companion-updater.log"
  sync_once
}

if [ "$MODE" = "install" ]; then install_agent; else sync_once; fi
