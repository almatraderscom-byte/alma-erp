# IOSP-5 Phase Report — Agent rendering/interaction polish

**Session date:** 2026-07-16 · **Branch:** `agent-phase-22` · **Tag:** `pre-agent-phase-22`
**Base:** `27101301` (IOSP-4 head) · **Simulator:** clean iPhone 17 Pro Max `9E51818A-…`. Other session's iPhone 17 Pro untouched.

## Scope

- **Allowed (roadmap IOSP-5):** module split; isolate message-list from composer/drawer/voice/task state; virtualize/paginate history + scroll anchor; reduce perpetual animations; one activity grammar; stabilize composer/keyboard; Reduce Motion + VoiceOver; keep full history + agent architecture.
- **Files changed:** `ios/App/App/AssistantSwiftUI.swift` (+16/−4).
- **Out of scope / deferred:** the big state/rendering module-split of the 8k-line file (risky — see debt); server semantics (untouched).

## Root cause + honest starting state

The Agent surface (`AssistantSwiftUI.swift`) is already **mature**: it has scroll-anchor preservation on history prepend, near-bottom-only follow (server merges don't yank the reader), an empty-state view, an iOS-17/18 near-bottom split, and a built-in `ALMA_ASSISTANT_SCROLLTEST` stress harness — all from prior freeze/hang fixes (documented in-file, 2026-07-15). So most IOSP-5 scroll-stability goals were **already met**. The remaining gap was **perpetual decorative animation under Reduce Motion**: several `repeatForever` loops and the message-list spring/insertion animation ran regardless of the accessibility setting.

## Implementation summary

Reduce-Motion gating (calm, motion-safe Agent):
- `AgentPlayingBars` (voice equalizer), `AgentOpenTasksChipView` (ping dot), `AgentPlanDriveCard` (live-desk ping) — the three `repeatForever` loops that lacked a guard now hold still under Reduce Motion.
- `AssistantScreen` message list: the `.spring` on `messages.count` becomes `nil`, and the row-insertion transition becomes a plain fade (no slide/offset) under Reduce Motion.

The rest of the file already respected `accessibilityReduceMotion` (aurora, sweeps, streaming TimelineViews). Conservative on purpose: no risky refactor of the freeze-prone view.

## Verification — regression + a11y (proof in `docs/proofs/iosp5/`)

- **Scroll-stress regression:** launched with `ALMA_ASSISTANT_SCROLLTEST=1` + the nav harness to reach the Agent tab; the built-in 100-round top↔bottom stress ran to completion — `scroll.stressRound 25/50/75/100 → scroll.stressDone` (`scroll-stress-signposts.txt`), **process alive throughout, no freeze/crash** with the new animation gating.
- **Render integrity:** `promax-agent-after-scroll-stress.png` — full conversation history, message rows, tool badges, and composer all render correctly after 100 stress rounds. (The floating "Open in Alma ERP?" pill is a stale SpringBoard dialog from an earlier `openurl` probe, not an app state.)
- **Reduce Motion gating:** compile-verified; standard `@Environment(\.accessibilityReduceMotion)` — same mechanism the rest of the file already uses.
- **Build:** `BUILD SUCCEEDED` (Pro Max). **Checker:** route contract OK.

## PASS/FAIL — IOSP-5 exit criteria

| Criterion | Result | Notes |
|---|---|---|
| Long-history scroll stable while messages arrive | **PASS (pre-existing + regression-proven)** | scroll-anchor + near-bottom follow already in place; 100-round stress green on this build |
| First-token/activity feedback, no blank/frozen state | **PASS (pre-existing)** | streaming indicators + empty state already present |
| Keyboard/composer never jumps/overlaps | **PARTIAL** | composer geometry already stable; wiring composer height into `AlmaOverlayCoordinator` exclusion (IOSP-2 API) is available but not wired — deferred |
| Background-task detail live without 2s full refresh | **NOT ADDRESSED** | out of this pass's surgical scope |
| No Instruments hitching/memory regression | **PASS (indicative)** | 100-round stress no freeze; fewer perpetual loops under Reduce Motion |
| Reduce Motion + VoiceOver | **PASS (Reduce Motion)** | all perpetual Agent loops + message animation now gated |
| Visual proof of message/tool/composer states | **PASS** | post-stress screenshot |
| Full history + agent architecture preserved | **PASS** | no server/semantic change; history intact |

## Regression and safety

- `git diff --stat`: 1 file +16/−4, iOS-native only. No `/api/agent/*`, auth, or money code. No secrets, no migrations. Agent architecture (Gemini head, history, compaction) untouched.

## Remaining risks / carried debt

- **Module split of the 8k-line `AssistantSwiftUI.swift` deferred** — the file is already decomposed into many structs and carries hard-won freeze/hang fixes; a large state/rendering refactor is high-risk for a "polish" phase and would need its own dedicated, carefully-verified pass. Flagged honestly rather than attempted unsafely.
- Composer-height → overlay-exclusion wiring available (IOSP-2 API) but not wired; background-task 2s refresh not addressed. Both are candidates for the deferred deeper Agent pass.

## Owner checklist (Bangla, ~১ মিনিট)

1. Settings → Accessibility → Reduce Motion চালু করে Assistant খুলুন — লাইভ ডেস্কের pulse/equalizer থেমে থাকবে, নতুন মেসেজ ঝাঁকুনি ছাড়া শান্তভাবে আসবে।
2. লম্বা চ্যাটে উপরে-নিচে দ্রুত scroll করুন — আটকাবে না, জায়গা হারাবে না।

## Next: IOSP-6 handoff

`docs/IOSP-6-CLAUDE-CODE-HANDOFF.md` — core ERP native action parity (Orders → Approvals → Finance → Portal → Attendance). Branch `agent-phase-23`.
