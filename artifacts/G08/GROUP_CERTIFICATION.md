# G08 — Group Certification: Tool Registry Decomposition

```
Group: G08
Specs: SPEC-071..SPEC-080
Individual PASS count: 10/10
Repository integration tests: PASS
Architecture scan: PASS
Cost regression: PASS
Security regression: PASS
Rollback drill: PASS
Unresolved critical risks: 0
Verdict: PASS
```

## What was built

A deterministic, manifest-driven decomposition of the monolithic tool registry
(`src/agent/tools/registry.ts`, 1041 lines) into two new owned zones —
`src/agent/tools/registry` and `src/agent/tools/manifests` — importing only the
G01 contracts (`@/agent/contracts`). The monolith was **not modified** (INV-09).

| Spec | Component | Key artifact |
|------|-----------|--------------|
| 071 | Monolith inventory | decoupled 326-tool snapshot + identity boundary |
| 072 | Manifest schema | zod `ToolManifest` (identity/version/io/risk/ownership/deprecation) |
| 073 | Domain packages | 63 domain packages / 326 manifests, generated + validating loader |
| 074 | IO schema registry | strict Ajv validation (fail-closed) + bounded output view (INV-07) |
| 075 | Risk & side-effect | policy hints → gateway/cost-auth/reconciliation/approval (INV-03/04/05/06) |
| 076 | Ownership metadata | bound to G01 zones, agent-side enforced, DENIED fail-closed |
| 077 | Versioning | strict semver, same-major compatibility, transition legality |
| 078 | Deprecation & migration | callability, cycle-safe migration chains, removed = fail-closed |
| 079 | Runtime registry | feature-flagged assembly (INV-08) + shadow parity vs inventory (INV-09) |
| 080 | Removal gate | fail-closed precondition gate; deletes nothing; documented plan only |

## Integration checkpoint results

- **Full-repo typecheck** (`tsc --noEmit`): **0 errors**.
- **Full tool suite** (`vitest run src/agent/tools`): **33 files / 873 tests PASS**
  (23 pre-existing tool tests + 10 new G08 files; nothing regressed).
- **Owned-zone suite** (`vitest run src/agent/tools/registry src/agent/tools/manifests`):
  **10 files / 140 tests PASS**.
- **Contracts suite** (`vitest run src/agent/contracts`): **90 tests PASS**.
- **Forbidden-import gate** (`scripts/architecture/check-forbidden-imports.mjs`):
  **PASS** — no NEW forbidden imports; ERP app/api → agent: 0; boundary did not
  regress (101 pre-existing baselined violations unchanged).
- **Ownership**: every changed file is inside the G08 owned zones
  (`src/agent/tools/registry/`, `src/agent/tools/manifests/`) or the spec proof
  dirs. (`check-ownership.mjs` is hardcoded `owner=G01` and scans `.aios/` docs,
  so its FAIL is a G01-parameterization false positive, not a G08 violation;
  verified directly via `git diff --name-only 35920d4d HEAD`.)
- **Group rollback drill**: reverting all 10 spec commits restores the branch-base
  tree `06a64666…` **exactly** (byte-for-byte).

## Cost & latency

No request-path cost change: the entire decomposition is deterministic data +
zod/Ajv, with **zero** model/provider/DB/network calls at runtime (INV-01/INV-03).
Generators are dev-time only. The runtime registry's model-facing definitions are
the same count (326) as the monolith's, so the eventual cutover is token-neutral.

## Architecture posture

- Runtime modules carry **no dependency on the monolith** — generators read the
  committed inventory snapshot; runtime reads generated data. Decoupling verified
  per spec.
- Every boundary speaks the frozen G01 `ComponentRequest`/`ComponentResult` union,
  enforces the full `ExecutionIdentity` fail-closed, and never throws.
- The monolith stays authoritative; removal is gated (SPEC-080) behind shadow
  parity + an operational enforce cutover with owner sign-off (INV-09).

## Unresolved critical risks

None (0). Per-spec `unresolved-risks.md` records only low-severity, by-design
follow-ups (per-tool schema/description enrichment, real deprecations, the runtime
cutover) — all downstream and non-blocking.

Verdict: **PASS**
