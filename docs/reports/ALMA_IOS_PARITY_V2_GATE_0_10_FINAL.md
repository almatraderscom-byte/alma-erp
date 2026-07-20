# ALMA iOS Parity v2 — Gate 0–10 Final Verification

Date: 2026-07-20
Worktree: `/Users/marufbillah/alma-erp-ios-uiux-4-8`
Branch: `agent-phase-ios-parity-v2-gates-0-10`
v2 start commit: `0db229d6ae312de0900610f3c7c7c9524659b18e`
Main merge-base: `4886277ab7de4e3821ffeee2af36082776d1e5f3`

No work was written to `main`. No merge, push, deploy, TestFlight upload, or
remote mutation was performed during this verification.

## Reconciliation outcome

- Gate 0–3 queue, approval, recovery, exact-resume, ask/opinion, and bounded-loader
  fixes were preserved.
- The rejected detented root menu was not restored. The root ellipsis is a compact
  source-anchored UIKit menu; Uploaded files opens the dedicated large Library.
- Gate 1 now includes the v2 attachment-loss P0 contract: attachment bytes, draft,
  provisional session identity, pending acceptance, retry, and cancel survive kill.
- The normal appearance remains glossy and translucent. The intentionally opaque
  screenshot was captured only while iOS Reduce Transparency was enabled; the
  accessibility fallback and restored-normal-state evidence are both retained.

## Gate matrix

| Gate | Implementation / acceptance evidence | Result |
|---|---|---|
| 0 — freeze and repro | Deterministic parity, stress, recovery, approval, attachment, huge-session, dictation, and menu fixtures; signposts for content-ready, settings, paging, recovery, and soak | PASS |
| 1 — outgoing + attachments | Durable composer snapshots, stable provisional-session identity, cached attachment bytes, atomic acceptance/idempotency, visible queued/failed/retry/cancel states | PASS |
| 2 — approvals/actions | Persistent action registry, duplicate-submit guard, multiple-card identity, lost-response/409/410 reconciliation, retained Ask/Opinion inputs | PASS |
| 3 — resume/recovery | Persisted RecoverableTurn, queue, generation-owned transport handoff, cursor replay, exact conversation/session guard, bounded stall failure | PASS |
| 4 — semantic response model | Native Copy/Read aloud/Helpful/Not helpful/Share/More row plus direct consumption of canonical server `presentation.version/blocks/usage` and stable block IDs | PASS |
| 5 — voice/dictation/TTS | Full chunked TTS, Boss normalization, durable Application Support recording, retry/discard, transcription-in-flight recovery marker, draft append | PASS |
| 6 — unified Library | Uploaded + generated files, All/Uploaded/Generated, preview/share/download/save/show-source; full-session paged index and older-source materialization | PASS |
| 7 — conversation menu | Compact source-anchored glossy UIMenu; Share, Pin, Project, Uploaded files, Search, Export, Rename, Archive, separated Delete; active-turn destructive actions disabled | PASS |
| 8 — huge sessions | 72-row mounted bound, reversible older/newer caches, composite `(createdAt,id)` cursors, exact search promotion, progressive giant Markdown, 600-message fixture | PASS |
| 9 — Bangla/accessibility/polish | Dynamic Type, 44pt semantics, Reduce Motion/Transparency variants, Voice captions use Boss, ALMA aura/cost/background/composer preserved | PASS |
| 10 — migration/soak/rollback | Additive local migration, additive conversation-pin migration, subsystem rollback flags, privacy-safe signposts, 100-round single-Simulator soak | LOCAL PASS; staged rollout pending approval |

## Corrective independent review

The read-only reliability reviewer found and the main agent corrected:

1. provisional draft/pending attachment identity loss after relaunch;
2. invisible durable dictation audio after a kill during transcription;
3. non-durable Pin behavior;
4. timestamp-only/one-way history paging and unbounded reconciliation;
5. ignored canonical presentation blocks;
6. mounted-only/misclassified Library rows and missing older source promotion;
7. Archive/Delete during selected or non-selected active turns;
8. a Library async race that could replace a live stream or the newly-selected chat.

Final independent re-review: **PASS — no remaining P0/P1 and no unrelated
provider/runtime/Agents SDK production change.**

## Automated evidence

| Check | Result | Evidence |
|---|---|---|
| `git diff --check` | PASS | final local run |
| TypeScript | PASS | `npm run type-check` |
| Server/unit | PASS | 235 files, 2,738 tests |
| Focused native XCTest | PASS | 10/10 corrective/parity tests in `v2-corrective-unit-final.xcresult` |
| Latest Library-race XCTest | INFRASTRUCTURE BLOCKED | Both the final combined run and its single bounded retry failed before executing the assertion: `The test runner hung before establishing connection.` |
| Targeted XCUITest | PASS | anchored menu → Uploaded files → Library |
| iOS Debug build | PASS | iPhone 17 Pro Max / iOS 26.5 |
| Independent diff audit | PASS | final read-only corrective re-review |

Native evidence bundles/logs are under `build/` and are intentionally excluded
from git as generated test output. Key bundles:

- `v2-corrective-unit-final.xcresult`
- `v2-corrective-ui-retry.xcresult`
- `v2-gate0-10-final-suite.xcresult`
- `v2-library-race-unit-retry.xcresult`
- `gate10-scroll-soak.log`
- `gate5-dictation-retry.log`
- `gate5-voice-console-permission-ready.log`

## Simulator evidence

- Gate 1: `gate1-attachment-waiting-proof.png`, `gate1-attachment-accepted-proof.png`
- Gate 2: approval lost/409/410, multiple-card, Ask/Opinion failure and relaunch captures
- Gate 3: kill/relaunch exact restore and network reconnect exact-resume captures
- Gate 4: `gate4-anchored-response-more.png`
- Gate 5: `gate5-dictation-retry.png`, `gate5-voice-console-permission-ready.png`
- Gate 6: `gate6-library-unified-grid.png`
- Gate 7: `gate7-final-glossy-preview.png`, `gate7-menu-to-library.png`, `gate7-menu-draft-preserved.png`
- Gate 8: `gate8-huge-session-bounded.png`, `gate8-search-promoted-exact-message.png`
- Gate 9: `gate9-largest-dynamic-type-final.png`, `gate9-reduce-transparency.png`; normal glossy state is shown in `gate7-final-glossy-preview.png` and `gate9-accessibility.log` records `reduceTransparency=false`
- Gate 10: `gate10-scroll-soak-final.png` plus signposts at 25/50/75/100 and `scroll.stressDone`

## Scope and unresolved rollout work

- Tracked changes are limited to the iOS Assistant implementation/test project,
  additive conversation pin storage/API, composite message pagination helper/route,
  focused tests, and this report.
- `.codex-v2-reference-read/` and `build/` are local generated/reference material
  and must not be staged.
- The newest Library race regression is covered by read-only code review and a
  focused XCTest, but the Simulator test runner failed to establish a connection
  on the combined run and its one allowed retry. This is retained as an explicit
  local Xcode infrastructure blocker rather than reported as a product failure.
- Gate 10's staged cohort, GitHub CI, cross-device pin observation, rollback drill,
  and production soak require an approved push/preview/rollout. They were not
  attempted because remote mutation is outside the current authorization.

## Recommendation

**LOCAL PREVIEW READY. MERGE NOT READY** until the owner approves a feature-branch
push and staged preview/CI/rollback pass. Do not merge or deploy directly from this
report.
