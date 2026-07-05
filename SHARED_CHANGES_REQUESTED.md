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
