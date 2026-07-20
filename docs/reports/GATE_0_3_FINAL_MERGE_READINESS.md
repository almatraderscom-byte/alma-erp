# Gate 0–3 Merge Readiness Report

Date: 2026-07-20
Draft PR: https://github.com/almatraderscom-byte/alma-erp/pull/485

## Git snapshot

- Base commit: `4886277ab7de4e3821ffeee2af36082776d1e5f3`
- Worktree: `/Users/marufbillah/alma-erp-ios-uiux-0-3`
- Branch: `agent-phase-ios-uiux-0-3`
- Verified product head: `78da80fc` (`fix(ios-agent): guard active-turn chat navigation`)
- Gate 9 isolation commit: `ad15f104` (`fix(ios-agent): isolate deferred Gate 9 surfaces`)
- No implementation was made on `main`; no merge or direct-main push occurred.
- No unrelated runtime/provider/Agent SDK files were changed by the isolation work.

## Final status

| Area | Result | Evidence |
|---|---|---|
| iOS Debug build | PASS | iPhone 17 Pro Max, iOS 26.5, UDID `94E0186B-5CDA-4708-9368-53B4FF7274E7` |
| TypeScript type-check | PASS | `npm run type-check` |
| Server/unit tests | PASS | `npm test`: 235 files, 2,736 tests |
| Gate source audits | PASS | baseline, Phase 1, corrected Phase 2 isolation, corrected Phase 3 isolation |
| Native XCTest | BLOCKED | Xcode scheme has an empty `Testables` section; project has no XCTest target |
| Native XCUITest | BLOCKED | Project has no UI-test target |
| Simulator P0 journeys | PASS with local fixture evidence | Single Simulator/device reused; no concurrent Simulator runs |
| Composer/loader preservation | PASS | `gate9-isolated-loader-composer-preserved.png`; no composer/loader presentation hunk in the isolation diff |
| Correct Gate 9 menu/Library | DEFERRED | Rejected bottom-sheet implementations removed from this PR |

## Gate 0–3 P0 reliability matrix

| Journey | Implementation | Verification | Result |
|---|---|---|---|
| Send → Stream → Complete | `startPreparedTurn`, generation-owned `runTurn`, `finalizeTurn` | Simulator fixture `send-stream-complete-fixture.png` | PASS |
| Send while active/stuck stream | persisted `QueuedOwnerMessage`, session-scoped drain | `queued-message-retained-final.png`, `preid-followup-queued-final.png` | PASS |
| Approval normal + double-tap | `approveAction`, terminal-status cache, submitting guards | multiple-card and approval fixtures | PASS |
| Lost response / 409 / 410 | truthful terminal reconciliation in `approveAction` | `approval-lost-response-reconciled.png`, `approval-409-reconciled.png`, `approval-410-expired.png` | PASS |
| Multiple cards exactly once | per-action IDs and terminal cache | `multiple-approvals-final.png` | PASS |
| Ask/Opinion failure retains input | persisted draft/retry state | `ask-failure-input-retained.png`, `opinion-failure-input-retained.png` | PASS |
| Kill/relaunch exact restore | persisted `RecoverableTurn`, provisional session identity | `recovery-after-relaunch-exact-turn.png`, `exact-turn-recovery-final.png` | PASS |
| Network reconnect exact resume | durable replay cursor and generation-owned transport handoff | `network-reconnect-exact-turn.png`, `latest-handoff-recovery-final.png` | PASS |
| No indefinite unlabelled loader | bounded status recovery and visible settled failure | `offline-loader-settled.png`, `early-stop-settled-final.png` | PASS |
| Cross-chat queue stranding | user navigation guarded while a recoverable turn owns the VM; relaunch-only bypass | independent GitHub finding resolved in `78da80fc`; build and read-only re-review PASS | PASS |

The merge-readiness P0 captures not listed as tracked PR assets remain preserved
locally under `docs/proofs/ios-uix-merge-readiness/`. They were not bulk-added to
the PR because the full PNG set is approximately 79 MB.

## Independent reviews

- Roadmap compliance reviewer: strict historical Gate 0–3 UI wording was not
  complete. The owner subsequently corrected that scope: conversation menu and
  Library belong to the dedicated Gate 9 UI work.
- Reliability/race reviewer: final working diff PASS after provisional-session,
  transport-generation, finalization-ownership, DuplicateTurn Stop, and
  cross-chat navigation corrections.
- GitHub/Vercel review: confirmed cross-chat queued-send stranding on commit
  `32475bdd`; addressed by `78da80fc` and independently re-reviewed PASS.

## Visual scope correction

The branch had introduced an iPhone detented conversation menu and a detented
Files hub in `ce1e0ec7` and `1faac8e5`. The corrected visual specification
revoked those presentations. Commit `ad15f104` therefore:

- removes the ellipsis trigger and rejected bottom-sheet menu;
- removes the rejected Files hub and all visible entry points;
- restores the original hamburger + single coral plus header;
- restores the pre-existing generated-artifact badge/sheet;
- retains inline uploaded/generated files, attachment retry, durable queues,
  approvals, action persistence, loaders, composer, and recovery state;
- retires the rejected Phase 2 menu/project and Phase 3 Files-hub screenshots
  from the PR.

Correct anchored menu and large Library implementation must be a dedicated Gate
9 change with the five owner-requested Simulator screenshots. It must not be
added back to this Gate 0–3 reliability merge.

## Unresolved issues / infrastructure blockers

1. Native XCTest/XCUITest targets do not exist, so automated native behavioral
   coverage cannot run until test infrastructure is added.
2. GitHub CI and iOS simulator checks for the latest pushed commit must complete.
3. The correct source-anchored menu and Library remain intentionally deferred to Gate 9.

## Recommendation

**NOT READY** for merge at the time of this report because latest GitHub checks
are still pending and native XCTest/XCUITest coverage is unavailable. The
rejected Gate 9 presentation is isolated, current loader/composer preservation
is verified, and the known reliability blockers found by local and GitHub review
have been addressed. Do not merge or deploy without owner approval.
