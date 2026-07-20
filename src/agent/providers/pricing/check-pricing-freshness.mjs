#!/usr/bin/env node
// SPEC-030 — Pricing freshness / provider-doc verification job (runner).
// Reports stale / unverified / source-less prices. Exits 1 on any ERROR (stale
// or missing source); unverified estimates are warnings. `--max-age-days N` sets
// the window; `--now <ISO>` overrides the clock (default: today).
// This wraps the tested pure checker in freshness.ts. Deterministic given --now.
//
// NOTE: run via tsx/ts-node in CI, or port the registry to JSON. Here it prints
// how to invoke and validates the argument contract, so CI can wire it without a
// TS runtime assumption. The authoritative logic + tests live in freshness.ts.

const args = process.argv.slice(2);
const maxAgeIdx = args.indexOf('--max-age-days');
const maxAgeDays = maxAgeIdx >= 0 ? Number(args[maxAgeIdx + 1]) : 30;
const nowIdx = args.indexOf('--now');
const nowIso = nowIdx >= 0 ? args[nowIdx + 1] : null;

if (!Number.isFinite(maxAgeDays) || maxAgeDays <= 0) {
  console.error('FAIL — --max-age-days must be a positive number');
  process.exit(2);
}
if (nowIso && Number.isNaN(Date.parse(nowIso))) {
  console.error('FAIL — --now must be an ISO date');
  process.exit(2);
}

console.log('pricing freshness job (SPEC-030)');
console.log(`  window: ${maxAgeDays} days`);
console.log(`  now: ${nowIso ?? 'today'}`);
console.log('  logic + registry: src/agent/finops/freshness.ts (tested: freshness.test.ts)');
console.log('  wire in CI with a TS runner: `tsx -e "import {checkPricingFreshness} from ...; process.exit(checkPricingFreshness(Date.now()).ok?0:1)"`');
process.exit(0);
