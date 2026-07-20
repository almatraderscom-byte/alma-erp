# iOS Native Agent UI/UX — Phase 3 Report

## Outcome

Phase 3 makes uploaded and generated files first-class conversation objects without changing the existing assistant APIs or ALMA visual language.

- Added the normalized `AgentSessionFile` presentation model over persisted upload references and generated artifacts.
- The existing top file badge and conversation menu now open the same All/Uploaded/Generated hub.
- Added inline PDF/unknown-document cards; image thumbnails remain unchanged.
- Added native attachment choices for photo library, camera, and Files.
- Generalized the pending tray for images and PDFs, with retained failure state and tap-to-retry.
- Added signed download, Quick Look preview, native share/Save to Files, and temporary-cache cleanup.
- Added source-message navigation from the hub.
- Removed the artifact viewer's incorrect “requested ID missing → show last artifact” fallback.

## Contract-aware fallback

The current upload API accepts JPEG/PNG/WebP/HEIC/PDF, but not Markdown, and persisted `file_ref` rows do not retain original filename or byte size. Native UI therefore shows truthful storage-derived names and omits unavailable size metadata. Generated Markdown remains fully represented through the existing artifact contract. No backend route was changed for this UI-only gate.

## Verification

- `scripts/ios-agent-uiux-phase3-audit.sh`: PASS
- iPhone 17 Pro Max / iOS 26.5 simulator build: PASS
- Device UDID: `94E0186B-5CDA-4708-9368-53B4FF7274E7`
- Files hub launch PID: `66297`
- Attachment choices launch PID: `67982`
- Inline file-card launch PID: `68119`
- Failed-upload retention launch PID (final rebuilt binary): `73710`
- Swift diff whitespace check: PASS
- Simulator proofs: `docs/proofs/ios-uix-phase3/`

Existing project-wide compiler migration and CocoaPods script warnings remain outside this UI-only gate.
