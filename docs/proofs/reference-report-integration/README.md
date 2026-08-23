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

## Deployed proof — professional report renderer

`/agent/report-preview` on the branch preview renders the full editorial hierarchy:
`<h1>`, section rules, KPI `<table>` with `scope="col"` headers, `role="note"` callout,
ordered list and task list. (`shots/web-report-preview-*.png`)

## Live simulator proof

See `shots/` and the notes below.
