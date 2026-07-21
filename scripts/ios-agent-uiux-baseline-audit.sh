#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
assistant_file="$repo_root/ios/App/App/AssistantSwiftUI.swift"
project_file="$repo_root/ios/App/App.xcodeproj/project.pbxproj"
proof_dir="$repo_root/docs/proofs/ios-uix-phase0"

test -f "$assistant_file"
test -f "$project_file"

printf 'assistant_lines=%s\n' "$(wc -l < "$assistant_file" | tr -d ' ')"
printf 'button_sites=%s\n' "$(rg -c 'Button\s*\{' "$assistant_file")"
printf 'plain_button_styles=%s\n' "$(rg -c '\.buttonStyle\(\.plain\)' "$assistant_file")"
printf 'accessibility_modifiers=%s\n' "$(rg -c 'accessibility(Label|Hint|Value|Element)' "$assistant_file")"
printf 'reduce_motion_sites=%s\n' "$(rg -c 'accessibilityReduceMotion' "$assistant_file")"
printf 'reduce_transparency_sites=%s\n' "$(rg -c 'accessibilityReduceTransparency' "$assistant_file" || true)"
printf 'direct_haptic_sites=%s\n' "$(rg -c 'UI(Selection|Impact|Notification)FeedbackGenerator' "$assistant_file")"

rg -q 'assistant\.open\.begin' "$assistant_file"
rg -q 'assistant\.contentReady' "$assistant_file"
rg -q 'sync\.olderPage\.begin' "$assistant_file"
rg -q 'sync\.olderPage\.end' "$assistant_file"
rg -q 'turn\.finalize\.begin' "$assistant_file"
rg -q 'turn\.finalize\.end' "$assistant_file"
rg -q 'artifact\.preview\.begin' "$assistant_file"
rg -q 'artifact\.preview\.ready' "$assistant_file"

test -s "$proof_dir/baseline-assistant-mixed-dark.png"
printf 'baseline_proof=PASS\n'
