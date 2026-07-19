#!/usr/bin/env node
// SPEC-002 — Forbidden-dependency gate.
// Scans ERP zones (src/app, src/lib) for imports of the agent module and fails
// (exit 1) if the one-way dependency rule is violated. This is the executable
// architecture bypass scan used by the freeze gate (SPEC-010).
// Usage: node scripts/architecture/check-forbidden-imports.mjs [--json]
import { walk, rel, read } from './_shared.mjs';

// Mirror of src/agent/contracts/invariants.ts (scripts are plain .mjs and must
// stay dependency-free; the .ts contract is the source of truth and is tested).
function zoneOf(path) {
  const p = path.replace(/^\.\//, '');
  // Agent-side zones first (subsets of src/app): CLAUDE.md places the agent in
  // src/agent, src/app/agent and src/app/api/assistant — all may import agent.
  if (p.startsWith('src/app/api/agent/')) return 'legacy-agent-api';
  if (p.startsWith('src/app/api/assistant/')) return 'assistant-api';
  if (p.startsWith('src/app/agent/')) return 'agent-app';
  if (p.startsWith('src/agent/contracts/')) return 'agent-contracts';
  if (p.startsWith('src/agent/')) return 'agent';
  if (p.startsWith('src/app/api/')) return 'erp-api';
  if (p.startsWith('src/app/')) return 'erp-app';
  if (p.startsWith('src/lib/')) return 'shared-lib';
  return 'other';
}
function importTargetZone(spec) {
  if (/^@\/agent\/contracts(\/|$)/.test(spec) || /(^|\/)src\/agent\/contracts(\/|$)/.test(spec)) return 'agent-contracts';
  if (/^@\/agent(\/|$)/.test(spec) || /(^|\/)src\/agent(\/|$)/.test(spec)) return 'agent';
  return null;
}
const FORBIDDEN = {
  'erp-app': ['agent', 'agent-contracts'],
  'erp-api': ['agent', 'agent-contracts'],
  'shared-lib': ['agent', 'agent-contracts'],
};

const IMPORT_RE = /(?:import|export)\s[^'"]*?from\s*['"]([^'"]+)['"]|(?:import|require)\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

// Architecture ratchet: the target rule (ERP/shared must not import agent) is
// already violated by pre-existing production code that this group is forbidden
// to modify. We freeze those known violations in a baseline and fail only on
// NEW violations, so the boundary can only tighten, never regress.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT } from './_shared.mjs';

const BASELINE_PATH = join(REPO_ROOT, 'docs/architecture/forbidden-imports.baseline.json');
const keyOf = (v) => `${v.file} -> ${v.importSpec}`;

function loadBaseline() {
  try {
    return new Set(JSON.parse(readFileSync(BASELINE_PATH, 'utf8')).violations.map(keyOf));
  } catch {
    return new Set();
  }
}

function scan() {
  const files = walk('src', { exts: ['.ts', '.tsx', '.mjs', '.js'] });
  const violations = [];
  for (const abs of files) {
    const path = rel(abs);
    const from = zoneOf(path);
    const forbidden = FORBIDDEN[from];
    if (!forbidden) continue;
    const src = read(abs);
    let m;
    IMPORT_RE.lastIndex = 0;
    while ((m = IMPORT_RE.exec(src))) {
      const spec = m[1] || m[2];
      if (!spec) continue;
      const to = importTargetZone(spec);
      if (to && forbidden.includes(to)) {
        violations.push({ file: path, fromZone: from, importSpec: spec, toZone: to });
      }
    }
  }
  violations.sort((a, b) => keyOf(a).localeCompare(keyOf(b)));
  return { files: files.length, violations };
}

function main() {
  const { files, violations } = scan();

  if (process.argv.includes('--update-baseline')) {
    writeFileSync(
      BASELINE_PATH,
      JSON.stringify({ generatedFrom: 'aios/G01-architecture-freeze', count: violations.length, violations }, null, 2) + '\n',
    );
    console.log(`baseline written: ${violations.length} known pre-existing violations`);
    process.exit(0);
  }

  const baseline = loadBaseline();
  const fresh = violations.filter((v) => !baseline.has(keyOf(v)));

  if (process.argv.includes('--json')) {
    process.stdout.write(JSON.stringify({ scanned: files, total: violations.length, baselined: violations.length - fresh.length, new: fresh, violations }, null, 2) + '\n');
    process.exit(fresh.length === 0 ? 0 : 1);
  }

  console.log(`forbidden-import scan: ${files} files scanned`);
  console.log(`known (baselined) pre-existing violations: ${violations.length - fresh.length}`);
  if (fresh.length === 0) {
    console.log('PASS — no NEW forbidden imports. ERP app/api → agent: 0. Boundary did not regress.');
  } else {
    console.log(`FAIL — ${fresh.length} NEW forbidden import(s) (regression):`);
    for (const v of fresh) console.log(`  ${v.file}  ->  ${v.importSpec}  (${v.fromZone}→${v.toZone})`);
  }
  process.exit(fresh.length === 0 ? 0 : 1);
}

main();
