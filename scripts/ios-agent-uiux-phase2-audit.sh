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

require 'AlmaConversationMenuSheet' "$assistant"
require 'conversationMenuTapped' "$assistant"
require 'rightBarButtonItems = \[plus, options\]' "$assistant"
require 'AgentProjectAssignmentSheet' "$assistant"
require 'assignConversationProject' "$assistant"
require 'AgentConversationSearchSheet' "$assistant"
require 'exportConversation' "$assistant"
require 'showDeleteConfirmation' "$assistant"
require 'sendNoContent' "$api"

echo "PASS: Phase 2 conversation/session management checks"
