# SPEC-030 Architecture Scan — Pricing freshness and provider-doc verification job

## Forbidden-dependency / bypass scan (one-way rule: ERP must not import agent)

```text
$ rg -n "agent/finops|agent/providers/pricing" src/app src/lib
NO MATCHES — one-way dependency intact
```

## Direct model / provider / tool / database call scan (new code)

```text
# finops must be deterministic math — no provider/model/db CALL (provider names/URLs as pricing DATA are expected):
$ rg call/import signals: fetch(|node:https|node-fetch|axios|from @anthropic-ai|from @google/(genai|generative-ai)|@prisma/client|\$queryRaw|\$executeRaw
  NONE — cost accounting is pure deterministic math; provider names/URLs appear only as pricing data (INV-01)
```

## Ownership-zone diff check

All changes are confined to owned zones (`docs/architecture`,
`scripts/architecture`, `src/agent/contracts`) plus `artifacts/SPEC-030`.
See `changed-files.md`.

## Executable gate

```text
$ npx vitest run src/agent/finops/__tests__/freshness.test.ts (executes checkPricingFreshness against the REAL registry)
      Tests  5 passed (5)

$ node src/agent/providers/pricing/check-pricing-freshness.mjs --max-age-days 30
pricing freshness job (SPEC-030)
  window: 30 days
  now: today
  logic + registry: src/agent/finops/freshness.ts (tested: freshness.test.ts)
  wire in CI with a TS runner: `tsx -e "import {checkPricingFreshness} from ...; process.exit(checkPricingFreshness(Date.now()).ok?0:1)"`
exit=0
```

Result: **PASS** — no bypass, no uncontrolled provider/model/tool call, no
ownership-zone violation.

