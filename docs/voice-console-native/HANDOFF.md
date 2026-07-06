# Native Voice Console — HANDOFF (start here in a new session)

**Owner:** Maruf (non-engineer). **Reply in Bangla, concise.** **Branch: `native/voice-console`**
(off the native integration branch `claude/ios-s0-native-shell-spike`). Owner merges at integration.

> **Resume phrase the owner will paste:** *"native/voice-console branch e docs/voice-console-native/HANDOFF.md poড়e continue koro"*. This file must let a fresh session continue with zero re-discovery.

---

## 0. THE GOAL (owner-confirmed 2026-07-06)

Make the **native SwiftUI voice console** — `ios/App/App/AssistantVoiceSwiftUI.swift`
(`AlmaVoiceConsoleView` + `AlmaFluidOrbView`) — look and behave **100% like the confirmed
design**: `docs/voice-console-native/DESIGN-REFERENCE.html` (also published as artifact
`fc25c660-2f47-4210-881c-48f6bb5e3f28`). **Open that HTML first — it is the pixel target.**

This design used to be the owner's iPhone app (web voice console in the WKWebView). The native
migration replaced it with a light glass-sphere bundle and **lost the look**. The owner wants the
exact dark-aurora + WebGL-fluid-orb design back, natively.

The design is: **near-black `#04070D` canvas + state-hued aurora + dot grid**, a **state-hued
WebGL FLUID orb** (blue-teal planet-like, iridescent fbm fluid, fresnel rim, molten core,
breathing) with a **72-bar reactive waveform ring** around it (clear gap between orb and ring),
a glass **status badge** (glowing dot), a **top bar** (`ALMA. · এজেন্ট কনসোল · ঢাকা … · ● LIVE`),
glowing **spoken-subtitle** caption (`Sir` in gold `#E2B366`), **suggestion chips**, checkmark
**steps**, and a **live action-card feed** (SUI price w/ sparkline, expense ৳850, website-update
w/ approve button). Tokens: ink `#EAF2FB`, muted `#7C92A9`, faint `#55708C`, line
`rgba(160,200,240,.13)`, good `#3BE08F`; hues idle 168 / listening 145 / thinking·transcribing
265 / speaking 210 / error 8.

---

## 1. WHAT IS ALREADY DONE in `AssistantVoiceSwiftUI.swift` (functional parity — KEEP IT)

All committed on this branch (commits `51fa2dee`, `c5894da8`). All inside that ONE file (already
pbxproj-registered A022/B022 — no pbxproj edit needed to edit it). **swiftc -typecheck: 0 errors;
full app BUILD SUCCEEDED** (iPhone 17 Pro Max sim) — the code compiles into the whole app.

- **TRUE streaming STT** — `AlmaStreamingSTT`: AVAudioEngine mic PCM 24k → `URLSessionWebSocketTask`
  to OpenAI Realtime transcription (ephemeral token from `/api/assistant/stt-session`, live
  partials → transcript WHILE speaking, our adaptive VAD → commit). ANY pre-audio failure throws →
  falls back to the proven record→`/api/assistant/transcribe` path. Escape hatch: UserDefaults
  `alma-voice-streaming` (default true).
- **TTS Bangla normalizer** — inlined `almaNormalizeForTTS` (Swift port of
  `src/agent/lib/tts-normalize.ts`, 24/24 unit-tested): numbers→Bangla words, currency/%/phone/
  time, brand phonetics (SUI→সুই etc.). Applied to every `/api/assistant/tts` POST; subtitle keeps
  the original text.
- **model_switch_required** spoken + অনুমতি/থাক card → approve re-runs the SAME turn with
  `resume{approve}` (voice-local `VoiceChatBody`; the shared `ChatBody` is frozen and has no resume).
- **verification_retry** spoken once per turn.
- **ask card**: spoken question + option chips; answering continues the turn (`runTurn(option)`).
- **confirm/approval** in-console (POST `/api/assistant/actions/{id}/approve|reject`).
- Plus the pre-existing native parity: conversation mode (auto re-listen 450ms, কথোপকথন toggle),
  barge-in (0.08 RMS / 600ms), sentence-chunked TTS w/ prefetch, instant cached acks, greeting,
  calibrated/adaptive VAD (400ms noise-floor calibration, 250ms sustained arm, 1.4s/2.6s adaptive
  silence, 8s no-speech, 180s cap), 14s heartbeat, tool narration, mic chimes, last-exchange history.

