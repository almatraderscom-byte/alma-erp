# Native Voice Orb — 100% parity patch

Target: `ios/App/App/AssistantVoiceSwiftUI.swift` → `struct AlmaGlassOrbView`
(branch `claude/ios-s0-native-shell-spike`). Apply + **sim-verify** in an iOS
session (this handoff was prepared in a Linux/web session with no Xcode).

## Verified: what already matches the session design 1:1
sphere hex-stops, subsurface, fluid c1/c2 conic colors, gloss, spec + spec.small,
fresnel ring, halo (2-stop blue+violet), contact shadow, breathe 6s/2.6s,
floaty ±2.5% 6.5s, listening/speaking scale = 1+level×0.10, all 6 states. ✅

## The 3 gaps to close for end-to-end parity

### 1) Organic liquid edge (web `filter:url(#liquid)` feDisplacementMap)
The web orb's silhouette gently wobbles; native uses a perfect `Circle()`.
Add this Shape (top level, near AlmaGlassOrbView):

```swift
/// Subtle organic edge — the CSS feDisplacementMap "liquid" feel (~1.2% radius).
struct WobblyCircle: Shape {
    var t: Double
    func path(in rect: CGRect) -> Path {
        let c = CGPoint(x: rect.midX, y: rect.midY)
        let baseR = min(rect.width, rect.height) / 2
        var p = Path()
        let steps = 120
        for i in 0...steps {
            let a = Double(i) / Double(steps) * 2 * .pi
            let w = sin(a * 3 + t * 0.6) * 0.5
                  + sin(a * 5 - t * 0.4) * 0.3
                  + sin(a * 2 + t * 0.25) * 0.4
            let r = baseR * (1 + w * 0.012)
            let pt = CGPoint(x: c.x + CGFloat(cos(a)) * CGFloat(r),
                             y: c.y + CGFloat(sin(a)) * CGFloat(r))
            if i == 0 { p.move(to: pt) } else { p.addLine(to: pt) }
        }
        p.closeSubpath()
        return p
    }
}
```

Then, on the orb's inner `ZStack` (the one currently ending with
`.frame(width: side, height: side)` `.clipShape(Circle())`), replace:

```swift
.clipShape(Circle())
```
with:
```swift
.clipShape(WobblyCircle(t: t))
```

### 2) Fine grain (web `.grain`, overlay ~0.1) — kills the flat look
Insert just **before** the closing `}` of that inner orb `ZStack`
(i.e. right after the fresnel-ring `Circle()`):

```swift
// grain — fine deterministic noise, overlay (web .alma-orb__grain)
Canvas { ctx, size in
    var seed: UInt64 = 88
    func rnd() -> Double {
        seed = seed &* 6364136223846793005 &+ 1442695040888963407
        return Double(seed >> 40) / Double(1 << 24)   // 0…1
    }
    let cell: CGFloat = 3
    var y: CGFloat = 0
    while y < size.height {
        var x: CGFloat = 0
        while x < size.width {
            ctx.fill(Path(CGRect(x: x, y: y, width: cell, height: cell)),
                     with: .color(.white.opacity(rnd() * 0.10)))
            x += cell
        }
        y += cell
    }
}
.frame(width: side, height: side)
.blendMode(.overlay)
.opacity(0.5)
```

(Seed is fixed, so the noise is static — matches a texture, cheap enough at 30fps.)

### 3) Make the iridescent fluid a touch more visible (optional, matches the premium feel)
In fluid **c1** change opacity `0.55` → `0.62` (keep the thinking/transcribing 0.7),
and fluid **c2** `0.45` → `0.52`. Tiny bump; the flowing cyan/indigo reads better on-device.

## Bigger, separate option — the WebGL "refraction" look natively
The session's most photoreal orb refracts the environment with chromatic
aberration (a GLSL glass shader). SwiftUI shapes can't do that; it needs a
**Metal/SceneKit** layer (a `MTKView`/`SCNView` wrapped in `UIViewRepresentable`
with a glass shader + a small env cubemap). That's a real iOS task on its own —
flag to the owner before committing to it. The CSS-glass parity above is what the
current bundle/`voice-orb-react.html` specifies.

## Apply checklist (iOS session)
1. `git fetch origin claude/ios-s0-native-shell-spike` → rebase (parallel work).
2. Add `WobblyCircle`, swap the clip, insert the grain `Canvas`, bump fluid opacity.
3. Build + **sim-verify** all 6 states light & dark (doc §4 recipe).
4. Batch into the next TestFlight build for the owner to approve.
