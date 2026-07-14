# iOS Build 72 — Handoff: WhatsApp-style VoIP/CallKit calling

**Branch:** `claude/ios-build-72` (off `main` @ 9dacf429)
**Purpose:** ship iOS build **72** = the office live-call now rings the callee's iPhone as a **native full-screen CallKit call even when the app is backgrounded or killed** (WhatsApp parity). The whole calling part is **already DONE and merged to `main`** — this branch exists so a follow-up agent can layer *its own* iOS work on top and ship one clean build 72 without conflicting with the calling code.

---

## STATUS: what is already done (do NOT rebuild it)

### iOS app code — on `main`, compiles green (sim BUILD SUCCEEDED)
| File | Change | Conflict note |
|---|---|---|
| `ios/App/App/CallKitVoIP.swift` | **NEW** — PushKit VoIP registry → CallKit provider. On a VoIP push reports a CallKit incoming call; answer joins the Agora channel (`AgoraIntercom.startCall`), end/decline tears down. Registers the device VoIP token to the server. Dedupes with the poll-based `FloatingChatHead` ring via `markCallHandled`. | Self-contained new file — nothing else defines this. |
| `ios/App/App/AgoraIntercom.swift` | **ADDITIVE** — `callKitManaged` flag (CallKit owns the AVAudioSession: skips `setActive` + sets `setAudioSessionOperationRestriction(.deactivateSession)`); `setMuted(_:)`, `audioSessionActivated()`; server-skew + 60s ring window in `pendingIncomingCall`. | If you touch this file, keep these members. |
| `ios/App/App/AppDelegate.swift` | `CallKitVoIP.shared.start()` in `didFinishLaunchingWithOptions` (iOS 17+ guard). | One added line inside the existing method. |
| `ios/App/App/Info.plist` | added `voip` to `UIBackgroundModes` (already had `audio`, `remote-notification`, `fetch`). | Keep `voip` in the array. |
| `ios/App/App.xcodeproj/project.pbxproj` | registered `CallKitVoIP.swift` in the App target (4 entries, IDs `CA11C177…`). | If you add files, don't drop these entries. |

### Server + config — LIVE on production (verified)
- APNs VoIP sender (`src/agent/lib/apns-voip.ts`), FCM sender, call-push token registry (`call-push.ts`), `POST /api/assistant/internal/call-push/register`, and the wake-push wiring in `office-intercom.ts` are **merged to `main` and deployed to production** (PRs #365–#368).
- Vercel env is set (Production + Preview): `APNS_AUTH_KEY`, `APNS_KEY_ID=LMJW5S2DGW`, `APNS_TEAM_ID=5D9FLR3MMA`, `APNS_PRODUCTION=true`.
- **Verified working on production:** `GET /api/assistant/internal/call-push/diag` (owner-only) returns `apnsProbe.reason = "BadDeviceToken"` + `parseOk: true` → the server authenticates to Apple's APNs successfully. (Apple only rejects the fake diagnostic token — the key/topic/auth are all valid.)
- APNs Auth Key is a **new** key created 2026-07-14 (`ALMA VoIP Push`, Key ID `LMJW5S2DGW`), stored at `~/.appstoreconnect/private_keys/AuthKey_LMJW5S2DGW.p8`. It is independent of the OneSignal push credential — OneSignal keeps working.

### Android — separate track (already shipped via OTA)
The Android full-screen incoming call is on branch `claude/android-ota-calling-v12` (built + OTA'd, versionCode 12). Not part of this iOS build.

---

## What the follow-up agent should do

1. Do your own iOS work on this branch (or `main`).
2. **Preserve the calling code above** — it's additive; the only shared files you might also touch are `AgoraIntercom.swift`, `AppDelegate.swift`, `Info.plist`, `project.pbxproj`. Merge, don't overwrite.
3. **Verify calling still builds** in the simulator:
   ```
   cd ios/App && pod install    # if a fresh worktree; Pods are gitignored
   # populate web assets: npx cap copy ios  (needs node_modules)
   xcodebuild -workspace App.xcworkspace -scheme App \
     -destination 'platform=iOS Simulator,name=iPhone 17 Pro Max' \
     -derivedDataPath /tmp/dd -configuration Debug CODE_SIGNING_ALLOWED=NO build
   ```
   Expect **BUILD SUCCEEDED**. (Full VoIP ring can't be exercised in the sim — a real VoIP push needs a device; the CallKit UI + registration path compile + run.)
4. **Ship build 72:**
   - `bash scripts/ios-build-preflight.sh` (hard-fails on dirty/unpushed/behind-main; stamps the commit SHA into Info.plist). Fix any git state it flags — never archive around it.
   - Bump `CURRENT_PROJECT_VERSION` from **71 → 72** in `ios/App/App.xcodeproj/project.pbxproj`, commit `chore(ios): bump build to 72`, push.
   - Archive + upload to App Store Connect (ASC API key `~/.appstoreconnect/private_keys/AuthKey_T875C2865Y.p8` — the DIFFERENT key, for uploads; see memory `project_apple_developer_enroll`).
5. **Owner device test (the real proof — hardware only):** staff iPhone closed/backgrounded → owner places a live call from the office (native roster or web) → the staff iPhone should ring a **native CallKit incoming call**, answer → two-way audio, and the app can be backgrounded mid-call.

## Known follow-ups / polish (optional)
- iOS CallKit ringtone is the system default (a bundled `.caf` could be added).
- APNs VoIP push currently sends on call-create; if a call is cancelled before answer, the callee's CallKit call is not remotely ended (it times out) — a `voip`-type "cancel" push could end it precisely.
- The owner-only diag endpoint (`/api/assistant/internal/call-push/diag`) can be removed once you're confident, or kept as an ops tool.
