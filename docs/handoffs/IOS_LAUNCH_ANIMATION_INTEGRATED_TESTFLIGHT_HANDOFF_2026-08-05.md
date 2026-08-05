# iOS Launch Animation + Integrated TestFlight Handoff

Date: 2026-08-05
Owner: Maruf Billah
Source branch at handoff: `codex/ios-agent-chat-voice-integration`
Source HEAD before this document: `7438c04a`
Launch implementation landed inside: `3a9acb1f`

## Authority and non-negotiable release gate

This document hands the approved Preview v4 launch animation to the session that is already finishing other iOS/TestFlight work. That receiving session must combine and verify **its own work plus this launch work as one candidate**.

Do not bump a build number, create the final archive, or upload to TestFlight until all required checks below pass and Maruf gives explicit confirmation for the exact candidate branch and commit SHA.

The previously exported `1.0 (96)` IPA is verification evidence only. It predates the receiving session's final combined candidate and must not be uploaded as that candidate.

## Canonical references

Read these before changing the implementation:

- Implementation brief:
  `/Users/marufbillah/Documents/Codex/2026-08-05/referenced-chatgpt-conversation-this-is-an/outputs/LAUNCH_ANIMATION_IMPLEMENTATION.md`
- Owner-approved Preview v4:
  `/Users/marufbillah/.codex/visualizations/2026/08/04/019fce62-37e5-7a30-a2e6-f327bacb91e0/launch-preview-v4-standalone.html`
- Production simulator recording:
  `ios/App/build/launch-v4-verification/launch-v4-iPhone17Pro-production.mp4`

The brief and Preview v4 define the visual/product contract. The recording proves the current native implementation with authenticated production dashboard data. Build artifacts under `ios/App/build/` are local/ignored and may not exist in a fresh clone.

## Locked launch behavior

The integrated candidate must preserve every item below exactly:

1. Total launch timeline is approximately `10.4 s`, matching approved Preview v4.
2. The launch uses the existing production Office Robot sprite renderer. Do not introduce a second robot asset or a mock dashboard.
3. The real native dashboard starts loading underneath the temporary launch overlay.
4. The robot begins fully off-screen, drops from the Dynamic Island area, lands, performs awareness/look/blink, exactly two distinct hops, dance, spin, activation, reveal, merge, and fixed-host reaction.
5. Haptics only; no launch sound:
   - landing: soft
   - activation: light
   - merge: medium
6. The app-wide fixed Robot is suppressed while the launch Robot is visible. There must never be two visible Robot owners.
7. During merge, the launch Robot moves to the fixed Robot's current real destination, is absorbed, and disappears only when the canonical fixed host takes ownership.
8. At handoff the canonical fixed Robot performs the approved `1.22` pop, settle, and small shake. Its badge, saved dock position, tap/long-press behavior, and pending-action behavior remain intact.
9. The Robot must never vanish in the middle of the animation. On dashboard/auth/offline/error cancellation, fail open directly to one canonical fixed Robot.
10. Dashboard readiness may hold the activation point at approximately `7.05 s` for at most `2.5 s`; it must not hang indefinitely.
11. Reduce Motion and Low Power mode use the direct final-state path. Reduce Transparency uses the opaque fallback.
12. VoiceOver exposes a single meaningful launch status and does not expose decorative grid/particle elements.
13. The rollback flag remains available through `alma.launchRobot.enabled`.
14. No third-party animation dependency is added.

## Production implementation map

- `ios/App/App/AppDelegate.swift`
  - Installs `LaunchRobotCoordinator` after the real root hierarchy exists.
- `ios/App/App/DashboardSwiftUI.swift`
  - Publishes authenticated content-ready and unavailable/auth/error signals without replacing production loading behavior.
- `ios/App/App/GlobalOfficeRobotView.swift`
  - Contains `LaunchRobotTimeline`, animation model, SwiftUI overlay, readiness hold, effects, haptics, accessibility, and `LaunchRobotCoordinator`.
- `ios/App/App/FloatingChatHead.swift`
  - Provides the real fixed-host destination and owns the final pop/settle/shake handoff.
- `ios/App/AppParityV2Tests/GlobalOfficeRobotTests.swift`
  - Covers off-screen entry, visible awareness, exactly two hop phases, landing/activation effects, and single-owner merge completion.

