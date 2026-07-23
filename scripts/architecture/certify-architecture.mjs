#!/usr/bin/env node
// SPEC-200 — Final architecture certification (runner).
// Executes the real gates, feeds their machine-readable results through the
// SPEC-200 certification rules, and writes artifacts/SPEC-200/certification.json.
// Certification is derived ONLY from executable proof (constitution rule 10):
// any gate FAIL, incomplete spec set, non-PASS verdict or unsatisfied checklist
// item ⇒ NOT CERTIFIED (exit 1). Mirrors src/agent/release/certification.ts
// (the tested source of the rules; kept dependency-free here).
// Usage: node scripts/architecture/certify-architecture.mjs [--json]
import { execSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

const ROOT = process.cwd();
const EXPECTED_SPEC_COUNT = 200;

const GATE_STEPS = [
  { id: 'contracts-typecheck', cmd: 'npx tsc --noEmit -p src/agent/contracts/tsconfig.json' },
  { id: 'contracts-tests', cmd: 'npx vitest run src/agent/contracts' },
  { id: 'forbidden-imports', cmd: 'node scripts/architecture/check-forbidden-imports.mjs' },
  { id: 'ownership', cmd: 'node scripts/architecture/check-ownership.mjs --owner G01' },
  { id: 'adr-lint', cmd: 'node scripts/architecture/check-adr.mjs' },
  { id: 'proof-complete', cmd: 'node scripts/architecture/check-proof.mjs --require-pass' },
  // Bypass gates — the executable "no bypass" exit criteria (P0-1/P0-3/P0-4).
  { id: 'admission-bypass', cmd: 'node src/agent/control-plane/admission/check-admission-bypass.mjs' },
  { id: 'gateway-bypass', cmd: 'node src/agent/tool-gateway/check-gateway-bypass.mjs' },
  { id: 'authorization-bypass', cmd: 'node src/agent/policy/check-authorization-bypass.mjs' },
];

/** Required steps mirrored from certification.ts REQUIRED_GATE_STEPS. */
const REQUIRED = ['contracts-typecheck', 'contracts-tests', 'forbidden-imports', 'ownership', 'adr-lint', 'proof-complete'];

function run(cmd) {
  try {
    execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return 'PASS';
  } catch {
    return 'FAIL';
  }
}

function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
}

console.log(`=== AIOS Final Architecture Certification (G20 / SPEC-200) ===`);

// 1) Execute every gate step.
const gateSteps = [];
for (const s of GATE_STEPS) {
  const verdict = run(s.cmd);
  gateSteps.push({ id: s.id, verdict });
  console.log(`[${verdict}] ${s.id}`);
}

// 2) Spec proof report (machine-readable).
let specProofs = [];
try {
  const raw = execSync('node scripts/architecture/check-proof.mjs --json', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  specProofs = JSON.parse(raw).report.map((r) => ({ spec: r.spec, verdict: r.verdict ?? null, missing: r.missing }));
} catch (e) {
  // --json exits 1 when any spec is BAD but still prints the report.
  try {
    specProofs = JSON.parse(`${e.stdout ?? ''}`).report.map((r) => ({ spec: r.spec, verdict: r.verdict ?? null, missing: r.missing }));
  } catch {
    specProofs = [];
  }
}

// 3) Checklist — ONLY machine-verified items. Unverifiable audit checklist rows
//    (e.g. runtime trace coverage) are deliberately absent until they have an
//    executable gate; certification then asserts exactly what was proven.
const checklist = [
  { id: 'freeze-gate', description: 'Architecture Freeze Gate passes from a clean checkout', satisfied: REQUIRED.every((id) => gateSteps.find((g) => g.id === id)?.verdict === 'PASS'), evidenceRef: 'gate:freeze-baseline' },
  { id: 'spec-evidence-readable', description: 'SPEC-001..SPEC-200 evidence is machine-readable with PASS verdicts', satisfied: specProofs.length === EXPECTED_SPEC_COUNT && specProofs.every((s) => s.verdict === 'PASS' && s.missing.length === 0), evidenceRef: 'check-proof --json' },
  { id: 'no-admission-bypass', description: 'No code bypasses the admission gateway', satisfied: gateSteps.find((g) => g.id === 'admission-bypass')?.verdict === 'PASS', evidenceRef: 'gate:admission-bypass' },
  { id: 'no-gateway-bypass', description: 'No external side-effect bypasses the tool-gateway adapter seam', satisfied: gateSteps.find((g) => g.id === 'gateway-bypass')?.verdict === 'PASS', evidenceRef: 'gate:gateway-bypass' },
  { id: 'no-authorization-bypass', description: 'No code bypasses the policy engine', satisfied: gateSteps.find((g) => g.id === 'authorization-bypass')?.verdict === 'PASS', evidenceRef: 'gate:authorization-bypass' },
];

const auditedCommit = execSync('git rev-parse HEAD', { encoding: 'utf8' }).trim();

// 4) Verdict — mirror of certifyArchitecture() (certification.ts).
const reasons = new Set();
for (const id of REQUIRED) {
  const v = gateSteps.find((g) => g.id === id)?.verdict;
  if (v === undefined) reasons.add('GATE_STEP_MISSING');
  else if (v !== 'PASS') reasons.add('GATE_STEP_FAILED');
}
const bySpec = new Map(specProofs.map((s) => [s.spec, s]));
for (let n = 1; n <= EXPECTED_SPEC_COUNT; n++) {
  const p = bySpec.get(`SPEC-${String(n).padStart(3, '0')}`);
  if (!p) { reasons.add('SPEC_SET_INCOMPLETE'); continue; }
  if (p.missing.length > 0) reasons.add('SPEC_PROOF_MISSING');
  if (p.verdict !== 'PASS') reasons.add('SPEC_VERDICT_NOT_PASS');
}
for (const item of checklist) {
  if (!item.satisfied) reasons.add('CHECKLIST_UNSATISFIED');
}

const payload = { expectedSpecCount: EXPECTED_SPEC_COUNT, auditedCommit, gateSteps, specProofs, checklist };
const certified = reasons.size === 0;
const certification = {
  certified,
  auditedCommit,
  specCount: EXPECTED_SPEC_COUNT,
  reasonCodes: [...reasons].sort(),
  checklist: checklist.map(({ id, satisfied }) => ({ id, satisfied })),
  digest: createHash('sha256').update(canonical(payload)).digest('hex'),
  contract: 'certification@1.0.0',
};

writeFileSync(join(ROOT, 'artifacts/SPEC-200/certification.json'), JSON.stringify(certification, null, 2) + '\n');

if (process.argv.includes('--json')) {
  process.stdout.write(JSON.stringify(certification, null, 2) + '\n');
} else {
  console.log('---');
  console.log(certified
    ? `CERTIFIED — ${EXPECTED_SPEC_COUNT} specs, all gates PASS (digest ${certification.digest.slice(0, 12)}…)`
    : `NOT CERTIFIED — ${[...reasons].sort().join(', ')}`);
}
process.exit(certified ? 0 : 1);
