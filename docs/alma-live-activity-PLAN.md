# ALMA Live Activity — Dynamic Island Custom UI (A→Z Plan)

> Owner ask (2026-07-07): voice conversation চলাকালীন iPhone-এর Dynamic Island-এ
> ALMA-র নিজস্ব UI — waveform, "ALMA" wordmark, listening/thinking/speaking আলো।
> Foundation already shipped in build 55: `audio` background mode (voice app-এর
> বাইরে চলে, system mic pill দেখায়)। এই plan = তার ওপরের custom স্তর।

## 0. Scope এক নজরে
| Feature | Island state | কী দেখাবে |
|---|---|---|
| Voice session live | Compact | বাম: ALMA starburst (static asset) · ডান: mini waveform bars (সবুজ=শুনছে, বেগুনি=ভাবছে, কমলা=বলছে) |
| Long-press expand | Expanded | উপরে: ✳ ALMA + অবস্থা Bangla-তে ("শুনছি Boss…/ভাবছি…/বলছি…") · মাঝে: বড় animated waveform + live caption-এর শেষ লাইন · নিচে: End বাটন + elapsed timer |
| Minimal (অন্য activity-র সাথে) | Minimal | শুধু starburst dot, state-রঙে glow |
| Lock Screen | Banner | Expanded-এর সমান layout, aurora tint card |
| Agent turn (voice ছাড়াও, ঐচ্ছিক Phase-2) | Compact | লম্বা task (>10s) হলে "ALMA কাজ করছে · get_orders" progress |

## 1. Architecture
- **ActivityKit** (iOS 16.1+; owner device iOS 26 ✓)। Widget extension **AlmaWidgetExtension আছেই** — শুধু Live Activity widget যোগ হবে।
- নতুন shared file `AlmaVoiceActivityAttributes.swift` (app + extension দুই target-এ):
  ```swift
  struct AlmaVoiceActivityAttributes: ActivityAttributes {
      struct ContentState: Codable, Hashable {
          var phase: String        // listening | thinking | speaking | idle
          var captionTail: String  // শেষ ~60 চিহ্ন (head-truncated, emoji-free)
          var levels: [Double]     // 12-bar waveform snapshot (0…1)
          var startedAt: Date
      }
      var sessionTitle: String     // "ভয়েস কথোপকথন"
  }
  ```
- Extension-এ `AlmaVoiceLiveActivity: Widget` — `ActivityConfiguration(for:)` দিয়ে
  DynamicIsland { compact/expanded/minimal } + lock-screen view।
- **Waveform animation truth:** ActivityKit-এ per-frame update নেই — প্রতি ~0.5-1s-এ
  `Activity.update()` দিয়ে `levels` snapshot পাঠাব; extension-এ bar গুলো
  `.animation(.spring)` দিয়ে interpolate → জীবন্ত দেখাবে অথচ budget-safe
  (ActivityKit update throttle ~প্রতি সেকেন্ডে ১টা নিরাপদ)। বলার সময় TTS player-এর
  meteringEnabled → আসল audio level; শোনার সময় mic RMS (voice engine-এ already আছে)।
- **Starburst in island:** extension-এ Canvas animation চলে না — static 4-frame
  boil PNG set (asset catalog) + phase-রঙ tint; expanded-এ `TimelineView(.periodic)`
  দিয়ে ধীর frame-cycle (OS যতটা দেয়)।

## 2. Lifecycle wiring (app side, AssistantVoiceSwiftUI engine)
- `state` didSet (heartbeat hook-এর পাশে):
  - idle→listening: `Activity.request(...)` (একটাই — আগেরটা থাকলে reuse)
  - প্রতি phase বদল + caption delta: `activity.update(state)` (throttle 0.8s)
  - session শেষ / চ্যাটে ফিরুন / app kill: `activity.end(dismissalPolicy: .immediate)`
  - stale-guard: 30 min hard timeout → end (ভুলে চালু থেকে গেলে battery বাঁচবে)
- End বাটন (expanded) → `LiveActivityIntent` (AppIntent) → engine.stopSession()।

## 3. Project wiring (যেটা সাবধানের কাজ)
1. `Info.plist` (app): `NSSupportsLiveActivities = YES` (+ `NSSupportsLiveActivitiesFrequentUpdates` = YES)
2. pbxproj: shared attributes file দুই target-এ; extension-এ নতুন widget file
3. Extension deployment target iOS 16.1+ নিশ্চিত; OneSignal extension-এর সাথে conflict নেই (আলাদা appex)
4. Asset: starburst 4-frame PNG @2x/@3x (existing path থেকে render করে দেব)

## 4. Test plan (LOCKED workflow মেনে)
- Simulator: island compact/expanded preview (Xcode canvas + sim push), phase রঙ ৩টা, caption tail update, End intent
- Chrome `?native=1`-এ কিছু নেই (পুরো native) — sim-ই মূল প্রমাণ
- Device-only: real island glow feel, background 10-min soak, battery sanity
- Edge cases: দুই session পরপর (single activity reuse), app kill → activity auto-end,
  Focus mode-এ minimal view, timer drift

## 5. Phasing + estimate
- **P1 (core, ~আধা দিন):** attributes + island UI + lifecycle + End intent + sim proof
- **P2:** lock-screen polish + real audio-level waveform + Bangla status verbs rotate
- **P3 (ঐচ্ছিক):** non-voice agent long-task activity; push-updated activity (server → APNs token) যাতে app kill হলেও island-এ status আসে
- Risk: ActivityKit update throttle (waveform ঘন ঘন নয় — interpolation-ই সমাধান);
  pbxproj hand-wiring (backup + build-verify প্রতি ধাপে)

**Definition of Done:** voice চালু → island-এ ALMA compact UI; long-press-এ waveform+caption;
phase রঙ বদলায়; End কাজ করে; app background-এও সব চলে; sim screenshots প্রমাণসহ।
