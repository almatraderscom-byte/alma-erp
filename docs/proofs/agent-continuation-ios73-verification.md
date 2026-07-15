# Agent Continuation Reliability — Server Integration + iOS Build-73 Verification

Date: 2026-07-15 · Session: alma-erp-reliability (takeover)
Status: **server side VERIFIED & MERGED · iOS branch BUILT for simulator · live simulator proof scenario PAUSED by owner** (another session was using the simulator; owner will say when to install the latest commit and run the scenario).

---

## 1. Branches and commits

| Branch | State | Key commits |
|---|---|---|
| `claude/agent-continuation-server-integration` | pushed · PR **#376 MERGED** to main (merge `4e9ea68d`) | `e96053c4` enforce owner instruction contract (from codex `46a62c3c`) · `8ad92b0b` truthful/ordered browser evidence (from `d68aa793`) · `c5d06727` stop after mandatory tool failure (from `10f7af31`) · `ed70a553` merge-correction: keep tool-round prose + contract replacements in stream & timeline |
| `claude/ios-build-73` | pushed · **NOT merged, NO TestFlight** | `152298fe` fix(ios): use structured auto-continuation turns (from codex `3c493a64`) · `c3f0cf4d` merge of latest origin/main (post PR #375 + #376) |
| `main` | `4e9ea68d` (includes this server work + PR #375) | — |

Cherry-pick conflict resolution: union of main's `askCardId` (AGENT-IOS-001) and codex's `internalControl` / `autoContinueFromTurnId` — no main behavior discarded, never used `reset --hard` / `checkout --`.

## 2. Server invariants — audited, each with a covering test

| Invariant | Where enforced | Test |
|---|---|---|
| Casual/personal message creates no staff tasks/approvals/browser jobs/workflow work | `deriveOwnerTurnRequirements` + mutation gate on `ensureClientSeoBatchWorkflow`; muhasaba can no longer claim business turns | `owner-turn-requirements.test.ts` (ordinary question → all-false), `salah-muhasaba-intent.test.ts` |
| One owner message → at most one owner turn | `claimTurnForRequest` (clientRequestId) | `turn-status.test.ts` "direct and worker paths share one logical request execution" |
| Continuation is server control state, never an owner/user message | `shouldPersistIncomingMessage` (`autoContinueFromTurnId`, `internalControl`); `runContinuationInline` no longer inserts an `agentMessage` row; chat route wraps control notes in `[INTERNAL WORKFLOW CONTINUATION …]` system instructions | `continuation-policy.test.ts` (both flags refuse persistence; **regular messages still persist**) |
| Repeated continuation attempts → exactly one successor turn | `claimContinuationTurn` (atomic claim; replay returns the SAME turnId, `claimed:false`) | `turn-status.test.ts` "consumes a persisted continuation eligibility exactly once" |
| No auto-continuation inferred from normal prose | `shouldAutoContinueTurn` takes only deadline/askCard/tool records — prose is not an input | `continuation-policy.test.ts` (terminal gate, failed-probe, deadline cases) |
| Browser evidence never claims extension/browser OFF without truthful proof | `live_browser_look` semantic result + `client-seo-browser-evidence.ts` (observed URL over requested URL) | `live-browser-look.test.ts` (error text mandates "extension OFF বলা নিষেধ", exactly one read attempt), `client-seo-browser-evidence.test.ts` |
| Failed mandatory tool stops the turn (no silent restart, no extra model round) | `contract-tool-failure.ts` + terminal break in `run-owner-turn.ts`; queued same-round calls are skipped with an honest error | `contract-tool-failure.test.ts` |

Merge-correction (`ed70a553`) — semantic conflict found during audit: the codex change buffered round text and thereby (a) dropped tool-round narration from the live stream and the persisted ChronoFlow timeline, (b) left a contract-replaced draft looking authoritative on reload. Fixed on top of the contract: tool-round prose streams immediately and persists; a contract replacement marks the draft `superseded` (same presentation as verify retries) and records the replacement; the terminal failure note is persisted in the timeline. This preserves iOS presentation-parity invariants (chronological text↔tool order, reload keeps prose, no blank/flicker on verification retry) with zero UI redesign.

## 3. Command results (exact)

On `claude/agent-continuation-server-integration` (pre-merge):

```
npm run test:agent   → Test Files 95 passed (95) · Tests 890 passed (890)   [main baseline: 94 files / 870 tests]
npm run type-check   → clean (tsc --noEmit, no output)
npm run build        → succeeds (full Next.js production build, route manifest emitted)
```

PR #376 checks before merge: `gate` pass · `build-simulator` pass · Vercel deployment pass · `MERGEABLE CLEAN`. Fresh `origin/main` check showed zero file overlap with interim PR #375.

On `claude/ios-build-73` (after merging latest main):

```
npm run test:agent   → Tests 890 passed (890)
xcodebuild -workspace App.xcworkspace -scheme App \
  -destination 'platform=iOS Simulator,name=iPhone 17 Pro Max' \
  -derivedDataPath /tmp/alma-sim-dd-73 build
                     → ** BUILD SUCCEEDED **  (see §5 for the re-build of the merged HEAD)
```

CocoaPods: worktree had no `Pods/` (gitignored). Fixed with plain `pod install` only (LANG=en_US.UTF-8; `npm install` first restored `@capacitor/*` per the existing package-lock). **`Podfile.lock`, `package.json`, `package-lock.json` all unchanged** — `pod update` never ran. `npx cap copy ios` regenerated the gitignored `ios/App/App/public` bootstrap (verified byte-identical to `mobile/www`).

## 4. iOS behavior on `claude/ios-build-73` (code-verified)

- `ChatBody` carries `autoContinueFromTurnId` (alongside main's `askCardId`).
- No local user bubble for a structured auto-continuation (`structuredAutoContinue` skips `messages.append(userMsg)`).
- `done.needContinue` captures the durable predecessor from `currentTurnId`; missing predecessor → `turn.autoContinueSkipped` log, **no continuation**, never a plain "continue" message.
- `fireAutoContinueIfNeeded` re-guards the predecessor and consumes it once.
- 15-second first-event watchdog: when `autoContinueFromTurnId != nil` the worker fallback is **refused** (re-throws) because `/api/assistant/turn` requires a user message and would mint a second owner-authored job.
- Presentation parity from main preserved: only `AssistantSwiftUI.swift` changed (+54/−12 vs main at cherry-pick); latest main (incl. PR #375 iOS work) merged in cleanly.

## 5. Simulator evidence so far (before owner paused sim use)

Device: iPhone 17 Pro Max simulator, iOS 26.5, udid `94E0186B-5CDA-4708-9368-53B4FF7274E7`.

- Build 1 of branch HEAD `152298fe`: `** BUILD SUCCEEDED **`, installed, launched (pid 12061).
- App unlock gate renders correctly → [agent-continuation-ios73-launch-gate.png](./agent-continuation-ios73-launch-gate.png)
- Unlocked to live Dashboard (session intact, data renders) → [agent-continuation-ios73-dashboard.png](./agent-continuation-ios73-dashboard.png)
- `almaerp://agent` deep link accepted.
- Owner then paused simulator use (another session active). Merged HEAD `c3f0cf4d` was **re-built** (build only, deliberately NOT installed): `** BUILD SUCCEEDED **` (exit 0, log `/tmp/alma-73-build2.log`).

## 6. Remaining (owner-gated) — the live proof scenario

To run when the owner gives the go (install **latest** `claude/ios-build-73` commit first):

1. `xcodebuild … build` + `simctl install/launch` of the current branch HEAD.
2. Start a long/continuable turn (live-browser task; Companion "My Mac Chrome" was online — lastSeenAt age 0.3s at check time).
3. PASS/FAIL: no visible owner "continue" bubble after `done.needContinue`.
4. PASS/FAIL: signpost log `turn.submit auto-continuation:<turnId>` (subsystem `com.almatraders.erp.agent`) proves `autoContinueFromTurnId` was used.
5. PASS/FAIL: duplicate continuation attempt → exactly one successor turn (read-only SQL on `agent turns/messages` for the conversation; no owner-authored 'continue' row).
6. PASS/FAIL: kill + relaunch app → prose/tool timeline still chronological, no lost prose, no blank verification retry.

**No TestFlight archive/upload/App Store submission was performed, and none will be until the owner asks.**
