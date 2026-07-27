# Handoff — iOS Agent Loader selector + Robot Pet

**Date:** 2026-07-26

**Branch:** `codex/ios-robot-pet-loader`

**Base:** latest `origin/main` at branch creation (`558110a18`)

**Purpose:** let a fresh session independently verify this native iOS feature,
combine it with the other session's iOS work, and request the owner's explicit
confirmation before any merge or TestFlight archive/upload.

## Owner boundary

- This branch is **not** merged.
- No TestFlight archive, export, upload, build-number bump, or production deploy
  was performed.
- The owner must explicitly approve the exact merge and then explicitly approve
  the TestFlight build/upload after combined Simulator verification. A generic
  "ok" is not TestFlight authorization.

## What this branch adds

1. `More → Settings → Agent Loader` is a real native setting.
2. The owner can choose:
   - `বর্তমান Starburst`
   - `Robot Pet`
3. The preference is stored in `UserDefaults` through `@AppStorage` using
   `alma.agent.loader.style`; it updates the real Agent chat loader immediately
   and survives app relaunch.
4. Robot Pet has distinct modes for understanding, thinking, research, tool
   use/search, writing, and idle.
5. Thinking has an animated thought bubble.
6. Writing uses only the sprite's original laptop scene. There is no second
   keyboard, laptop, or synthetic arm overlay. The baked hand/face frames play
   faster to read as active typing.
7. Existing mode haptic timing remains unchanged. Selecting a loader adds a
   lightweight `UISelectionFeedbackGenerator` tick.

## Performance decisions

- The 1536×2288 source sheet is never resized on every animation tick.
- `AlmaRobotPetFrameStore` crops the 30 required 192×208 frames once and keeps
  those small `UIImage` frames cached.
- Robot animation runs at 30 fps only while its active loader/preview is visible.
- Settled Robot Pet indicators pass `animated: false`, so their timeline is
  paused; active Agent work remains animated.
- `accessibilityReduceMotion` also pauses Robot motion.
- During the latest-main transplant, the owner-verified Starburst
  background/resume behavior from main was deliberately preserved: Starburst
  keeps its existing 30 fps, Reduce-Motion-only pause schedule. Do not replace it
  with a mode-dependent pause without re-testing background/foreground recovery.

## Files in scope

| File | Change |
|---|---|
| `ios/App/App/AlmaStarburstSpinner.swift` | Loader preference, Robot sprite/frame cache, per-mode motion/decorations, preview/selector, selected-style wrapper |
| `ios/App/App/AssistantSwiftUI.swift` | Selected loader in real Agent/current and background execution indicators; idle Robot is static |
| `ios/App/App/MoreMenuSwiftUI.swift` | Adds `Agent Loader` under Settings |
| `ios/App/App/SwiftUIShell.swift` | Native `Agent Loader` screen title/route host |
| `ios/App/App/Assets.xcassets/AlmaRobotPetSprite.imageset/` | Robot sprite asset + asset catalog metadata |
| `docs/handoff/2026-07-26-ios-robot-pet-loader-handoff.md` | This handoff |

No database migration, API change, web deployment, pod/package addition, or
build-number change is included.

## Verification completed before push

- Fresh branch Debug build against latest main: **SUCCEEDED** with Xcode 26.6,
  iPhone 17 Pro / iOS 26.5 Simulator destination.
- Installed the fresh-branch product in Simulator and opened the actual
  `More → Settings → Agent Loader` route.
- Confirmed `Robot Pet` remained selected and the selected artwork appeared in
  the real Agent chat's settled/current indicator.
- Turned Auto flow off, selected Writing, and captured two frames 230 ms apart.
  The face/hand pose changed and both frames contained only the original laptop.
- The earlier source branch also exercised a harmless real Agent turn and saw
  Robot mode transition from Thinking to Tool/Search. The fresh session must
  repeat that live check after combining branches.
- Simulator cannot physically validate haptic feel; that remains a device check.

The clean linked worktree initially lacked ignored/generated native dependencies.
For verification only, it reused the existing local `ios/App/Pods`,
`ios/App/App/public`, `config.xml`, and `capacitor.config.json`; none are part of
the commit. A new isolated worktree may need the project's normal CocoaPods and
Capacitor preparation before `xcodebuild`.

## Fresh-session verification checklist

Start from the branch itself, or cherry-pick its single feature commit onto the
other session's branch:

```bash
git fetch origin
git switch codex/ios-robot-pet-loader
```

Build for Simulator:

```bash
xcodebuild \
  -workspace ios/App/App.xcworkspace \
  -scheme App \
  -configuration Debug \
  -destination 'platform=iOS Simulator,name=iPhone 17 Pro' \
  -derivedDataPath /tmp/alma-ios-robot-loader-verify \
  CODE_SIGNING_ALLOWED=NO \
  build
```

Then independently verify:

1. Open `More → Settings → Agent Loader`.
2. Select Starburst, open Agent chat, and confirm the settled/current artwork
   switches to Starburst.
3. Return to Settings, select Robot Pet, force-quit/relaunch, and confirm
   `Robot Pet` is still selected.
4. In the preview, turn Auto flow off and inspect every mode:
   - Understanding: playful movement/message bubble.
   - Thinking: pet movement plus animated thought bubble.
   - Research: slower laptop/research motion.
   - Tool: quick search/orbit motion.
   - Writing: fast original-laptop frames only; no extra keyboard/arms.
   - Idle: quiet pose.
5. Capture two Writing screenshots about 200–250 ms apart and confirm the
   hand/face/body pose changes.
6. Send one harmless message in a fresh Agent session and confirm the real chat
   loader transitions through the server-provided modes. Do not approve any
   unrelated pending action created by old conversation context.
7. Scroll/type/switch tabs during active loading and compare Robot vs Starburst.
   The Robot path should not show extra stutter or higher sustained load.
8. Simulator cannot physically validate vibration. On the owner's iPhone,
   confirm loader-selection feedback and the existing per-mode haptic cadence.

## Combining with the other iOS session

Preferred approach:

```bash
git switch <other-session-branch>
git merge --no-ff codex/ios-robot-pet-loader
```

If the other branch already has a complex/divergent history, cherry-pick the
single feature commit instead:

```bash
git cherry-pick <commit-from-codex/ios-robot-pet-loader>
```

Likely conflict hot spots:

- `ios/App/App/AlmaStarburstSpinner.swift`
- `ios/App/App/AssistantSwiftUI.swift`
- `ios/App/App/MoreMenuSwiftUI.swift`
- `ios/App/App/SwiftUIShell.swift`

Conflict rules:

- Preserve the other session's newest Agent/chat behavior.
- Preserve the Robot selector, frame cache, all six Robot modes, and the
  original-laptop-only Writing scene.
- Preserve main's Starburst background/resume fix.
- After resolving, repeat the entire checklist on the combined branch; proof
  from either source branch is not proof of the merged result.

## TestFlight gate

Only after the owner reviews the combined Simulator proof and explicitly says
to proceed:

1. Confirm the combined branch includes latest `main`.
2. Re-run Debug Simulator verification.
3. Run the appropriate signed Release/device build.
4. Confirm the exact build number with the owner/other session.
5. Archive/export/upload once.

Do not infer TestFlight permission from this handoff or from permission to merge.