**Do NOT rip these out. The remaining work is VISUAL.**

---

## 2. WHAT STILL DOES NOT MATCH — the visual (this is the job)

Commit `c5894da8` moved the native console to the dark-aurora tokens, but the **orb does not match**
the HTML yet. Concretely:

1. **Proportions bug (easy, do first).** In `AlmaFluidOrbView` the sphere is drawn at ~100% of the
   frame (`side`), while the waveform ring's base radius is `side*0.335*1.36 ≈ 0.456` — i.e. the ring
   sits INSIDE the orb (orb radius 0.5) and is hidden. In the web the orb is **62% of the wrapper**
   (radius ≈ 0.31) and the ring base ≈ 0.456 → a clear visible gap. **Fix: orb sphere ≈ 55–60% of the
   component frame; ring OUTSIDE with a clear gap** (like the HTML / the owner's image 2).
2. **The orb renders too bright / uniform GREEN.** The HTML orb is a blue-teal, planet-like
   **iridescent fbm fluid** (domain-warped noise, tri-hue mix, fresnel, molten core, halo). A plain
   SwiftUI radial+conic gradient can't reproduce it — it looks like a flat mint ball.
   **Recommended: port the exact WebGL fragment shader to Metal** and drive it with SwiftUI's iOS-17
   shader API (`View.layerEffect`/`colorEffect` + a `.metal` `ShaderLibrary`), uniforms `time`,
   `hue`, `amp`. The exact FRAG (hsl2rgb, hash/noise/fbm, domain warp, sphere shading, molten core,
   fresnel rim, glossy hotspot, breathing halo) is in `DESIGN-REFERENCE.html` — copy it 1:1. That
   gives a pixel-identical orb. (A `.metal` file is NEW → needs pbxproj registration: put it in
   `SHARED_CHANGES_REQUESTED.md`, owner adds the 4 entries. Alternatively keep it in-file if you can
   embed the shader source string and compile at runtime, avoiding pbxproj.)
   Fallback if Metal is too much: a much better multi-layer SwiftUI approximation — blue-biased,
   LESS saturated, darker; visible drifting iridescent fluid; strong top-left gloss; deep edge.
3. **Ring = clean dotted ring in idle.** At idle the 72 bars should read as evenly-spaced small
   dots (round-capped, subtle, white-ish blue) forming a clean ring; listening/speaking grows them
   into reactive bars. Make sure the ring is clearly OUTSIDE the orb (see #1).
4. **Scope question for the owner:** the HTML is the fuller "console" (orb + suggestion chips +
   checkmark steps + a scrolling **live action-card feed** + top LIVE bar). The native voice overlay
   currently shows orb + caption + cards-on-demand + dock. **Ask the owner** whether the native voice
   console should include the persistent action-feed / chips / top LIVE bar, or stay the minimal
   voice overlay (the feed already exists on the native Assistant CHAT screen). Match whatever he
   confirms against the HTML.

---

## 3. BUILD + VERIFY RECIPE (verified working this session)

Fresh worktree needs setup (none of it is cached in a new worktree):
```bash
git worktree add ../wt-native-voice native/voice-console   # or check it out
cd wt-native-voice
export LANG=en_US.UTF-8
npm ci --no-audit --no-fund            # ~9s if the npm cache is warm
npx cap copy ios                       # from the worktree ROOT (makes ios/App/App/{public,capacitor.config.json})
cd ios/App && pod install              # ~1 min
cd ../..
xcodebuild -workspace ios/App/App.xcworkspace -scheme App -configuration Debug \
  -destination 'platform=iOS Simulator,name=iPhone 17 Pro Max' \
  -derivedDataPath /tmp/voice-dd build > /tmp/b.log 2>&1
grep -E "BUILD SUCCEEDED|BUILD FAILED" /tmp/b.log   # (| tail masks the exit code — grep the log)
# install + jump straight to the voice console:
UDID=94E0186B-5CDA-4708-9368-53B4FF7274E7
xcrun simctl install "$UDID" /tmp/voice-dd/Build/Products/Debug-iphonesimulator/App.app
xcrun simctl launch --terminate-running-process "$UDID" com.almatraders.erp ALMA_ASSISTANT_VOICE=1
xcrun simctl io "$UDID" screenshot /tmp/x.png      # flake-proof capture
```
- Type-check without a build: `xcrun swiftc -typecheck -sdk $(xcrun --sdk iphonesimulator --show-sdk-path) -target arm64-apple-ios17.0-simulator ios/App/App/AssistantVoiceSwiftUI.swift ios/App/App/{AssistantSwiftUI,AlmaAPI,SwiftUIShell,ClaudeTopFade}.swift` — remaining `AlmaTabBarController`/`AlmaWebTabViewController`/`AlmaTheme` errors are the EXCLUDED Capacitor-shell symbols (fine; they resolve in the full build). Only `AssistantVoiceSwiftUI.swift` errors are yours.
- **The app has a native biometric lock** ("Enter iPhone Passcode for Alma ERP") gating the UI —
  the OWNER unlocks it (Face ID match / passcode). Do NOT type his passcode. Ask him to unlock the
  sim so you can screenshot, or let him verify on device.
- **This Mac mini has NO microphone** — the mic/streaming leg CANNOT be verified here; the owner
  device-tests it. Verify the VISUAL via the injected-turn hooks: `ALMA_ASSISTANT_VOICE=1` (open the
  console), `ALMA_VOICE_SAY="…"` (drive a full thinking→TTS→speaking turn, no mic needed).

---

## 4. RULES / SCOPE (parallel-session protocol — see `NATIVE_MIGRATION_HANDOFF.md`)

- **Writable: ONLY `ios/App/App/AssistantVoiceSwiftUI.swift`** (already registered — edit in place).
- **Frozen — read only:** `project.pbxproj`, `Info.plist`, `SpikeNativeShell.swift`,
  `SwiftUIShell.swift`, `AlmaAPI.swift`, `ClaudeTopFade.swift`, everything under `src/`, package
  files. Need a new `.metal` file registered, or a new Info.plist key? → append to
  `SHARED_CHANGES_REQUESTED.md` (append-only), owner applies it.
- Push `native/voice-console` only; the owner merges to the integration branch + sim-verifies +
  ships in a batched TestFlight build.

---

## 5. NEXT-LEVEL (owner may ask in the new session)

- **"ALMA" wake word on iOS** — already queued in `SHARED_CHANGES_REQUESTED.md`: needs
  `NSSpeechRecognitionUsageDescription` in Info.plist (frozen), then an `SFSpeechRecognizer`
  always-listening bridge calling `AlmaVoiceEngine.startListening()` on the hit (idle + open only).
  Without the plist key SFSpeechRecognizer crashes instantly — do NOT add it before the key.
- **Dynamic Island / Live Activity** for agent turn status (tool label + state), fed from the same
  SSE events the cards use.
- **Action Button / "Hey Siri"** → open the voice console via an App Intent / universal link.
- **ElevenLabs voice** — the owner keeps it OFF for cost (opt-in only); do not enable without asking.

---

## 6. KEY FILES
- Confirmed design: `docs/voice-console-native/DESIGN-REFERENCE.html` (this folder).
- Native code: `ios/App/App/AssistantVoiceSwiftUI.swift`.
- Web source of truth for behavior/APIs (read-only reference): `src/agent/components/voice/`
  (`VoiceConsole.tsx`, `FluidOrb.tsx` — the FRAG shader lives here too), `src/agent/lib/`
  (`tts-normalize.ts`, `tts-chunk-player.ts`, `voice-bangla.ts`), `/api/assistant/{chat,tts,
  transcribe,stt-session,actions,ask-cards}`.
- Program docs: `docs/ios-native-frame-handoff.md`, `NATIVE_MIGRATION_HANDOFF.md`,
  `SHARED_CHANGES_REQUESTED.md`. Memory: `project_voice_console.md`, `reference_ios_sim_access`.
