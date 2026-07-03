# Alma ERP iOS — Native feature capability matrix (baseline vs enhanced)

Every native-surface feature ships a **baseline** that works on the app's minimum
OS (iOS 16.0) and, where the hardware/OS allows, an **enhanced** path gated behind
`#available` / `#if canImport`. This file tracks that split so we never assume an
enhanced capability is present — the baseline must always stand alone.

Rule of thumb (project convention): **availability checks at module level**, never
mid-view; every enhanced path has a working baseline fallback; nothing an old OS
lacks may ever crash or block.

| Feature | Baseline (always) | Enhanced (gated) | Gate |
|---|---|---|---|
| Live Activity / Dynamic Island | — (absent < 16.1) | Business Pulse | `#if canImport(ActivityKit)` + `@available(iOS 16.1)` |
| Widget container background | padded flat fill | `containerBackground(for:.widget)` | `#available(iOS 17.0)` |
| On-device intelligence (N1) | server LLM (Gemini) | Foundation Models summarize/classify | `#if canImport(FoundationModels)` + `@available(iOS 26)` |
| On-device STT (N2) | Whisper API | `SFSpeechRecognizer` on-device; iOS 26 `SpeechAnalyzer` = future | `#if canImport(Speech)` + `@available(iOS 16)`; opt-in flag |
| App Intents entities (N3) | 3 static open-intents | `OrderEntity`/`ProductEntity` + `OpenOrderIntent(order:)` | `@available(iOS 16.0)` + App Group provisioned |
| Background refresh (N4) | foreground sync on open/resume | `BGAppRefreshTask` reminder refresh | Info.plist `BGTaskSchedulerPermittedIdentifiers` |
| **Liquid Glass surfaces (N5)** | **flat dark tint (#0c0b12 / tile)** | **translucent `.ultraThinMaterial` sheen** | `@available(iOS 16.0 / 16.1)` |

## N5 — Liquid Glass adoption status & upgrade path

**Shipped now (build 13):** widget destination tiles (`AlmaGlassSurface`) and the
Live Activity lock-screen backdrop (`PulseGlassBackground`) layer a faint
`.ultraThinMaterial` over the brand tint for depth. Baseline flat-dark fill remains
underneath, so nothing regresses on older OS or if materials render opaque.

**True Liquid Glass (`glassEffect`) — deferred, one-line swap:** Apple's
`glassEffect(_:in:)` (WWDC25) is the real Liquid Glass primitive, but it only exists
in the **iOS 26 SDK**, and — unlike our `FoundationModels`/`Speech` code, which is
`#if canImport`-guarded — a bare SwiftUI method call can't be excluded per-SDK, so
writing it blind risks breaking the device build on an older Xcode. When the build
Mac is confirmed on the iOS 26 SDK, adopt it by editing the two helpers:

```swift
// AlmaGlassSurface / PulseGlassBackground — replace the material Rectangle with:
if #available(iOS 26.0, *) {
    Color.clear.glassEffect(.regular, in: .rect(cornerRadius: 12))
} else {
    Rectangle().fill(.ultraThinMaterial).opacity(0.3)   // current baseline+
}
```

Keep the availability check at module level and the material as the pre-26 fallback.

**iOS 27 stretch (not started):** scroll-minimized accessory styles for the Live
Activity, `glassEffect` tint variants keyed to order status, and View Annotations
(rides on the N3 entities).
