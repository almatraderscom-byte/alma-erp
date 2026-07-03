# iOS Native — Next Features Handoff (start here)

**Date:** 2026-07-03 · **App:** Alma ERP iOS (Capacitor shell, bundle `com.almatraders.erp`, team `5D9FLR3MMA`)
**Purpose:** the owner supplied a wishlist (iOS 26/27-era capabilities). This file maps it against what already shipped, and gives the exact plan + conventions so a fresh session can start implementing immediately — no re-discovery needed.

> **এই ফাইলটা কীভাবে ব্যবহার করবেন (owner):** নতুন session খুলে শুধু বলুন
> "docs/agent-ios-native-handoff.md পড়ে Phase N1 শুরু করো"। বাকিটা agent জানে।

---

## 1. Where we are (as of build 8, all merged to main)

Everything below is LIVE on TestFlight build 8 and verified in code (CI + device builds green):

- **Push:** APNs key `54SRUT66SS` → OneSignal (`db2c4411-612e-4705-beb3-dfe71a3fd5d8`), iOS platform Active, `platform: 'ios-native'` subscriptions. Verified end-to-end on the owner's iPhone.
- **TestFlight CLI pipeline:** cloud signing + upload via ASC API key `T875C2865Y` (Issuer `4ea79058-88d0-4dbc-9010-78cf543b1790`, keys in `~/Documents/ALMA-secrets/` + `~/.appstoreconnect/private_keys/`). Exact commands in §5.
- **Face ID app lock** (`src/lib/biometric-lock.ts`, gate ≥ build 4), **home-screen quick actions** (AppDelegate forwarding + `src/lib/app-shortcuts.ts`), **offline reminders** (`@capacitor/local-notifications`, `/api/assistant/device-reminders`, gate ≥ 5), **Siri App Intents** (`ios/App/App/AlmaAppIntents.swift`, 3 open-intents), **`almaerp://` deep links** (`DeepLinkManager.tsx`), **WidgetKit widget** (`ios/App/AlmaWidget/`, small+medium, static), **Live Activities / Dynamic Island** "Business Pulse" (`PulseLiveActivity.swift`, `LiveActivityBridgePlugin` local plugin via `AlmaBridgeViewController`, `/api/assistant/live-pulse`, gate ≥ 8).
- **Deployment target iOS 16.0**, Swift 5, Capacitor 7, storyboard-hosted `AlmaBridgeViewController`. 10 plugin pods.
- pbxproj is hand-maintained; every past surgery is documented in `ios/App/AlmaWidget/INTEGRATION.md` (reserved ID prefixes used: `A1AA11`, `B1AA22`, `C1AA33`, `D1AA44` — pick a fresh prefix per phase).

## 2. Wishlist → gap map

| # | Wishlist item | Status | Note |
|---|---|---|---|
| Xcode/Swift6/SwiftUI/MVVM scaffold | — | **N/A** | App is a Capacitor WebView shell by design (UI = live Next.js site). Native SwiftUI exists only in widget/Live Activity — keep it that way. |
| 1–2 Liquid Glass / layered UI | 🚧 Code done (build 13) | **Phase N5** | Translucent material surfaces on widget + Live Activity behind `#available`; true `glassEffect` is a documented one-line swap on the iOS 26 SDK (FEATURES.md). |
| 3 App Intents (basic) | ✅ Done | 3 open-intents shipped (build 7) | |
| 3+11 App Intents **entities** + Spotlight semantic index | 🚧 Code done (build 11) | **Phase N3** | `OrderEntity`/`ProductEntity` + `OpenOrderIntent(order:)` via App Group cache. **Needs App Group provisioned; awaiting device verification.** |
| 4 Foundation Models (on-device LLM) | 🚧 Code done (build 9) | **Phase N1** | Bridge plugin → web falls back to server LLM when unavailable. Zero-cost offline summarize/classify. **Awaiting device verification.** |
| 5 SpeechAnalyzer (on-device STT) | 🚧 Code done (build 10) | **Phase N2** | On-device `SFSpeechRecognizer` engine shipped (free + offline); iOS 26 `SpeechAnalyzer` is a documented upgrade. Owner-opt-in flag, **awaiting device verification.** |
| 6 Writing Tools | ✅ Mostly free | WKWebView text fields inherit system Writing Tools on supported iOS — verify, don't build. |
| 7 StoreKit / subscriptions | — | **N/A** | Internal business app; no monetization. Skip. |
| 8 Background Tasks API | 🚧 Code done (build 12) | **Phase N4** | `BGAppRefreshTask` refreshes reminders via WKWebView session cookie → native local notifications. **Awaiting device verification.** |
| 9 Visual Intelligence / semantic deep links | ❌ Missing | Rides on Phase N3 entities. |
| 10 FM upgrades (multimodal, cloud-backed LanguageModel) | ❌ Missing | Phase N1 stretch, `#available(iOS 27, *)`. |
| 12 App Intents Testing/Evaluations | ❌ Missing | Phase N3 stretch. |
| 13 NowPlaying / Music Understanding | — | **N/A** | No media playback in this app. |