Important overlap: commit `3a9acb1f` also contains other Agent/chat work. Do not blindly cherry-pick individual launch files over the receiving session's versions, and do not blindly choose “ours” or “theirs” for conflicts. Resolve by preserving both behavior contracts.

Likely integration hotspots:

- `ios/App/App/AppDelegate.swift`
- `ios/App/App/DashboardSwiftUI.swift`
- `ios/App/App/FloatingChatHead.swift`
- `ios/App/App/GlobalOfficeRobotView.swift`
- `ios/App/App/AssistantSwiftUI.swift`
- `ios/App/App/AssistantVoiceSwiftUI.swift`
- `ios/App/App.xcodeproj/project.pbxproj`

## Existing verification evidence

Native proof used only this newly created device for installation and launch verification:

- Device: `ALMA Launch V4 iPhone 17 Pro`
- Runtime: iOS 26.5
- UDID: `25DF9F01-DB5A-4E0F-8193-BE115D57D53F`

The simulator was authenticated using an existing local iPhone 17 Pro ALMA session without exposing credentials. Production dashboard revenue/order/approval data rendered under the animation.

Verified:

- PASS — Debug App + Widget workspace build.
- PASS — focused `GlobalOfficeRobotTests`: 9 tests, 0 failures.
- PASS — authenticated production-data launch recording.
- PASS — unauthenticated fail-open ends with one fixed Robot.
- PASS — handoff and final screenshots contain one Robot owner, not two.
- PASS — badge and fixed dock position survive the handoff.
- PASS — signed Release archive `1.0 (96)`.
- PASS — App Store Connect export produced a valid 74 MB IPA with Cloud Managed Apple Distribution signing.

Evidence paths:

- `ios/App/build/launch-v4-verification/launch-v4-iPhone17Pro-production.mp4`
- `ios/App/build/launch-v4-verification/production-dance.png`
- `ios/App/build/launch-v4-verification/production-handoff.png`
- `ios/App/build/launch-v4-verification/production-final-single-host.png`
- `ios/App/build/launch-v4-verification/unauthenticated-fail-open.png`
- `ios/App/build/ALMA-ERP-1.0-96.xcarchive`
- `ios/App/build/TestFlight-1.0-96/App.ipa`

The tactile strength of haptics remains a real-iPhone-only check; Simulator verifies trigger timing/code paths but cannot reproduce physical feedback.

## Required receiving-session procedure

1. Read this document and the receiving session's own handoff/specs completely.
2. Record:
   - receiving branch and SHA
   - this source branch and SHA
   - current `origin/main` SHA
3. Preserve any dirty/user-owned work. Do not reset, discard, or overwrite it.
4. Create or use one clean integration candidate based on current `origin/main`, then bring in both bodies of work.
5. Inspect conflicts in every hotspot above and resolve by behavior, not file selection.
6. Confirm the integrated source still contains:
   - `LaunchRobotTimeline`
   - `LaunchRobotCoordinator`
   - dashboard readiness/unavailable notifications
   - `FloatingChatHead.completeLaunchMerge(animated:)`
   - the focused launch tests
7. Run all checks required by the receiving session's own work, plus the launch-specific gates below.
8. Use the already booted/authenticated device `25DF9F01-DB5A-4E0F-8193-BE115D57D53F` for the fastest native verification. Every `simctl` and `xcodebuild -destination` command must use this explicit UDID.
9. Do not install the candidate on any iPhone 17 Pro Max simulator.
10. Record one fresh cold launch over authenticated production dashboard data and inspect the entire sequence, especially `8.0–10.4 s` frame by frame.
11. Verify the receiving session's own feature flow in the same installed candidate.
12. Report the exact candidate branch, commit SHA, changed-file scope, commands, test counts, simulator observations, visual artifacts, and hardware-only checks to Maruf.
13. If anything is not a 100% match, fix and repeat verification. Do not request TestFlight approval yet.
14. When everything matches, ask Maruf for explicit confirmation for that exact SHA and proposed build number.

## Mandatory launch-specific gates

From `ios/App`:

```bash
xcodebuild \
  -workspace App.xcworkspace \
  -scheme App \
  -configuration Debug \
  -destination 'platform=iOS Simulator,id=25DF9F01-DB5A-4E0F-8193-BE115D57D53F' \
  -derivedDataPath /tmp/alma-integrated-testflight-dd \
  CODE_SIGNING_ALLOWED=NO \
  build
```

