# iOS Native Agent UI/UX — Phase 1 Report

## Outcome

Phase 1 establishes shared native interaction behaviour while retaining ALMA's existing visual language.

- Added a behaviour-only press style and applied it across Assistant buttons without changing their labels, colors, or shapes.
- Added a shared 44-point hit-target helper for compact composer and pager controls.
- Centralized Agent haptic semantics in one wrapper.
- Added a Reduce Transparency fallback for Agent material surfaces.
- Added view-model mutation guards so approval, question, artifact-save, and opinion actions cannot double-submit.
- Made action-card state changes wait for server confirmation; failures retain the actionable state.
- Fixed voice ask-card answers creating two turns: persistence now completes first, then voice starts exactly one turn.

## Verification

- `scripts/ios-agent-uiux-phase1-audit.sh`: PASS
- iPhone 17 Pro Max / iOS 26.5 simulator build: PASS
- Swift diff whitespace check: PASS
- Simulator visual review: recorded under `docs/proofs/ios-uix-phase1/`

Existing project-wide Swift 6 migration and CocoaPods script warnings remain outside this roadmap's UI-only scope.
