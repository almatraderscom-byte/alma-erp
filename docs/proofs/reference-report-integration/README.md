# Reference pipeline ⋈ professional report — integration evidence

Branch `codex/final-reference-report-integration` merges two parallel snapshots:

| Source | Commit | What it carries |
|---|---|---|
| `codex/professional-agent-reports` | `3d79c805` | professional/management report in the first final reply, deterministic verifier rewrite, iOS streaming raw-HTML/artifact suppression |
| `codex/deepaudit` | `395798f3` | provider-neutral `AgentReferenceV1` verified deep-link / reference pipeline |

`395798f3` was branched from `8c3ef25f` (2026-08-19); main had moved 266 commits, so the
cherry-pick conflicted in 29 files. Every conflict was resolved by hand to keep **both**
sides — no wholesale `ours`/`theirs`.

## Both feature sets are provably intact

```
git diff 395798f3 -- src/agent/lib/references/
  → only the coverage-count lines (89 → 90)

git diff 3d79c805 -- src/agent/lib/claim-verifier.ts src/agent/lib/style-gate.ts \
                     src/app/agent/report-preview/ \
                     src/app/api/assistant/internal/generate-report/ \
                     src/lib/auth-paths.ts src/proxy.ts src/agent/config.ts
  → empty
```

## Integration gates that had to move

The professional-report branch adds one page the reference coverage manifest had never
seen, and the snapshot re-added console routes main already had:

- `/agent/report-preview` classified `none` — a preview-only rendering fixture carrying no
  live ERP data is never a mintable business destination. Coverage gate 89 → 90.
- 21 duplicate IOSP-7 console entries dropped from `ios/route-contract.json` (main's
  IOSP-9 wording kept); `/agent/report-preview` registered `temporary-web` with its
  matching `AlmaNavCoordinator.temporaryWebRoutes` entry.
- `ios/access-contract.json` regenerated.

## Automated gates

| Gate | Result |
|---|---|
| `tsc --noEmit` | PASS — 0 errors |
| `vitest run` (full) | PASS — 813 files / 7926 tests, 1 file + 2 tests skipped |
| `scripts/iosp0-route-contract-check.mjs` | PASS — `94 fixture routes cover 90 web routes` |
| reference coverage gate | PASS — zero unclassified active tools, zero unclassified operational routes |
| access contract (web ⇄ iOS) | PASS |
| iOS simulator build (iPhone 17 Pro, Debug) | BUILD SUCCEEDED |
| iOS `AppParityV2Tests` | PASS — 220 tests, 0 failures |

> Run the suite on an **idle** Mac. A concurrent `xcodebuild` pushed load to 56 and
> produced 21–52 failures that were *every one* `Test timed out`, zero assertions.

## Codex review rounds (all findings fixed on this branch)

| Round | Sev | Finding | Fix |
|---|---|---|---|
| 1 | P1 | shadow mode turned every legacy Markdown link inert | `7564ed90` |
| 1 | P1 | trusted tool screenshots became alt text | `7564ed90` |
| 2 | P1 | hidden replay/tail terminal read as a LIVE contract | `2deafeb1` |
| 2 | P1 | ON + zero citations left model-authored links clickable | `2deafeb1` |
| 3 | P2 | early terminals (answer gate, route guard, browser salvage) stated nothing | `1ec96612` |

All five share one root cause: an empty `references` array cannot say *why* it is
empty. The messages API and every stream terminal now carry `referencesActive`,
and neither client infers the contract state from the array's shape.
`references/__tests__/stream-contract.test.ts` fails if any emit site drops it.

## Deployed proof — professional report renderer

`/agent/report-preview` on the branch preview renders the full editorial hierarchy:
`<h1>`, section rules, KPI `<table>` with `scope="col"` headers, `role="note"` callout,
ordered list and task list. (`shots/web-report-preview-*.png`)

## Live simulator proof — 2026-08-24 02:36 Dhaka

iPhone 17 Pro (`5F79315F-8B85-45C9-87B3-908297482113`), app built from this branch and
pinned to the branch preview with `AGENT_REFERENCES_ROLLOUT=on` (Preview scope only).
One message into a **new, empty** conversation, no follow-up:

```
FINAL-LIVE-PROOF-20260824-0236 - Create a professional inventory health management
report using live ERP data. Include bottom line, executive summary, KPI table,
findings, risks, recommendations and next steps.
```

Head: **DS V4** via Auto routing · 8 rounds · $0.0331 · tracker 4 of 4 settled.
The delivered reply is `live-reply-20260824-0236.md`.

| Criterion | Result | Evidence |
|---|---|---|
| Real ERP tools | **PASS** | `Find Tool` → stock status + reorder suggestions; 311 SKU, stock value ৳3,98,05,652, low/out/dead = 0 |
| No raw HTML flash or residue | **PASS** | zero HTML tags in the persisted reply; none seen mid-stream |
| Verified links in the reply | **PASS** | `[plan 20921458-…](/agent/references/plan/…?business_id=ALMA_LIFESTYLE)` and `[Dashboard](/)`, both server-minted |
| Link opens the exact entity | **PASS** | `shots/03-reference-exact-focus.png` — native Reference screen: namespace PLAN, exact id, ALMA_LIFESTYLE, `status: draft`, honest "তালিকা/সেকশনে ফিরে যান" fallback |
| Tap causes no mutation | **PASS** | Approvals badge `1` before and after the tap; nothing written |
| not-found / deleted honesty | **PASS** | `shots/04-reference-not-found-honest.png` — "রেকর্ড পাওয়া যায়নি — ID বা source record আর বর্তমান store-এ নেই" |
| Reload preserves references | **PASS** | full app kill + cold relaunch; both links still rendered and clickable from the durable projection |
| **Complete report in the first turn** | **FAIL** | the reply is progress prose ending "Boss, \"continue\" বললে ঠিক এখান থেকে কাজ চালিয়ে যাব" — no bottom line, executive summary or KPI table |

### The FAIL is a pre-existing model-compliance gap, not a merge regression

The shipped verifier agrees the delivered text is non-compliant — running
`detectProfessionalReportStyleViolations` over `live-reply-20260824-0236.md` with the
same owner instructions returns `professional_report_structure` (0 Markdown headings).
That detector, `style-gate.ts`, and the report contract lines in `system-prompt.ts` are
identical to `codex/professional-agent-reports@3d79c805`, so the contract reached the
model unchanged. The rewrite loop did fire (the reply carries the
"নিজে যাচাই করে ঠিক করেছে" badge) but did not converge into a report on DS V4.

The professional-report handoff itself recorded prompt-lint 9/9 and server assertions
only — this is its first live model proof, and it is where it fails.

### Rig notes

- The preview alias sits behind Vercel SSO. The build used a temporary, never-committed
  patch: `.production` host → the alias, plus a `_vercel_jwt` bypass cookie seeded into
  both cookie jars from `UserDefaults alma.e2e.vercelJwt`. The working tree was reverted
  immediately after the build (`git status` clean).
- That bypass covers the native `AlmaAPI` path but not the Capacitor WebView's boot load,
  so a cold launch briefly hands `vercel.com/sso-api` to Safari. Native screens are
  unaffected; it is a rig artefact, not product behaviour.
