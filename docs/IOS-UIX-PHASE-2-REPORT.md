# iOS Native Agent UI/UX — Phase 2 Scope Correction

## Outcome

The conversation ellipsis UI previously implemented in this branch was based on
superseded roadmap wording. Its detented bottom-sheet presentation, trigger, and
supporting screen state have been isolated from the Gate 0–3 merge.

Gate 0–3 keeps the existing ALMA header (hamburger + coral plus), aurora,
composer, loader, message layout, durable queue, approvals, and turn recovery.
The server-confirmed conversation mutation/export helpers remain non-visual
building blocks for the dedicated conversation-management gate.

## Dedicated Gate 9 target

- Source-anchored compact glossy popover beside/below the three-dot control.
- No bottom-sheet adaptation, drag indicator, full-width resize, keyboard
  dismissal, draft reset, or scroll displacement.
- Share, Pin/Unpin, Project, Uploaded files, Search, Export, Rename, Archive,
  and separated destructive Delete hierarchy.
- Outside-tap dismissal and immediate press/gloss feedback.

The old `docs/proofs/ios-uix-phase2/` images are historical rejected-state
captures only. They are not acceptance evidence for the corrected Gate 9 UI.

## Verification

- `scripts/ios-agent-uiux-phase2-audit.sh`: asserts the rejected presentation is absent.
- iPhone 17 Pro Max / iOS 26.5 simulator build: PASS.
- Loader/composer preservation screenshot:
  `docs/proofs/ios-uix-merge-readiness/gate9-isolated-loader-composer-preserved.png`.
