# Voice Orb — Modular

A premium AI voice-mode orb (Three.js + GLSL). Original implementation inspired by the ChatGPT Voice Mode aesthetic.

## Run

Needs a static server (ES modules + mic require an http(s) origin — `file://` won't work):

```bash
npx serve .        # or: python3 -m http.server 8080
```

Open the URL, tap the mic, allow microphone access.

## Files

| File | Role |
|------|------|
| `index.html`      | Markup + UI + import map |
| `style.css`       | Dark premium styling |
| `src/main.js`     | Wires the orb to the DOM UI |
| `src/VoiceOrb.js` | Scene, shader mesh, aura, bloom, controls |
| `src/audio.js`    | Mic capture + frequency analysis |
| `src/shaders.js`  | GLSL (simplex noise, orb, aura) + palettes |

## Features

- Liquid organic deformation via 3D simplex noise (fbm) in the vertex shader
- Audio-reactive: low band → outward swell, high band → surface ripples
- UnrealBloom + fresnel rim glow + additive inner core
- 900-particle additive aura orbiting the orb
- Breathing idle animation when the mic is off
- OrbitControls: drag to rotate, pinch / scroll to zoom (pan disabled)
- DPR capped at 2 + FXAA for stable high FPS on mobile & desktop
- Live tuning panel (deform / speed / detail / bloom / aura / mic gain / palette)
