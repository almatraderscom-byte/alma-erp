# Claude Code Handoff — ALMA ERP iOS Native Polish, IOSP-2 only

Copy this prompt into a fresh Claude Code session. It authorizes **IOSP-2 only** (one roadmap phase per session). IOSP-0 (`agent-phase-16`) and IOSP-1 (`agent-phase-18`) are complete — see `docs/IOSP-0-BASELINE-REPORT.md` and `docs/IOSP-1-PHASE-REPORT.md`.

---

You are taking over the ALMA ERP iOS Native Polish programme at **IOSP-2 — Overlay and safe-area coordinator**.

## Required reading (completely, before any action)

1. `CLAUDE.md` (repo rules — highest authority)
2. `docs/IOS_NATIVE_POLISH_MASTER_ROADMAP_2026-07.md` — §8 Phase IOSP-2, §3.3 (overlay evidence), §7 (gates), §12 (safety)
3. `docs/IOSP-0-BASELINE-REPORT.md` §3/§7 + `docs/IOSP-1-PHASE-REPORT.md`
4. Source: `ios/App/App/FloatingChatHead.swift`, `ios/App/App/AlmaIslandBanner.swift`, `ios/App/App/AppDelegate.swift` (overlay installation ~lines 56–61 of the audited base), `ios/App/App/SwiftUIShell.swift` (tab bar), Agent composer/task-sheet surfaces in `ios/App/App/AssistantSwiftUI.swift`

## Authorization

Execute IOSP-2 only. End with a phase report + an IOSP-3-only handoff, then stop. No TestFlight (programme policy: technical checkpoint after IOSP-4, final after IOSP-9).

## IOSP-2 goal and work (roadmap §8)

Global UI must never hide local UI:

- one overlay presentation model/coordinator for Chat Head, Connectivity Beacon, Alma Island/banner, toasts;
- exclusion zones: tab bar, keyboard, Agent composer, sheets/detents, alerts;
- floating Agent affordance docks/relocates predictably;
- `safeAreaInset`/layout guides instead of fixed `UIScreen.main.bounds` (5 sites in the IOSP-0 inventory);
- z-order + simultaneous-presentation policy (task sheet + stop confirm + chat head + island = baseline worst case);
- Reduce Motion / Reduce Transparency / VoiceOver focus / larger text support on the overlay layer;
- remove fragile private-view-hierarchy tint stripping where feasible within scope.

**Required test matrix (roadmap):** all five root tabs × keyboard states × composer states (empty/multiline/attachment/voice) × task sheet collapsed/expanded × approval confirm/error alert × incoming call/banner over a sheet × portrait/rotation × default+accessibility text sizes.

**Exit criteria:** zero occluded actionable controls across the matrix; screenshot/video proof for every collision-prone state. IOSP-0's baseline screenshot (`docs/proofs/iosp0/promax-01-launch-dashboard.png`) already shows the chat head overlapping Dashboard revenue content — that collision must be gone.

## Safety and branch rules

- Live production ERP. Preserve unrelated dirty state/worktrees. Never `git add -A`.
- Branch/tag: next free numeric pair — **verify with `git branch -a | grep agent-phase` + `git tag -l 'pre-agent-phase-*'` first** (17 was taken by unrelated work; 18 = IOSP-1; expect **agent-phase-19** + `pre-agent-phase-19`).
- Never touch `/api/agent/*` or its auth; no financial/business semantics changes; no secrets; additive migrations only (none expected).
- Do not merge to main, deploy production, or upload TestFlight.

## Simulator isolation — mandatory

- Use an iPhone 17 Pro Max, iOS 26.5. The clean sim from IOSP-0/1 is **`9E51818A-AA25-4C9F-9C1F-9EE2D99E2998`** ("iPhone 17 Pro Max IOSP0") — already has the app + logged-in native session + Face ID data. After a sim reboot, re-enroll Face ID: `notifyutil -s com.apple.BiometricKit.enrollmentChanged 1` + `-p com.apple.BiometricKit.enrollmentChanged`, match with `-p com.apple.BiometricKit_Sim.pearl.match`.
- The roadmap-assigned `94E0186B-…` sim crashes at launch (CallKit×Agora — IOSP-0 report §8); avoid or reset it.
- **Never** boot/install/launch/erase/control the other session's **iPhone 17 Pro** (`5F79315F-…`). Print the destination UDID before every `simctl`/`xcodebuild` command.
- Owner rule: Claude does not hand-drive the simulator UI. Use the IOSP-1 pattern instead: the DEBUG env-gated self-test harness in `AppDelegate.swift` (`ALMA_NAV_SELFTEST`) + timed `simctl io screenshot`/`recordVideo` + `com.almatraders.erp.perf` signposts (`log show --signpost`). Extend the harness for overlay states if needed (keyboard/composer states may need `.almaOpenPath`-style notifications or an equivalent DEBUG hook). Tap-only checks go to the owner as a short Bangla checklist.

## Verification gate

Build for the Pro Max UDID; install/launch there only; drive the collision matrix as far as headlessly possible; screenshots named per state + video for keyboard/composer/overlay transitions; accessibility proof (Reduce Motion/Transparency, XL text) via `simctl ui <udid> increase_contrast` etc. where supported; run `node scripts/iosp0-route-contract-check.mjs` (must stay green); `git diff --stat` scope check; confirm no protected code. Build success alone is not proof. If any web/API file changes, Vercel preview + owner-Chrome proof is mandatory.

## Deliverables

Files changed; overlay coordinator design; collision-matrix results table (PASS/FAIL per state); proof paths; branch/commit; unresolved risks; an IOSP-3-only handoff. Stop after IOSP-2.

---