```bash
xcodebuild \
  -workspace App.xcworkspace \
  -scheme App \
  -configuration Debug \
  -destination 'platform=iOS Simulator,id=25DF9F01-DB5A-4E0F-8193-BE115D57D53F' \
  -derivedDataPath /tmp/alma-integrated-testflight-dd \
  -only-testing:AppParityV2Tests/GlobalOfficeRobotTests \
  CODE_SIGNING_ALLOWED=NO \
  test
```

Also required:

```bash
git diff --check
npm run type-check
```

Run any broader unit/UI/agent/voice suites required by the receiving session's own changes. The focused launch suite is additive, not a substitute.

## Visual acceptance checklist

- Robot starts completely above the visible screen.
- Landing reads clearly and does not clip under Dynamic Island/status UI.
- Awareness look/blink remains visible; Robot does not disappear.
- Exactly two hops occur.
- Dance and spin remain smooth with no frozen sprite frame.
- Production dashboard reveals behind the animation; no demo data or mock screenshot is used.
- Activation does not stall indefinitely on slow data.
- Merge targets the real current fixed Robot position.
- At no frame are two full Robots visible.
- The launch Robot is absorbed before the canonical host pop.
- Fixed Robot pop/settle/shake is visible but not excessive.
- Final Robot retains its badge and interactions.
- Unauthenticated/error/offline path ends cleanly with one fixed Robot.
- Receiving session's own features still work after the launch flow.

## TestFlight gate after Maruf confirms

Only after explicit confirmation for the exact candidate SHA:

1. Confirm the candidate worktree is clean, current with `origin/main`, and pushed.
2. Run `bash scripts/ios-build-preflight.sh`; fix failures instead of bypassing them.
3. Choose the next unused TestFlight build number. Do not reuse verification build `96` blindly.
4. Update `CURRENT_PROJECT_VERSION` in source, commit the build bump, and push it.
5. Archive the exact pushed commit with Release configuration.
6. Confirm archive `ALMAGitCommit`/SHA and version/build metadata match the pushed commit.
7. Export and upload exactly once.
8. Report upload/build-processing status to Maruf. Do not submit for App Review unless separately requested.

Suggested confirmation request:

> Combined candidate `<branch>` at `<full SHA>` passed all own-work and launch-animation gates on `ALMA Launch V4 iPhone 17 Pro`. Proposed TestFlight build is `<build number>`. Do you confirm that I may bump, archive, push, and upload this exact candidate?

## Copy-paste prompt for the receiving session

```text
Read this handoff completely before changing or building anything:
/Users/marufbillah/alma-erp/docs/handoffs/IOS_LAUNCH_ANIMATION_INTEGRATED_TESTFLIGHT_HANDOFF_2026-08-05.md

Your task is to combine your current iOS/TestFlight work with the launch-animation work already present on branch codex/ios-agent-chat-voice-integration, preserving both behavior contracts. Do not blindly overwrite conflicts or cherry-pick isolated launch files; inspect the source branch/commit history and integrate by behavior.

Verify the complete combined candidate yourself on the already booted/authenticated simulator “ALMA Launch V4 iPhone 17 Pro” (UDID 25DF9F01-DB5A-4E0F-8193-BE115D57D53F). Pin every xcodebuild/simctl install/launch command to that UDID. Do not install anything on an iPhone 17 Pro Max.

Run your own full verification suite plus every launch-specific gate and visual acceptance item in the handoff. Record a fresh authenticated production-data cold launch. The approved Preview v4 behavior, haptic timing, real dashboard reveal, merge into the canonical fixed Robot, final pop/settle/shake, badge preservation, and one-visible-Robot ownership must match 100%. Also verify your own feature work in the same installed candidate.

If any mismatch exists, fix it and repeat verification. When everything passes, report the exact integration branch, full commit SHA, changed scope, commands, test counts, screenshots/video, simulator observations, and hardware-only checks to me. Then ask for my explicit confirmation for that exact SHA and proposed build number. Do not bump, archive, upload, or start the final TestFlight build before I confirm. Do not upload the existing local build 1.0 (96); it is evidence only and does not include your final combined candidate.
```
