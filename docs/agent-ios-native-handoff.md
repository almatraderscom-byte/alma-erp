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
| 1–2 Liquid Glass / layered UI | Partial | **Phase N5** | Applies only to native surfaces (widget, Live Activity, future lock screens). Adopt glass materials behind `#available`. Web UI unaffected. |
| 3 App Intents (basic) | ✅ Done | 3 open-intents shipped (build 7) | |
| 3+11 App Intents **entities** + Spotlight semantic index | ❌ Missing | **Phase N3** | Orders/products as `AppEntity`, parameterized intents, iOS 27 entity schemas behind `#available`. |
| 4 Foundation Models (on-device LLM) | 🚧 Code done (build 9) | **Phase N1** | Bridge plugin → web falls back to server LLM when unavailable. Zero-cost offline summarize/classify. **Awaiting device verification.** |
| 5 SpeechAnalyzer (on-device STT) | ❌ Missing | **Phase N2** | Today voice uses Whisper API (server, costs money). On-device STT bridge = cost cut + offline. |
| 6 Writing Tools | ✅ Mostly free | WKWebView text fields inherit system Writing Tools on supported iOS — verify, don't build. |
| 7 StoreKit / subscriptions | — | **N/A** | Internal business app; no monetization. Skip. |
| 8 Background Tasks API | ❌ Missing | **Phase N4** | Background refresh of local reminders + Business Pulse. |
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
- New local plugin `NativeSpeechBridgePlugin`: `transcribe({audioBase64 | start/stop streaming}, locale)` — iOS 26+ `SpeechAnalyzer`; fallback `SFSpeechRecognizer` (iOS 16+, needs `NSSpeechRecognitionUsageDescription` — **add the plist key in the same PR**, remember the Face ID incident).
- Web: wire into `src/agent/hooks/useVoiceRecorder.ts` behind a KV/localStorage flag `alma_native_stt` (default OFF until owner A/B-tests vs Whisper for Bangla accuracy). Build gate ≥ 10.
- Success metric: Whisper API spend drops; Bangla accuracy owner-verified.

### Phase N3 — App Intents entities + Spotlight
- `OrderEntity` (id, title, status) + `ProductEntity` as `AppEntity` with `EntityQuery`. Data source: native cannot read the web session — add a tiny App Group cache: the web app POSTs recent entities to the bridge (`EntityCacheBridgePlugin.setEntities`), plugin persists to App Group `group.com.almatraders.erp` (add the entitlement to BOTH targets), queries read the cache.
- Parameterized intent `OpenOrderIntent(order: OrderEntity)` → `almaerp://orders/<id>`.
- iOS 27 stretch: entity/intent schemas for the Spotlight semantic index; View Annotations.
- This phase also unlocks wishlist #9 (system-suggested contextual actions).

### Phase N4 — Background refresh
- `BGAppRefreshTask` (id `com.almatraders.erp.refresh`, `UIBackgroundModes: fetch` + `BGTaskSchedulerPermittedIdentifiers` in Info.plist) scheduled from AppDelegate.
- Research step first: reuse the WKWebView session cookie from `HTTPCookieStorage`/`WKWebsiteDataStore` for a native `URLSession` call to `/api/assistant/device-reminders` + `/live-pulse`; if cookies aren't reachable, mint a device token instead (new column on PushSubscription, issued at registration) — decide in-session, document the choice here.
- Effect: reminders + pulse stay fresh even if the app isn't opened for days.

### Phase N5 — Liquid Glass + iOS 27 polish
- Widget + Live Activity: adopt glass materials/`glassEffect` behind `#available(iOS 26,*)`/27 checks with current flat-dark fallback; scroll-minimized accessory styles where applicable.
- Add `FEATURES.md` (repo root of `ios/App/`) tracking baseline-vs-enhanced per the owner's rules; keep availability checks at module level (the codebase already follows this — keep it).

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
