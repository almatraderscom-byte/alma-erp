# NP-9 — End-to-end verification (headless portion complete; sim/TestFlight awaiting owner)

**Date:** 2026-07-17 · **Branch:** `claude/ios-native-parity-roadmap-aab64a` (pushed, NOT merged; Vercel previews skipped throughout — ios/docs/scripts-ios paths only)

## Headless verification — DONE

| Check | Result |
|---|---|
| Simulator build (iPhone 17 Pro Max), clean roadmap worktree | **BUILD SUCCEEDED** after every phase (NP-1..NP-8) |
| Route contract checker | **OK** — 70 fixtures / 66 web routes; 66 native-required · 1 temporary-web (creative-studio-demo) · 3 public |
| Feature/action parity checker | **OK** — 43 surfaces / 104 actions, 0 open |
| Feature checker `--strict` (release gate) | **PASSES (exit 0)** |
| openWeb audit | Every site = EX-07/EX-08 (login fallback / optional mirror); counts pinned; new sites fail CI |
| Whole-taka money rule | All new ৳ writes round to Int (settle override, bkash, spotlight none, slip display) |
| Polling/lifecycle | All new loops scenePhase-gated + SwiftUI-cancelled |

Commits: NP-0 `584ca5ff` · NP-1 `09924d48` · NP-2 `4bf10c2b` · NP-3 `f6da9a2a` · NP-4 `0beb338f` · NP-5 `88d2f53e` · NP-6 `6d09d6b7` · NP-7 `be972070` · NP-8 `275a4ab2`

## Remaining — needs the OWNER (per his instruction, in order)

1. **Owner permission → simulator verification session** (Claude runs it): install on iPhone 17 Pro Max sim + a 6.1-inch sim, first-fold screenshots of LIVE Business (all five tabs), light/dark, Dynamic Type large, changed-screen smoke across routes, deep-link fixtures (`/agent/live-watch`, `/portal/wallet`, `/reset-password?token=test` via ALMA_NAV_SELFTEST).
2. **Owner live verification** of the branch build + web cross-checks (control values after mutations, money before/after on a real settle).
3. **Owner-hardware checks:** real camera captures, Face ID prompts, push, phone/WhatsApp handoffs, Google OAuth consents (GSC + Drive).
4. **Owner confirm → ONE TestFlight build** (preflight script; note: preflight requires main-current — this branch build will use `ALMA_PREFLIGHT_ALLOW_BRANCH=1` OR ship after the owner merges, his call) — then merge to main per his flow.
5. Merge-time follow-up: delete `src/app/agent/creative-studio-demo/` (deferred so this branch never triggers a Vercel build).