## 3. New phases (one session each, in this order)

### Phase N1 — On-device intelligence bridge (Foundation Models)

**Status (build 9): code complete, pending device verification.** Shipped in this phase:
- `ios/App/App/NativeIntelligenceBridge.swift` — local `NativeIntelligenceBridgePlugin` (mirrors `LiveActivityBridge.swift`): `summarize({text, maxWords})`, `classify({text, labels})`, `availability()`. `#if canImport(FoundationModels)` + `#available(iOS 26, *)`, `LanguageModelSession`, `@Generable Classification` for guided classify, fail-open everywhere (resolves falsy below iOS 26 / unsupported / model-not-ready — never traps).
- Registered in `AlmaBridgeViewController.capacitorDidLoad()` (2nd `registerPluginInstance`).
- pbxproj surgery, prefix `D1AA44` (documented in `INTEGRATION.md` → "Phase N1 additions"); `CURRENT_PROJECT_VERSION` 8 → 9 in all 4 App/project places.
- `src/lib/native-intelligence.ts` — feature-detect + **build gate `MIN_NATIVE_BUILD = 9`** + `availability()` probe; `summarizeText` / `classifyText` take a `serverFallback` and short-circuit to on-device only when confident (fallback-first, fully fail-open). `nativeIntelligenceAvailable()` for UI.
- Vitest: `src/lib/__tests__/native-intelligence.test.ts` (gate / plugin-absent / unavailable / off-list / reject → all fall back).
- **Not yet wired to a live call site** — the helper is ready, but per the ⚠️ below the first integration is deferred until on-device Bangla quality is owner-verified. First integration target: owner-facing English summaries + order-note classification (keep additive).
- ⚠️ Test Bangla output quality on-device before wiring anything customer-facing; if Bangla is weak, keep on-device for English/classification only.
- iOS 27 stretch (`#available(iOS 27, *)`): token-count API + `PrivateCloudComputeLanguageModel` for 32K context. (Not done — future.)

### Phase N2 — On-device speech (SpeechAnalyzer)

**Status (build 10): code complete, pending device verification.** Shipped in this phase:
- `ios/App/App/NativeSpeechBridge.swift` — local `NativeSpeechBridgePlugin`: `availability({locale})`, `transcribe({audioBase64, locale})`. Engine is `SFSpeechRecognizer` with `requiresOnDeviceRecognition = true` (iOS 16+, free/offline) via `SFSpeechURLRecognitionRequest` on the recorded clip — the exact drop-in for the record-then-transcribe flow. Fail-open (resolves `{text:"",onDevice:false}` below iOS 16 / unauthorized / any error — never traps).
- Registered in `AlmaBridgeViewController.capacitorDidLoad()` (3rd `registerPluginInstance`).
- **`NSSpeechRecognitionUsageDescription` added to `App/Info.plist`** in this same phase (the authorization prompt would otherwise crash — Face ID lesson). Mic key already present.
- pbxproj surgery, prefix `E1AA55` (documented in `INTEGRATION.md` → "Phase N2 additions"); `CURRENT_PROJECT_VERSION` 9 → 10 in all 4 places.
- `src/lib/native-speech.ts` — feature-detect + **build gate `MIN_NATIVE_BUILD = 10`** + **owner-opt-in flag `alma_native_stt` (localStorage, default OFF)** + `availability()` probe. `maybeTranscribeOnDevice(blob, locale)` returns the transcript or `null` (→ caller uses Whisper). `isNativeSttEnabled` / `setNativeSttEnabled` for a settings toggle.
- Wired into `src/agent/hooks/useVoiceRecorder.ts` (`mr.onstop`): tries on-device first, falls through to the existing `/api/assistant/transcribe` (Whisper) POST unchanged. Additive — the Whisper path is untouched when on-device returns null.
- Vitest: `src/lib/__tests__/native-speech.test.ts` (flag-off / off-native / old-build / plugin-absent / unavailable / empty / reject → all fall back; flag round-trip).
- ⚠️ **iOS 26 `SpeechAnalyzer`/`SpeechTranscriber` deliberately NOT written blind** — its async asset-installation API is easy to mis-code and would break the device build. Business goal (free offline Bangla STT) is met by the on-device recognizer now; SpeechAnalyzer is the next-session upgrade once accuracy is device-verified.
- Success metric: Whisper API spend drops; Bangla accuracy owner-verified (flip `alma_native_stt` ON and A/B-test on device).

