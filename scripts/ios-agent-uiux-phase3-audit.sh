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
require 'struct AgentSessionFilesHub'
require 'case all = "সব", uploaded = "আপলোড", generated = "তৈরি করা"'
require 'struct AgentInlineUploadedFileCard'
require 'struct AgentUploadedFileViewerSheet'
require 'AgentQuickLookPreview'
require 'fileImporter\(isPresented: \$showDocumentPicker'
require 'AgentCameraPicker'
require 'func retryPendingFile'
require 'state == \.failed'
require 'allowedContentTypes: \[\.pdf, \.image\]'

if rg -q 'first\(where: \{ \$0\.id == artifactId \}\) \?\? rows\.last' "$assistant"; then
  echo "FAIL: artifact viewer still falls back to the wrong file" >&2
  exit 1
fi

echo "PASS: Phase 3 universal Files/attachment checks"
