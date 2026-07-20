# iOS Native Agent UI/UX — Phase 3 Scope Correction

## Outcome

The detented `AgentSessionFilesHub` previously added in this branch is not the
approved Library design and has been isolated from the Gate 0–3 merge.

The non-visual file index, inline uploaded/generated file representation,
attachment picker, failed-upload retention/retry, signed download, and Quick
Look support remain. Generated artifacts continue to appear in their original
conversation position. The pre-existing generated-artifact badge again opens
the pre-existing artifact surface; it does not expose the rejected Files hub.

## Dedicated Gate 9 Library target

- Large inset/full-height native `Library` surface with rounded top corners,
  centered title, and circular top-right Close button.
- Unified current-session uploaded and generated index, defaulting to All.
- Image thumbnails and semantic PDF/Markdown/document previews.
- Open, Preview, Download, Share, Save, and Show in conversation actions.
- Truthful empty state only after the unified index is genuinely empty.

The old `docs/proofs/ios-uix-phase3/phase3-session-files-hub.png` image is a
historical rejected-state capture only. It is not corrected Library evidence.

## Verification

- `scripts/ios-agent-uiux-phase3-audit.sh`: verifies inline/attachment support
  remains while the rejected hub is absent.
- iPhone 17 Pro Max / iOS 26.5 simulator build: PASS.
- Swift diff whitespace check: PASS.
