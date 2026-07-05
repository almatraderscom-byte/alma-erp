# Voice Orb — Complete Handoff Spec

This bundle contains **everything** for the AI Voice Orb page. Hand this whole
folder to another session and say: *"Reproduce the Voice Orb exactly from this
bundle — do not redesign; the files are the source of truth."*

The **authoritative design = the files themselves**. This document is the map +
the exact design tokens so the look & behaviour can be reproduced 1:1 even by
reading the spec alone.

---

## 0. Which file is which (pick your target)

| File | Stack | Use it when |
|------|-------|-------------|
| **`voice-orb-webgl.html`** | Three.js (WebGL) + CSS fallback | ⭐ The **flagship**: photoreal glass orb — real-time fluid + chromatic refraction + live environment reflection. Needs a GPU/real browser. Auto-falls back to the CSS glass orb where WebGL is missing. |
| **`voice-orb-react.html`** | Vanilla HTML/CSS/JS (self-contained) | The **premium CSS glass orb** (Siri-style). No libraries, no build, no network — runs from `file://` and inside embedded previews. Same UI/states. |
| `voice-orb.html` | Three.js (WebGL) + 2D canvas fallback | Earlier **dark-theme** audio-reactive orb (particles + bloom). Kept for reference. |
| `react/` | React + Vite + Tailwind + Framer Motion | **Production modular source** of the CSS glass orb (components, hooks, states). `npm i && npm run dev`. |
| `modular/` | ES-module Three.js | Modular source of the dark WebGL orb. |

> The **current / intended design** is the **light-theme glass orb** shown in
> `voice-orb-webgl.html` (WebGL) and `voice-orb-react.html` (CSS). Everything
> below documents that design. Treat the WebGL file as the hero and the
> self-contained CSS file as its guaranteed-to-render twin.

---

## 1. Layout (all versions share this shell)

Full-screen, mobile-first, centered column:

```
┌───────────────────────────────┐
│  status text        ⚙ settings │   settings: top-right, sliders icon
│  [idle][listening][thinking]   │   state switcher pills (demo control)
│                                │
│            (  ORB  )           │   centered, flex:1 area
│                                │
│      (mic)          (✕)        │   two circular buttons, bottom
└───────────────────────────────┘
```

- **Status** — top, uppercase, letter-spacing `.14em`, 13px, opacity ~.55.
  Idle text: `Tap the mic to **speak**` (the word "speak" in blue `#2f7fe0`).
- **State pills** — `idle / listening / thinking`; active pill filled `#2f7fe0` white text.
- **Settings icon** — top-right, sliders glyph, gray `#9fb0c8`; toggles light/dark.
- **Bottom controls** — `max-width:320px`, space-between, `padding: 0 42px`.

---

## 2. Design tokens

### Colors / surfaces
| Token | Light | Dark |
|-------|-------|------|
| Screen bg | `radial-gradient(130% 120% at 50% 22%, #ffffff 0%, #eef4fc 52%, #dde8f5 100%)` | `radial-gradient(130% 120% at 50% 22%, #121826 0%, #0a0e17 55%, #04060c 100%)` |
| Text | `#2b3a52` | `#dbe6f7` |
| Accent (blue) | `#2f7fe0` | `#2f7fe0` |
| Settings icon | `#9fb0c8` | `#9fb0c8` |

### Orb palette (glass)
- Sphere gradient (light top-left → deep core bottom-right):
  `radial-gradient(circle at 36% 28%, #ffffff 0%, #e4f2ff 7%, #b7ddff 19%, #7ec2fb 36%, #4a98ee 56%, #2b73d8 74%, #1a56bd 88%, #103f92 100%)`
- Iridescent fluid hues: `#8fe0ff, #4aa3ff, #6a7bff, #59e6ff, #3f8dff, #a7c4ff` (blue→cyan→indigo).
- Glass tint (WebGL `uTint`): `rgb(0.78, 0.86, 1.0)`. Core glow `uCore`: `rgb(0.82, 0.94, 1.0)`.
- Halo bloom: `rgba(90,170,255,.5)` + violet `rgba(120,110,255,.28)`.

### Typography
System stack: `-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif`.

### Sizing
- Orb stage: `width: clamp(230px, 62vw, 340px)` (WebGL) / `clamp(220px, 60vw, 320px)` (CSS), `aspect-ratio: 1/1`.
- Buttons: `64×64px` circles.
- Settings: `44×44px`.

---

## 3. The orb — layer structure

### 3a. CSS glass orb (`voice-orb-react.html`)
Stacked layers inside a circular `overflow:hidden` `.orb` (with `filter:url(#liquid)`):
1. **`.halo`** — blurred blue+violet bloom behind (`inset:-40%`, `blur(26px)`).
2. **`.shadow`** — soft contact shadow below (`blur(9px)`), pulses opposite to float → grounds the orb.
3. **`.sphere`** — volumetric radial gradient + `box-shadow` insets: core shadow `inset -22px -26px 54px rgba(9,38,96,.55)` + fill light `inset 16px 18px 44px rgba(255,255,255,.5)`.
4. **`.subsurf`** — inner scattering glow, `screen` blend.
5. **`.fluid.c1/.c2`** — two counter-rotating conic-gradient iridescent layers, `blur(16px)`, `screen`/`overlay` blend.
6. **`.grain`** — SVG fractal-noise, `overlay`, opacity ~.12 (kills flat look).
7. **`.gloss`** — broad top reflection ellipse, `screen`.
8. **`.spec` + `.spec.small`** — tight bright specular hotspots (wet glass).
9. **`.ring`** — fresnel rim: `radial-gradient(..., transparent 66%, rgba(180,220,255,.35) 82%, rgba(255,255,255,.5) 90%, transparent 96%)`, `screen`.

