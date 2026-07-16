# Claude Code Handoff — ALMA ERP iOS Native Polish, IOSP-4 only

Copy into a fresh session. Authorizes **IOSP-4 only**. IOSP-0..3 complete (`docs/IOSP-{0..3}-*.md`).

---

You are taking over at **IOSP-4 — Polling, realtime, and hidden-web-runtime reduction**. This is the **first TestFlight technical checkpoint** phase (device-only behaviour).

## Required reading (completely, first)

1. `CLAUDE.md` (highest authority) — esp. iOS TestFlight build gate + preflight, and "never touch /api/agent/*".
2. `docs/IOS_NATIVE_POLISH_MASTER_ROADMAP_2026-07.md` §8 Phase IOSP-4, §9 TestFlight strategy, §7 gates, §12 safety.
3. `docs/IOSP-0-BASELINE-REPORT.md` §7 (116 reqs/5-min idle; 3s intercom poll = 86%) + §8 + `docs/proofs/iosp0/launch-crash-diagnosis.md` (the CallKit×Agora crash) + `docs/IOSP-3-PHASE-REPORT.md`.
4. Source: `ios/App/App/FloatingChatHead.swift` (3s `startCallWatch` intercom poll), `ios/App/App/AlmaIslandBanner.swift` (30s), `ios/App/App/AgoraIntercom.swift` + `ios/App/App/CallKitVoIP.swift` (`providerDidReset` → `engine` keypath crash), scene-lifecycle in `AppDelegate`/`SpikeNativeShell.swift`, the retained Capacitor dashboard.

## Authorization

IOSP-4 only. End with a phase report + IOSP-5 handoff.

## IOSP-4 goal and work (roadmap §8)

- Replace the global **3-second** incoming-call poll (`FloatingChatHead.startCallWatch`) with push/realtime/CallKit-compatible signalling, or at minimum pause it when the related UI/scene is inactive/backgrounded.
- Scene-aware refresh scheduler; pause nonessential refresh when inactive/backgrounded; prefer event-driven invalidation over independent timers.
- Consolidate Agent/office notification feeds where the server contract allows (the IOSP-3 single-flight/`getCached` layer is available — use it).
- Audit why the hidden Capacitor dashboard must stay alive; extract only required bridges or suspend web rendering safely **without** breaking Hermes `/api/agent/*`, push, Face ID, shortcuts, widgets, Live Activities, voice, background work.
- **Fix the launch crash** (`docs/proofs/iosp0/launch-crash-diagnosis.md`): `CallKitVoIP.providerDidReset` reads `AgoraIntercom.engine` via an @Observable keypath that fails to demangle → SIGTRAP on any sim/device carrying stale CallKit state. Guard the reset path so it does not touch the Agora engine keypath when no engine exists.

## Exit criteria (roadmap §8)

No 2–3s polling when the related UI isn't active; 5-min idle request count **≥80% below** the IOSP-0 baseline (116 → ≤~23) unless an evidence-backed exception is approved; background/foreground, incoming call, push, Live Activity, auth continuity all pass; memory/CPU within limits; TestFlight technical checkpoint decision executed per §9.

## Verification (build success is NOT proof)

Re-run the IOSP-0 5-minute idle measurement on the clean Pro Max sim exactly as documented (report §7 has the command) and show the before/after count. Prove the crash fix: the app must launch cleanly on a sim carrying stale CallKit state (repro steps in the diagnosis). Extend the DEBUG harness if useful. Use sim `9E51818A-…`; re-enroll Face ID after reboot (`notifyutil -s com.apple.BiometricKit.enrollmentChanged 1` + `-p …enrollmentChanged`, match `-p com.apple.BiometricKit_Sim.pearl.match`). **Never** touch the other session's iPhone 17 Pro `5F79315F-…`; print the destination UDID before every simctl/xcodebuild.

**TestFlight:** IOSP-4 is the technical checkpoint. Do NOT upload yourself. Per `CLAUDE.md`: TestFlight builds go through the **GitHub Actions pipeline** (owner rule — no Mac/Xcode archive), from clean pushed main-current state, with `bash scripts/ios-build-preflight.sh` and a committed build-number bump. Prepare everything, then hand the owner the exact step; the owner triggers it. The programme's other TestFlight build is the final one after IOSP-9.

## Safety and branch rules

- Live production ERP. Preserve unrelated dirty state/worktrees. Never `git add -A`.
- Branch/tag: next free numeric pair — verify (expect **agent-phase-21** + `pre-agent-phase-21`).
- Never touch `/api/agent/*` or its auth; no financial semantics; no secrets; additive migrations only.
- Do not merge to main or deploy production. TestFlight only via the owner-triggered CI pipeline.

## Deliverables

Files changed; polling/scene-scheduler design; crash-fix diagnosis→fix; before/after idle-count table; TestFlight-readiness checklist for the owner; PASS/FAIL vs exit criteria; branch/commit; risks; IOSP-5-only handoff. Stop after IOSP-4.

---
