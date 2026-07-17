# Claude Code Handoff — ALMA ERP iOS Native Polish, IOSP-8 only

Copy into a fresh session. Authorizes **IOSP-8 only**. IOSP-0..7 complete (`docs/IOSP-{0..7}-*.md`).

---

You are taking over at **IOSP-8 — Xcode 27 / iOS 27 system-native modernization**.

## Hard blocker (read first)

**Xcode 27 and an iOS 27 Simulator runtime are NOT installed on this Mac** (current: Xcode 26.6 / iOS 26.5 SDK — see `docs/proofs/iosp0/toolchain.txt`). The roadmap (§8 IOSP-8) says: *"Do not fake iOS 27 support with custom tokens."* So the iOS-27-API-adoption core of this phase **cannot be executed until the owner installs Xcode 27 + an iOS 27 runtime.** Do the toolchain-independent subset now; document the rest as owner-blocked.

## Required reading

1. `CLAUDE.md`; roadmap §8 IOSP-8; `docs/proofs/iosp0/toolchain.txt` + `warning-summary.txt` (96 Swift6-async, 15 WKProcessPool, 1 allowBluetooth, 5 script-phase, 3 never-mutated-var).

## IOSP-8 doable-now subset (toolchain-independent, self-verifiable on Xcode 26.6)

- Remove/replace deprecated `WKProcessPool` usage (15 sites) where safe.
- Replace the deprecated `.allowBluetooth` audio-session option (1 site).
- Begin Swift 6 readiness: fix `async`-not-`await` warnings (96) incrementally — these become errors in Swift 6 language mode. Do NOT flip the language mode to 6 in one shot (roadmap: "without a risky all-at-once migration").
- Remove private implementation-class introspection from visual-effect handling where feasible.
- Clean the never-mutated-var (3) and CocoaPods script-phase-output (5) warnings.

Each change: build on the Pro Max sim, confirm no behaviour change via the DEBUG harness/signposts + a screenshot. Keep availability gates for supported older OS.

## Owner-blocked (defer, document)

- Xcode 27 rebuild + new-warning inventory; Liquid Glass adoption for controls/navigation; new SwiftUI iOS-27 APIs; iOS-27-Simulator regression. All require Xcode 27 + iOS 27 runtime.

## Safety and branch rules

- Live production ERP. Preserve unrelated dirty state/worktrees. Never `git add -A`.
- Branch/tag: next free pair — verify (expect **agent-phase-25** + `pre-agent-phase-25`).
- Never touch `/api/agent/*` or its auth; no money; no secrets; additive migrations only.
- Do not merge/deploy/TestFlight. Use sim `9E51818A-…`; never touch the other session's iPhone 17 Pro `5F79315F-…`; print the UDID before every simctl/xcodebuild.

## Deliverables

Files changed; warning-count before/after; owner-blocked list (Xcode 27 items); PASS/FAIL; branch/commit; risks; IOSP-9-only handoff. Stop after IOSP-8.

---
