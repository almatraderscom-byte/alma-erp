#!/usr/bin/env bash
set -euo pipefail

assistant="ios/App/App/AssistantSwiftUI.swift"
api="ios/App/App/AlmaAPI.swift"

require() {
  local pattern="$1"
  local file="$2"
  if ! rg -q "$pattern" "$file"; then
    echo "FAIL: missing $pattern in $file" >&2
    exit 1
  fi
}

require 'assignConversationProject' "$assistant"
require 'exportConversation' "$assistant"
require 'sendNoContent' "$api"

for rejected in \
  'AlmaConversationMenuSheet' \
  'conversationMenuTapped' \
  'rightBarButtonItems = \[plus, options\]' \
  'showConversationMenu'; do
  if rg -q "$rejected" "$assistant"; then
    echo "FAIL: rejected Gate 9 presentation remains: $rejected" >&2
    exit 1
  fi
done

require 'rightBarButtonItem = plus' "$assistant"

echo "PASS: superseded conversation menu isolated; non-visual helpers retained"
