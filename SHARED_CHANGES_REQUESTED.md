# SHARED CHANGES QUEUE (append-only)

Parallel page sessions may NOT edit frozen/shared files (NATIVE_MIGRATION_HANDOFF.md §2).
Instead they APPEND a request here and keep working. The OWNER applies these centrally,
serially, between sessions, then marks them ✅ APPLIED (with commit hash).

**Never rewrite or delete another session's entry. Add yours at the bottom.**

## Entry format (copy this block)

```
### [PENDING] <page-slug> — <one-line title>
- Session: native/<page-slug>   Date: YYYY-MM-DD
- File(s): <exact frozen file path(s)>
- Exact change: <precise diff-level description — e.g. the 4 pbxproj entries for
  ios/App/App/FooSwiftUI.swift, or "add More-menu row X → FooScreen">
- Why: <one sentence — what breaks without it>
```

Owner flips `[PENDING]` → `[✅ APPLIED <commit>]` or `[❌ REJECTED — reason]`.

---

## Queue

### [✅ APPLIED — same commit as AssistantSwiftUI.swift] agent-chat — S6b native Assistant wiring (FYI, no action needed)
- Session: assistant session (direct owner instruction 2026-07-06, predates this queue)   Date: 2026-07-06
- File(s): `ios/App/App.xcodeproj/project.pbxproj`, `ios/App/App/SpikeNativeShell.swift`, `ios/App/App/SwiftUIShell.swift`
- Exact change: pbxproj = 4 additive entries for AssistantSwiftUI.swift (ids `…A021`/`…B021`,
  deliberately gapped from the …A015 series to avoid id collisions); SpikeNativeShell = the
  inline Assistant web-tab construction in `AlmaTabBarController.init` replaced by
  `makeAssistantTab()` (the old construction moved VERBATIM into that builder's else-branch in
  AssistantSwiftUI.swift); SwiftUIShell = `onSwiftUIFlagChanged` now also swaps `vcs[2]`.
- Why: the owner directly instructed the Assistant section be migrated native in a parallel
  session; these shared edits were applied + sim-verified (both themes, E2E streamed turn,
  flag-off web fallback) and REBASED onto build-36 before pushing — logged here so the
  integrator knows the pbxproj/shell deltas on the branch are intentional.

### [✅ APPLIED — commit 57cb5c2c] agent-chat — AssistantVoiceSwiftUI.swift pbxproj registration (FYI)
- Session: assistant session   Date: 2026-07-06
- File(s): `ios/App/App.xcodeproj/project.pbxproj`
- Exact change: 4 additive entries for `AssistantVoiceSwiftUI.swift` (ids `…A022`/`…B022`).
- Why: the native voice-to-voice orb console (owner bundle design) lives in its own file.

### [⏳ REQUESTED] voice-console — SFSpeechRecognizer "ALMA" wake word needs an Info.plist key
- Session: web-voice session (owner instruction 2026-07-06: port full web orb-page parity into AssistantVoiceSwiftUI.swift)   Date: 2026-07-06
- File(s): `ios/App/App/Info.plist` (frozen — owner applies)
- Exact change: add `NSSpeechRecognitionUsageDescription` = "ALMA আপনার 'ALMA' ডাক শুনতে ভয়েস চিনবে।" (any Bangla string). Without this key, ANY SFSpeechRecognizer call crashes instantly (see memory feedback_ios_plugin_privacy_keys / the 2026-07-03 Face-ID incident) — so the on-device "ALMA" wake word (the one web feature that never worked on iOS: webkitSpeechRecognition is absent in WKWebView) is DELIBERATELY NOT implemented in this branch. Once the key is added, a follow-up can add an SFSpeechRecognizer always-listening bridge that calls AlmaVoiceEngine.startListening() on the "ALMA/আলমা" hit (idle + console-open only).
- Why: it is the single remaining web-orb feature not portable without a frozen-file (plist) change; everything else (streaming STT, TTS number/brand normalizer, model-switch + verification-retry spoken, ask/approval-in-console, history scrollback) shipped inside the already-registered AssistantVoiceSwiftUI.swift with no shared-file edits.
