# SPEC-151 Baseline — Vendor-neutral model tier contract

## Repository discovery (exact commands)

```text
$ ls src/agent/models src/agent/providers/runtime
ls: cannot access 'src/agent/models': No such file or directory
ls: cannot access 'src/agent/providers/runtime': No such file or directory
  → GREENFIELD in both owned zones.

$ rg -l "ModelTier" src/agent/models
  → NONE (no prior vendor-neutral tier contract).

$ rg -n "@/agent/models|agent/providers/runtime" src
  → NONE (no callers/downstream dependencies yet).

$ ls src/agent/lib/models    # legacy analog — MUST NOT TOUCH
  registry.ts tier-router.ts head-router.ts opus-gate.ts specialist-roles.ts adapters/ ...
```

- **Current implementation & aliases:** none in owned zones. Legacy analog is
  `src/agent/lib/models` (tier-router/head-router/opus-gate) — frozen, not edited.
- **Callers / downstream:** none (greenfield). New head/worker callers land in G17+.
- **Direct provider/model/tool/db calls:** none in owned zones (verified: no
  `fetch`/`axios`/`http`/`net`/`dns`).
- **Current tests:** none for this contract; baseline agent suite = 182 passing.
- **Cost / latency evidence:** n/a — deterministic, zero model calls.
- **Tenant/permission/audit propagation:** inherited from `@/agent/contracts`
  (`ExecutionIdentity`, `ComponentResult`, `REASON_CODES`).
- **Likely bypass paths:** a caller importing a provider SDK directly instead of
  the fabric. Mitigated: fabric is the only public entry; adapters are an
  interface; the only shipped adapter is the deterministic FAKE.
- **Proposed migration boundary:** additive, off by default. Legacy
  `src/agent/lib/models` remains authoritative; fabric wiring is a G17 seam.
- **Files expected to change:** `src/agent/models/*`, `src/agent/providers/runtime/*`,
  `artifacts/SPEC-151/*` only.
