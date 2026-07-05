# Native Metal Voice Orb — photoreal refraction

Real-time 3D glass orb (fbm fluid + chromatic refraction + iridescence +
volumetric shading), matched to this session's premium glass look. The
fragment shader is a 1:1 port of the verified WebGL/GLSL reference
(`../after-webgl.html`), rendered here headlessly for the before/after proof.

## Files
- `AlmaOrbMetal.metal`     — vertex (fbm displacement) + fragment (glass) shaders
- `AlmaMetalOrbView.swift` — `MTKView` renderer + `AlmaMetalOrb` SwiftUI wrapper

## Integrate (in `ios/App/App/`, branch `claude/ios-s0-native-shell-spike`)
1. Add both files to the app target (pbxproj: register like A022/B022).
2. In `AssistantVoiceSwiftUI.swift`, keep the halo + contact-shadow layers of
   `AlmaGlassOrbView`, and swap the circle-clipped glass stack for:
   ```swift
   AlmaMetalOrb(state: engine.state.rawKey, micLevel: micLevel, ttsLevel: ttsLevel)
       .frame(width: side, height: side)
       .clipShape(Circle())
   ```
   (map `AlmaVoiceState` → the string keys the renderer expects, or change
   `OrbRenderer.state` to your enum — trivial.)
3. Gate behind a flag (e.g. `alma-metal-orb`) so you can A/B vs the CSS glass.

## State mapping (already in the renderer)
idle/error → calm 6s breathe · listening/speaking → audio-driven amp+scale ·
thinking/transcribing → faster fluid + stronger iridescence.

## ⚠️ Verify before ship
Prepared in a Linux/web session (no Xcode). Build + **sim-verify all 6 states,
light & dark** (handoff §4 recipe), then batch into the next TestFlight build
for owner approval. Watch for: Metal library load (`makeDefaultLibrary`),
uniform struct offset parity, and premultiplied-alpha over the transparent
MTKView (page bg must show through around the orb).