### 3b. WebGL glass orb (`voice-orb-webgl.html`)
- **Geometry**: `IcosahedronGeometry(1.2, 96)` (40 on mobile).
- **Custom ShaderMaterial**:
  - *Vertex*: Ashima 3D simplex + `fbm` → displace along normal by `d * uAmp`; jitter the normal with a second fbm for shimmer.
  - *Fragment*: fresnel `pow(1-dot(N,V),3)`; **reflection** = `textureCube(uEnv, reflect(I,N))`; **refraction with chromatic aberration** = sample R/G/B with slightly different `eta` (`0.66 ± 0.018*uIrid`); mix refraction (center) ↔ reflection (edge) by fresnel; add specular hotspot + fresnel rim + subsurface core.
- **Environment**: `CubeCamera` + `WebGLCubeRenderTarget(256)` capturing an `envScene` of 6 colored blobs (`#8fe0ff,#4aa3ff,#6a7bff,#ffffff,#bfe0ff,#a78bff`) on `#e8f3ff`; re-rendered every 3rd frame while the blobs rotate → moving reflections.
- **Renderer**: `alpha:true`, transparent clear, `pixelRatio` capped at 2.
- **Halo + contact shadow**: reused from CSS (behind/below the transparent canvas).
- **Controls**: hand-rolled drag-rotate + wheel/pinch zoom (no OrbitControls addon, so the UMD build works from `file://`).
- **Three.js**: UMD classic build `https://unpkg.com/three@0.150.1/build/three.min.js` (classic `<script>` so it runs from `file://`; ES-module import maps are blocked on the `file://` origin — do NOT switch to modules).

---

## 4. Animations

| Name | What | Timing |
|------|------|--------|
| `breathe` | orb scale 1 → 1.04 → 1 | idle 6s / thinking 2.6s (listening: none, JS drives scale) |
| `floaty` | orb translateY ±2.5% | 6.5s ease-in-out |
| `shadowPulse` | contact shadow scale/opacity (opposite of float) | 6.5s |
| `spin` | fluid/sheen rotation | c1 18s, c2 26s reverse (faster in listening/thinking) |
| liquid edge | SVG `feTurbulence`+`feDisplacementMap` animating `baseFrequency` | 18s (thinking uses stronger `#liquidThinking`) |

---

## 5. States (idle / listening / thinking)

State machine in the inline `<script>` (`setState(s)`):
- **idle** — slow breathe + slow gradient rotation; status "Tap the mic to speak".
- **listening** — orb scale tracks audio level (real mic if granted, else mock envelope); faster fluid/sheen; mic button turns solid blue (`.mic.on`); status "Listening…".
- **thinking** — quick breathe, fast spin, stronger displacement/iridescence, slight blur; auto-returns to **idle** after ~2.8s; status "Thinking…".

**Transitions**: mic button toggles `listening ⇄ thinking`; ✕ button → `idle`; pills set state directly; settings icon toggles `.light`/`.dark` on `.screen`.

---

## 6. Audio

- Real mic: `getUserMedia` → `AnalyserNode` (fftSize 512) → averaged frequency → smoothed `level` in 0..1.
- Mock fallback (when mic denied/unavailable): speech-like envelope
  `0.42 + 0.34*sin(t*2.1) + 0.18*sin(t*5.7+1.3)` × jitter, smoothed.
- `level` drives orb scale (`+level*0.10`) and, in WebGL, displacement amp & flow speed.
- To go fully live: keep the real-mic path; nothing else changes.

---

## 7. SVG filters (referenced by CSS `filter:url(#id)`)

- `#liquid` — fractalNoise (baseFreq ~0.008, animated) + displacementMap scale 9 → gentle organic edge.
- `#liquidThinking` — stronger (baseFreq ~0.013, scale 22) + small blur.
- `#clouds1/#clouds2` (in the cloud variant) — fractal noise → white wisps, alpha from red channel via `feColorMatrix`.
- `#grainF` — high-freq fractal noise tinted for the fine grain layer.

---

## 8. Reproduction checklist (for the receiving session)

1. Keep the **light theme** and the **glass orb** as the design. Do not swap to a flat/solid ball.
2. Preserve the exact tokens in §2 and the layer stack in §3.
3. Keep all three **states** and their timings (§4–5).
4. Keep the **self-contained** nature of `voice-orb-react.html` (no CDN/build) — it must render from `file://` and embedded previews.
5. For WebGL, keep the **UMD classic `<script>`** (not ES modules) and the **CSS fallback** path.
6. Buttons: mic (left) + ✕ (right), 64px white circles, black icons, tap-scale.
7. Settings icon top-right = sliders glyph = light/dark toggle.

> Fastest 100%-identical path: **use the files in this bundle as-is.** This spec
> is the safety net if the files must be regenerated.
