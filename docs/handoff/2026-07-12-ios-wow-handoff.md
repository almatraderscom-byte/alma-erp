# Handoff — iOS work done in the cloud session (2026-07-12)

**For the next Claude session on the owner's Mac.** A cloud (Linux) session wrote
iOS/web/Android changes but could NOT compile Swift or run the simulator. Your job:
merge this branch cleanly with your own work, compile, self-test in the simulator
per CLAUDE.md, fix anything the compiler/simulator surfaces, and batch everything
into ONE TestFlight build.

## Branch

```
claude/native-office-calling-feature-0mw2ew   (pushed to origin)
```

Two commits on top of main:

1. `d4ce482` — fix(office-intercom): native 1:1 calling reliability + audio quality
2. `a66be49` — feat(ux): WOW pass — offline beacon, particle boot, ALMA Island

Start with: `git fetch origin && git checkout claude/native-office-calling-feature-0mw2ew && git pull`.
If you have your own branch, merge/rebase — conflict hot-spots are listed below.

## iOS files touched (the part you must compile + verify)

| File | Status | What changed |
|---|---|---|
| `ios/App/App/AgoraIntercom.swift` | modified | **Ring-fix:** `pendingIncomingCall()` now parses Prisma's fractional-seconds ISO dates via `parseISO` (bare `ISO8601DateFormatter` rejected every `createdAt`, so staff iPhones NEVER rang). Also skips calls with `mine.confirmedAt != nil` (answered/declined elsewhere). New `confirmCallReceipt(_:)` posts `action:"confirmed"` to `/api/assistant/office/intercom/receipt`. Removed dead `pendingCallChannel()`. `engineFor` now calls `setAudioProfile(.musicHighQuality)` (HD voice, matches web `high_quality`). |
| `ios/App/App/IntercomUI.swift` | modified | `IncomingCallView` answer + decline buttons call `ic.confirmCallReceipt(incoming.broadcastId)` so other devices stop ringing and the owner's chat log shows "ধরা হয়েছে". |
| `ios/App/App/ConnectivityBeacon.swift` | **new** | App-wide offline takeover: `NWPathMonitor` (1.5s debounce) → full-screen overlay window (material blur veil, terracotta lighthouse beacon with rotating sweep, pulse rings, orbiting comet, ৮s auto-retry countdown, manual retry probing `AlmaAPI.baseURL/api/health`) → on reconnect, dissolve + "সংযোগ ফিরে এসেছে" chip in a `PassthroughWindow`. |
| `ios/App/App/AlmaIslandBanner.swift` | **new** | `AlmaIslandWatch`: polls `/api/assistant/office/notifications` every 30s, seeds seen-ids on first poll, surfaces NEW unread `approved` / `redo` / `award` as a Dynamic-Island-style banner (`PassthroughWindow`, pill → spring open → Canvas confetti for good news → folds after ~5.5s). |
| `ios/App/App/AppDelegate.swift` | modified | After `FloatingChatHead.shared.install()`, installs `ConnectivityBeacon.shared.install()` + `AlmaIslandWatch.shared.install()` (iOS 17-gated, +0.8s defer). |
| `ios/App/App.xcodeproj/project.pbxproj` | modified | Added the two new files with IDs `F2AA7705000000000000A0FE/B0FE` (ConnectivityBeacon) and `F2AA7706000000000000A0FE/B0FE` (AlmaIslandBanner) in all 4 sections (PBXBuildFile, PBXFileReference, group children after `PortalStaffOfficeSwiftUI.swift`, Sources phase). |

Dependencies used: `Network` (NWPathMonitor), SwiftUI `TimelineView`/`Canvas`,
`PassthroughWindow` (already defined in `FloatingChatHead.swift`), `AlmaAPI.baseURL`
(already `static let`). No new pods/packages.

### Known compile-risk spots (written blind on Linux — check these first)

- `OfflineBeaconView` uses `Timer.publish(...).autoconnect()` with only `import SwiftUI` —
  if the compiler complains, add `import Combine`.
- Concatenated styled `Text + Text` in the countdown line.
- `ConfettiBurst` copies `GraphicsContext` (`var rect = ctx`) to apply per-particle transforms.
- `AlmaIslandView` has a stored `body_` property next to `var body: some View`.
- If merge breaks `project.pbxproj`, re-add the two file refs by hand (4 sections, pattern
  identical to the `AgoraIntercom.swift` / `IntercomUI.swift` entries).

## Non-iOS changes riding the same branch (context, already build-verified on Linux)

- `android/app/src/main/AndroidManifest.xml` — added `MODIFY_AUDIO_SETTINGS` (WebRTC echo
  cancellation/routing in the WebView). Needs a new APK eventually; not your job in this session.
- `mobile/www/index.html` — app-open bootstrap is now the particle "A" monogram + Bangla %
  counter (this ships inside the iOS app too via `npx cap sync ios`; **run `npm run mobile:sync:ios`
  or at least `npx cap sync ios` before building** so the new bootstrap lands in the shell).
- Web: `src/components/providers/ConnectionGuard.tsx` (+ mounted in `src/app/layout.tsx`),
  `AppBootSplash.css` rewrite, `ModulePageSkeleton.tsx` stagger,
  `src/app/portal/office/notif-bell.tsx` redesign + web ALMA Island,
  `src/agent/hooks/useAgoraCall.ts` (presence via user-joined/left — mute no longer hangs up;
  `setMuted`; `high_quality` mic), `useAgoraIntercom.ts` (explicit 3A),
  `src/app/portal/office/intercom.tsx` (ring timeout, server-clock skew via feed `serverNow`).
  `tsc`, `next lint`, `next build` all pass.

## Verify checklist (simulator, per CLAUDE.md — before ANY TestFlight build)

```
xcodebuild -workspace ios/App/App.xcworkspace -scheme App \
  -destination 'platform=iOS Simulator,name=iPhone 17 Pro Max' \
  -derivedDataPath /tmp/alma-sim-dd build
```

1. **Compile clean** — fix anything from the risk list above.
2. **Offline beacon:** boot app → Simulator: toggle network off (or set device to airplane via
   Settings) → within ~2s the beacon takeover appears; network back → takeover dissolves +
   green chip. Screenshot both.
3. **Boot splash:** cold-launch → particle "A" + % counter (from mobile/www — confirm cap sync ran).
4. **ALMA Island:** log in as a staff account, approve one of their tasks from the owner side
   (or insert an `approved` office notification) → island drops with confetti on whatever screen
   is open. Screenshot.
5. **Intercom call ring (the big fix):** owner (web/Chrome) rings the staff simulator — the
   incoming call screen must now actually appear (it never did before the date-parse fix).
   Answer on simulator → owner's chat log line should read "ধরা হয়েছে" (not "মিসড কল").
   Mute mid-call from either side → call must STAY connected.
6. Web-side spot check in Chrome `?native=1` (no build needed): offline via DevTools →
   beacon; office notifications panel new design; approve → web island + confetti.

Batch all fixes into ONE TestFlight build. Owner tests only after simulator proof.
