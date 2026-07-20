#!/usr/bin/env bash
set -euo pipefail

assistant="ios/App/App/AssistantSwiftUI.swift"
voice="ios/App/App/AssistantVoiceSwiftUI.swift"

require() {
  local pattern="$1"
  local file="$2"
  if ! rg -q "$pattern" "$file"; then
    echo "FAIL: missing $pattern in $file" >&2
    exit 1
  fi
}

require 'struct AlmaAgentPressStyle' "$assistant"
require 'accessibilityReduceTransparency' "$assistant"
require 'submittingActionKeys' "$assistant"
require 'continueInChat: Bool = true' "$assistant"
require 'continueInChat: false' "$voice"

if rg -q '\.buttonStyle\(\.plain\)' "$assistant"; then
  echo "FAIL: unnormalised plain button style remains in AssistantSwiftUI.swift" >&2
  exit 1
fi

direct_haptics="$(rg -n 'UISelectionFeedbackGenerator|UIImpactFeedbackGenerator|UINotificationFeedbackGenerator' "$assistant" | rg -v 'static func' || true)"
if [[ -n "$direct_haptics" ]]; then
  echo "FAIL: direct haptic generator remains outside AlmaAgentHaptics" >&2
  echo "$direct_haptics" >&2
  exit 1
fi

echo "PASS: Phase 1 interaction foundation checks"
