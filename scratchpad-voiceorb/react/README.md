# Voice Orb — React (ChatGPT Voice–style)

A production-ready, mobile-first voice-mode UI: an original, fluid animated orb
inspired by the ChatGPT Voice Mode *aesthetic* (not a copy of any closed-source
code). Built with **React + Tailwind CSS + Framer Motion**, and pure CSS/SVG for
the orb — no WebGL, so it runs anywhere.

## Run

```bash
npm install
npm run dev      # Vite dev server
npm run build    # production build
```

## How the orb works

The orb is a stack of layers inside a circular, `overflow:hidden` element:

| Layer | What it does |
|-------|--------------|
| `.orb-glow`   | blurred blue halo behind the orb |
| `.orb` (`filter:url(#liquid)`) | clips to a circle **and** runs an animated `feTurbulence` + `feDisplacementMap` so the edge undulates like a liquid drop |
| `.orb-body`   | the blue radial gradient (sky → cyan → royal blue, soft white top) |
| `.cloud-layer` ×2 | animated fractal noise (`#clouds1/2`) → drifting white cloud wisps; two layers counter-rotate for a flowing, morphing feel |
| `.orb-sheen`  | rotating conic highlight → the slow "gradient rotation" |
| `.orb-hi`     | fixed top-left specular sheen |

**Scale** (breathing / audio pulse) is the one thing Framer Motion owns
(`Orb.jsx`), so it can spring smoothly between states. Everything else is
continuous CSS/SVG animation.

## States

`VoiceMode.jsx` is a small state machine: `idle → listening → thinking → idle`.

- **Idle** — slow breathing + slow gradient rotation
- **Listening** — orb scale tracks a mocked mic level (`useMockAudio`); faster sheen/cloud drift
- **Thinking** — quick breathing, faster spin, and a stronger blurred `#liquidThinking` edge filter

To go live, replace `useMockAudio` with a Web Audio `AnalyserNode` and feed the
averaged frequency data into `level`.

## Files

```
src/
  main.jsx         mounts <OrbFilters/> + <VoiceMode/>
  VoiceMode.jsx    layout, state machine, theme toggle, controls
  Orb.jsx          the orb (Framer Motion scale + layer markup)
  orb.css          orb layer styles + cloud/sheen keyframes
  OrbFilters.jsx   SVG filter defs (#liquid, #liquidThinking, #clouds1/2)
  useMockAudio.js  mocked mic-volume hook
  icons.jsx        mic / close / sliders icons
  index.css        Tailwind + light/dark surface
```

## Light / dark

The top-right sliders icon toggles a `.dark` class on the `.screen` wrapper;
Tailwind `dark:` variants and the `.screen.dark` gradient handle the transition.
