#!/usr/bin/env node
// SPEC-009 — Proof-completeness gate. Verifies every artifacts/SPEC-XXX/ dir has
// the ten required artifacts and a well-formed verdict. Optionally require all
// PASS. Usage:
//   node scripts/architecture/check-proof.mjs [--require-pass] [--json]
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT } from './_shared.mjs';

const REQUIRED = [
  'baseline.md', 'contract.md', 'changed-files.md', 'test-results.md',
  'architecture-scan.md', 'cost-before-after.md', 'security-proof.md',
  'rollback-proof.md', 'unresolved-risks.md', 'final-verdict.md',
];
const ART = join(REPO_ROOT, 'artifacts');

function verdictOf(body) {
  const m = /\bVerdict:\s*\**\s*(PASS|PARTIAL|FAIL)\b/i.exec(body);
  return m ? m[1].toUpperCase() : null;
}

function main() {
  const requirePass = process.argv.includes('--require-pass');
  let dirs = [];
  try {
    dirs = readdirSync(ART).filter((d) => /^SPEC-\d{3}$/.test(d)).sort();
  } catch {}
  const report = [];
  let ok = true;
  for (const d of dirs) {
    const dir = join(ART, d);
    const present = readdirSync(dir).filter((f) => f.endsWith('.md'));
    const missing = REQUIRED.filter((r) => !present.includes(r));
    const fv = join(dir, 'final-verdict.md');
    const verdict = existsSync(fv) ? verdictOf(readFileSync(fv, 'utf8')) : null;
    const specOk = missing.length === 0 && verdict !== null && (!requirePass || verdict === 'PASS');
    if (!specOk) ok = false;
    report.push({ spec: d, missing, verdict, ok: specOk });
  }

  if (process.argv.includes('--json')) {
    process.stdout.write(JSON.stringify({ specs: report.length, ok, report }, null, 2) + '\n');
    process.exit(ok ? 0 : 1);
  }
  console.log(`proof check: ${report.length} spec dir(s)${requirePass ? ' (require PASS)' : ''}`);
  for (const r of report) {
    const flag = r.ok ? 'OK' : 'BAD';
    console.log(`  [${flag}] ${r.spec}  verdict=${r.verdict ?? 'NONE'}${r.missing.length ? '  missing=' + r.missing.join(',') : ''}`);
  }
  console.log(ok ? 'PASS — all proof directories complete and verdicts valid' : 'FAIL — incomplete proof or non-PASS verdict');
  process.exit(ok ? 0 : 1);
}
main();