### Phase N3 — App Intents entities + Spotlight

**Status (build 11): code complete, pending App Group provisioning + device verification.** Shipped:
- `ios/App/App/AlmaEntities.swift` — `OrderEntity` (id, title, status) + `ProductEntity` as `AppEntity` with `EntityQuery` reading the App Group cache; parameterized `OpenOrderIntent(order:)` → `almaerp://orders/<id>` (DeepLinkManager already routes `/orders/<id>` — no web routing change). Unlocks wishlist #9 (system-suggested contextual actions via `suggestedEntities`).
- `ios/App/App/EntityCacheBridge.swift` — `EntityCacheBridgePlugin.setEntities({orders,products})` persists JSON to App Group `group.com.almatraders.erp` and refreshes `AlmaShortcuts.updateAppShortcutParameters()`. Registered in `AlmaBridgeViewController` (4th plugin). Fail-open (`{saved:false}` if the group isn't provisioned).
- **App Group entitlement on BOTH targets:** `App/App.entitlements` + new `AlmaWidget/AlmaWidget.entitlements`; `CODE_SIGN_ENTITLEMENTS` wired for the widget's Debug/Release configs. ⚠️ Automatic signing must provision the group for both app IDs — if it doesn't, enable **App Groups → `group.com.almatraders.erp`** for `com.almatraders.erp` and `com.almatraders.erp.widget` in the Apple Developer portal, then rebuild (see INTEGRATION.md §C).
- pbxproj surgery, prefix `F1AA66`; `CURRENT_PROJECT_VERSION` 10 → 11 (all 4 lockstep places — app + widget move together, required by App Store Connect).
- `/api/assistant/native-entities` — owner-only feed of recent orders (id, customer+product title, status; **no money**), `products: []` for now.
- `src/lib/native-entities.ts` — feature-detect + **build gate 11** + `syncNativeEntities()`; wired into `LivePulseManager` on the same native-only throttled open/resume tick. Fail-open.
- Vitest: `src/lib/__tests__/native-entities.test.ts` (gate / plugin-absent / non-OK / reject → all no-op; happy path pushes to bridge).
- iOS 27 Spotlight semantic-index schemas + View Annotations: documented future stretch, not built.

### Phase N4 — Background refresh

**Status (build 12): code complete, pending device verification.** Shipped:
- `ios/App/App/BackgroundRefresh.swift` — `BGAppRefreshTask` (id `com.almatraders.erp.refresh`). `register()` from `AppDelegate.didFinishLaunching`, `schedule()` from `applicationDidEnterBackground` (earliest +1h; iOS decides real cadence). On wake it reuses the WKWebView session cookie, calls `/api/assistant/device-reminders`, and re-schedules local notifications natively via `UNUserNotificationCenter`. Fail-open (no cookie / 401 / offline → clean no-op).
- **AUTH DECISION (resolved in-session):** reuse the existing NextAuth session cookie from `WKWebsiteDataStore.default().httpCookieStore` — **NOT** a minted device token. Rationale: no DB change (stays additive per project rules), nothing new to revoke, and the cookie is already valid for the owner-only endpoints. If it expires, the task 401s and no-ops until the owner next opens the app (which re-syncs via the web local-reminders path).
- **Notification-id dedupe:** `BackgroundRefresh.reminderNotificationId` is a 31-hash matching `src/lib/local-reminders.ts` EXACTLY, and the `@capacitor/local-notifications` plugin schedules under `String(id)` — so a reminder scheduled by the web path and the background path lands under the SAME `UNNotificationRequest` identifier and dedupes instead of double-firing. (Confirm on device.)
- Info.plist: `UIBackgroundModes` gains `fetch`; `BGTaskSchedulerPermittedIdentifiers` = `com.almatraders.erp.refresh`.
- pbxproj surgery, prefix `A2BB77` (hex-safe; `G1AA77` would be invalid); `CURRENT_PROJECT_VERSION` 11 → 12 (all 4 lockstep places).
- No web code changes (uses existing endpoints) → no new web gate / vitest for this phase.
- Effect: reminders stay fresh even if the app isn't opened for days. (Live Pulse refresh needs ActivityKit from the app process; kept to the foreground `LivePulseManager` tick for now — a background pulse push is a future add via APNs-driven Live Activity.)

### Phase N5 — Liquid Glass + iOS 27 polish

**Status (build 13): code complete, pending device verification.** Shipped:
- `ios/App/AlmaWidget/AlmaWidget.swift` — `AlmaGlassSurface` layers `.ultraThinMaterial` over the tile tint (iOS 16+) for the medium-widget destination tiles, flat-dark fallback underneath.
- `ios/App/AlmaWidget/PulseLiveActivity.swift` — `PulseGlassBackground` layers material over the lock-screen banner backdrop (iOS 16.1+), flat fill base.
- `ios/App/FEATURES.md` — baseline-vs-enhanced capability matrix per the owner's rule, with the exact `glassEffect` upgrade snippet.
- `CURRENT_PROJECT_VERSION` 12 → 13 (all 4 lockstep). No new source files → no pbxproj file additions; no web change → no gate/vitest.
- ⚠️ **True Liquid Glass (`glassEffect`) intentionally deferred** — it only compiles against the iOS 26 SDK and, unlike the `#if canImport`-guarded FoundationModels/Speech code, a bare SwiftUI call can't be per-SDK excluded, so writing it blind risks breaking the device build on an older Xcode. Shipped material now; FEATURES.md has the one-line swap to adopt `glassEffect` once the build Mac is confirmed on the iOS 26 SDK.
- iOS 27 stretch (scroll-minimized accessory styles, status-tinted glass, View Annotations): documented in FEATURES.md, not built.

## 4. Non-negotiable conventions (learned the hard way today)

1. **Read the plugin/framework README install section FULLY before shipping** — missing `NSFaceIDUsageDescription` crash-looped build 2; missing AppDelegate forwarding silently broke shortcuts. Every privacy API needs its `NS*UsageDescription` in the SAME PR. (Foundation Models needs none.)
2. **Every native-dependent web feature gets a `MIN_NATIVE_BUILD` gate** (pattern in `biometric-lock`/`local-reminders`/`live-pulse`/`native-intelligence`): web deploys reach ALL installed binaries instantly — old binaries must stay inert. Next gate: ≥ 10.
3. **Fail-open everywhere**: no native failure may ever block the app.
4. One feature-set per native build; bump `CURRENT_PROJECT_VERSION` in **all 4 places** in pbxproj; verify `plutil -lint` + device `xcodebuild build` BEFORE archiving.
5. pbxproj edits: python/string-surgery with unique 24-hex ID prefix per phase; document in `INTEGRATION.md`. (Used so far: `A1AA11`, `B1AA22`, `C1AA33`, `D1AA44`.)
6. PR per feature → Vercel green → merge → archive+upload (§5). Never leave web code merged that requires an unshipped binary without its gate.

## 5. Build & ship recipe (exact)

```bash
export LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8   # CocoaPods ruby fix — always
npm install && npx cap sync ios               # worktrees have their own node_modules!
cd ios/App
# verify:
xcodebuild -workspace App.xcworkspace -scheme App -configuration Release \
  -destination 'generic/platform=iOS' build -allowProvisioningUpdates \
  -authenticationKeyPath ~/.appstoreconnect/private_keys/AuthKey_T875C2865Y.p8 \
  -authenticationKeyID T875C2865Y -authenticationKeyIssuerID 4ea79058-88d0-4dbc-9010-78cf543b1790
# ship: same flags with `archive -archivePath <path>.xcarchive`, then:
xcodebuild -exportArchive -archivePath <path>.xcarchive \
  -exportOptionsPlist exportOptions_nomanage.plist -exportPath <out> [same auth flags]
# exportOptions: method app-store-connect, destination upload, teamID 5D9FLR3MMA,
# signingStyle automatic, manageAppVersionAndBuildNumber FALSE (manage build no. in pbxproj)
```

- Processing status via ASC REST (jose JWT script pattern — see memory / rebuild `asc.mjs` in a scratchpad).
- Local dev cert for the Apple ID is REVOKED — cloud signing via the ASC key is the only path; don't chase certificates.
- This Mac's CoreSimulator is outdated (simulator warnings are benign; device builds are the real check). TestFlight internal group "ALMA Internal" auto-distributes; testers: owner + almatraders.com@gmail.com (team user, Customer Support role).

## 6. Definition of done (per phase)

tsc clean · relevant vitest suites green · device Release build SUCCEEDED · TestFlight build VALID · **owner verifies on his iPhone 17 Pro Max** (the only real device loop) · IOS_SETUP.md + this file updated · memory updated (`project_apple_developer_enroll` entry).
