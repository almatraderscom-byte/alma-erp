#!/usr/bin/env bash
set -euo pipefail

assistant="ios/App/App/AssistantSwiftUI.swift"

require() {
  local pattern="$1"
  if ! rg -q "$pattern" "$assistant"; then
    echo "FAIL: missing $pattern" >&2
    exit 1
  fi
}

require 'struct AgentSessionFile'
require 'var sessionFiles: \[AgentSessionFile\]'
require 'struct AgentInlineUploadedFileCard'
require 'struct AgentUploadedFileViewerSheet'
require 'AgentQuickLookPreview'
require 'fileImporter\(isPresented: \$showDocumentPicker'
require 'AgentCameraPicker'
require 'func retryPendingFile'
require 'state == \.failed'
require 'allowedContentTypes: \[\.pdf, \.image\]'
require 'showArtifacts = true'

for rejected in 'struct AgentSessionFilesHub' 'showFilesHub' 'showConversationMenu'; do
  if rg -q "$rejected" "$assistant"; then
    echo "FAIL: rejected Library/menu presentation remains: $rejected" >&2
    exit 1
  fi
done

if rg -q 'first\(where: \{ \$0\.id == artifactId \}\) \?\? rows\.last' "$assistant"; then
  echo "FAIL: artifact viewer still falls back to the wrong file" >&2
  exit 1
fi

echo "PASS: inline/attachment support retained; rejected Files hub isolated"
