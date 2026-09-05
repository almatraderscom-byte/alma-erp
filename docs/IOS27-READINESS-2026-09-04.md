# iOS 27 readiness — status and polish batch (2026-09-04)

Branch `claude/ios-27-app-kit-polish-c748be`. Toolchain used: Xcode 26.6 / iOS 26.5 SDK (Xcode 27 not installed).

## What the "iOS 27 kit" prep already is (on main)

- Apple iOS/iPadOS 27 Figma-kit tokens extracted 2026-07-08 live in `ios/App/App/SwiftUIShell.swift`
  (`AlmaSwiftTheme`): concentric radii card 26 / control 14 / sheet 34, iOS 27 semantic
  green/red/blue/orange light+dark pairs, hairline separator + fill tokens, `lgCard`, capsule button style.
- Coverage on main today: `rCard` in 66 files (686 sites), `rControl` in 67 files (620 sites).
  The `native/ios27-design` branch (build 60) is NOT merged as a branch, but its token system was carried
  onto main through later work — nothing left to salvage from it.
- IOSP-0..9 (docs/IOSP-*) completed the Xcode-26.6 half of the program. The Xcode-27 half was
  owner-blocked (toolchain absent) and still is.

## Toolchain facts (checked 2026-09-04)

| Item | State |
|---|---|
| Xcode on this Mac | 26.6 (17F113), iOS 26.5 runtime only |
| Xcode on the TestFlight CI runner (`macos-latest` = macOS 26 image) | 26.6 default; Xcode 27 not present |
| Xcode 27 | beta 6 (2026-08-24); no Release Candidate yet — expected with the September iPhone event |
| iOS 27 | beta 8 (2026-08-31) |
| TestFlight | App Store Connect accepts builds from Xcode 27 beta 6 for internal + external testing (2026-08-25) |
| App Store minimum SDK | iOS 26 SDK (since 2026-04-28). No iOS 27 SDK deadline announced |
| iOS 27 + Liquid Glass | Apps recompiled with Xcode 27 adopt the revised (less transparent) glass; the iOS 26 opt-out is gone. Apps built with the iOS 26 SDK keep running on iOS 27 with iOS 26 behaviour |

The CI workflow selects the newest `/Applications/Xcode*.app` by `sort -V`, so it will move to Xcode 27
automatically the day GitHub adds it to the macOS 26 image (`Xcode_27.0...` sorts above `Xcode_26.6`).

## Polish batch shipped in this branch (Xcode-26.6-verifiable)

Clean build warning inventory for the App target: **96 → 0** (`docs/proofs/ios27-readiness/warnings-before-96.txt`).

- 8 view-models re-isolated to `@MainActor` (same root-cause fix as IOSP-8): AgentGrowthVM, BusinessArchiveVM,
  PaymentAccountsVM, SettingsBrandingVM, SettingsTelegramVM, SettingsUsersVM, SystemDiagnosticsVM,
  TradingTelegramVM — 29 "async but not awaited" Swift-6 errors-to-be.
- Voice engine locks: 14 `NSLock`/`NSCondition` lock/unlock sites inside async functions (Swift 6 error) moved
  into synchronous critical-section helpers — `reserveStartAndStartMic`, `publishConnectTask`, `publishSocket`,
  `withStartAttemptLock`, `storePrewarmed`. Same lock, same ordering, same guards; no behaviour change.
  (Voice audio tuning untouched — this is the client STT/live-session lifecycle, not the SIP playout.)
- 11 non-Sendable `self` captures in Timer / continuation closures: classes declared `@unchecked Sendable`
  with the concrete discipline documented inline (CallKitVoIP lock gate, OfficeCallCoordinator / ConnectivityBeacon
  main-actor hops, PortalGpsOnce single-shot continuation).
- 25 dead `?? []` / `?? [:]` fallbacks removed (Analytics, Trading Analytics, bridges, Portal Office, Trading Staff).
- 11 redundant `#available(iOS 17)` checks inside already-17+ scopes removed.
- Deprecated `contentEdgeInsets` → `UIButton.Configuration` (companion STOP button); `MainActor.assumeIsolated`
  for the two main-queue notification observers in PhoneEngine; `@retroactive Identifiable` on `URL`;
  unused-result / never-mutated cleanups.
- New `ios/App/App/PrivacyInfo.xcprivacy` (UserDefaults CA92.1, no tracking) registered in the app target —
  the app itself had no privacy manifest; only the OneSignal pods did.

Sim-verified (iPhone 17 Pro Max, iOS 26.5, live data): Dashboard, Analytics, Trading Analytics, Users,
Payment accounts — `docs/proofs/ios27-readiness/*.jpg`.

## What still needs Xcode 27 (owner-gated, unchanged from IOSP-8)

1. Install Xcode 27 (RC when it lands; beta 6 works for TestFlight today) + iOS 27 simulator runtime.
2. Rebuild, inventory new warnings, run the iOS-27-sim regression on the locked chrome
   (transparent nav/tab appearance + `AlmaGlassHeaderView` strip under the revised glass).
3. Adopt the iOS 27 SwiftUI additions that earn their place (toolbar visibility priority, prominent tab role,
   reorderable containers, `@State` macro) behind `#available(iOS 27, *)`.
4. ONE TestFlight build after the sim checklist + owner sim pass.
