#!/usr/bin/env node
// SPEC-010 — Architecture freeze baseline gate.
// Runs every G01 governance gate and the contracts typecheck + tests, and holds
// the baseline only if all pass. This is the single command CI / the group
// certification runs. Usage: node scripts/architecture/freeze-gate.mjs
import { execSync } from 'node:child_process';

const STEPS = [
  { id: 'contracts-typecheck', cmd: 'npx tsc --noEmit -p src/agent/contracts/tsconfig.json' },
  { id: 'contracts-tests', cmd: 'npx vitest run src/agent/contracts' },
  { id: 'forbidden-imports', cmd: 'node scripts/architecture/check-forbidden-imports.mjs' },
  { id: 'ownership', cmd: 'node scripts/architecture/check-ownership.mjs --owner G01' },
  { id: 'adr-lint', cmd: 'node scripts/architecture/check-adr.mjs' },
  { id: 'proof-complete', cmd: 'node scripts/architecture/check-proof.mjs --require-pass' },
];

function run(cmd) {
  try {
    const out = execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { passed: true, out };
  } catch (e) {
    return { passed: false, out: `${e.stdout ?? ''}${e.stderr ?? ''}` };
  }
}

console.log('=== AIOS Architecture Freeze Baseline Gate (G01 / SPEC-010) ===');
const results = [];
for (const s of STEPS) {
  const r = run(s.cmd);
  results.push({ id: s.id, passed: r.passed });
  const tail = r.out.trim().split('\n').slice(-1)[0] ?? '';
  console.log(`[${r.passed ? 'PASS' : 'FAIL'}] ${s.id.padEnd(20)} ${tail.slice(0, 80)}`);
}
const held = results.every((r) => r.passed);
console.log('---');
console.log(held ? 'FREEZE BASELINE: PASS — architecture is frozen and green' : 'FREEZE BASELINE: FAIL');
process.exit(held ? 0 : 1);
