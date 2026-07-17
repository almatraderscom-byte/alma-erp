# Claude Code Handoff — ALMA ERP iOS Native Polish, IOSP-5 only

Copy into a fresh session. Authorizes **IOSP-5 only**. IOSP-0..4 complete (`docs/IOSP-{0..4}-*.md`).

---

You are taking over at **IOSP-5 — Agent rendering and interaction polish**.

## Required reading (first)

1. `CLAUDE.md` (highest authority; esp. Agent architecture — full history retained, no server-semantic changes).
2. `docs/IOS_NATIVE_POLISH_MASTER_ROADMAP_2026-07.md` §8 Phase IOSP-5, §7 gates.
3. `docs/IOSP-2-PHASE-REPORT.md` (overlay coordinator — the composer exclusion API `AlmaOverlayCoordinator.maxCenterY` is ready to wire), `docs/IOSP-3-PHASE-REPORT.md` (single-flight/getCached available), `docs/IOSP-4-PHASE-REPORT.md`.
4. Source: `ios/App/App/AssistantSwiftUI.swift` (~8k lines — the Agent surface), `AssistantVoiceSwiftUI.swift`.

## Authorization

IOSP-5 only. End with a phase report + IOSP-6 handoff.

## IOSP-5 goal and work (roadmap §8)

Make Agent conversation calm/fast/stable:
- split oversized Agent state/rendering into focused modules (no server-semantic change);
- isolate message-list updates from composer/drawer/artifacts/voice/background-task state;
- virtualize/paginate long histories, preserve scroll anchor (new messages must not yank scroll);
- reduce perpetual decorative timelines / redundant repeat animations;
- one streaming/activity indicator grammar;
- stabilize keyboard, multiline composer, attachment tray, voice mode, side drawer, task-sheet transitions (wire the composer height into `AlmaOverlayCoordinator` exclusion — the IOSP-2 API is ready);
- Reduce Motion + VoiceOver;
- **maintain full conversation history + current agent architecture rules** (head on Gemini, no compaction changes, etc.).

## Exit criteria

Long-history scroll stays stable while new messages arrive; first-token/activity feedback without a blank/frozen state; keyboard/composer never jumps or overlaps; background-task detail stays live without 2s full refreshes; no Instruments regression in hitching/memory; visual proof for text, image, approval card, tool activity, error/retry, voice, background-task states.

## Verification

Extend the DEBUG env-gated harness (`AppDelegate`, `ALMA_*_SELFTEST` pattern) if useful; prove scroll-anchor stability + composer/keyboard geometry with timed screenshots/video + `com.almatraders.erp.perf` signposts. Use sim `9E51818A-…`; re-enroll Face ID after reboot. **Never** touch the other session's iPhone 17 Pro `5F79315F-…`; print the UDID before every simctl/xcodebuild. Owner rule: no hand-driving the sim UI — harness + signposts + timed screenshots; tap-only checks → Bangla owner checklist.

## Safety and branch rules

- Live production ERP. Preserve unrelated dirty state/worktrees. Never `git add -A`.
- Branch/tag: next free pair — verify (expect **agent-phase-22** + `pre-agent-phase-22`).
- Never touch `/api/agent/*` or its auth; no agent server semantics; no money; no secrets; additive migrations only.
- Do not merge/deploy/TestFlight. Any web/API change → Vercel preview + owner-Chrome proof.

## Deliverables

Files changed; module split summary; scroll-stability + composer-geometry proof; PASS/FAIL vs exit criteria; branch/commit; risks; IOSP-6-only handoff. Stop after IOSP-5.

---
