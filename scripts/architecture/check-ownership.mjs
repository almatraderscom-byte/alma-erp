#!/usr/bin/env node
// SPEC-003 — Ownership-zone gate + CODEOWNERS generator.
//   node scripts/architecture/check-ownership.mjs --emit-codeowners
//     -> prints the CODEOWNERS proposal (stdout)
//   node scripts/architecture/check-ownership.mjs --owner G01 <file...>
//     -> exits 1 if any file is outside the given owner's zones
// Mirrors src/agent/contracts/ownership.ts (kept dependency-free; the .ts
// registry is the tested source of truth).
import { execSync } from 'node:child_process';

const ZONES = [
  { prefix: 'docs/architecture', owner: 'G01', team: '@alma/architecture' },
  { prefix: 'scripts/architecture', owner: 'G01', team: '@alma/architecture' },
  { prefix: 'src/agent/contracts', owner: 'G01', team: '@alma/architecture' },
  { prefix: 'artifacts', owner: 'G01', team: '@alma/architecture' },
  { prefix: 'prisma/schema.prisma', owner: 'integration', team: '@alma/architecture', integrationOnly: true },
  { prefix: 'package-lock.json', owner: 'integration', team: '@alma/architecture', integrationOnly: true },
  { prefix: 'package.json', owner: 'integration', team: '@alma/architecture', integrationOnly: true },
  { prefix: '.github', owner: 'integration', team: '@alma/architecture', integrationOnly: true },
  { prefix: 'src/app/api/assistant', owner: 'agent', team: '@alma/agent' },
  { prefix: 'src/app/agent', owner: 'agent', team: '@alma/agent' },
  { prefix: 'src/agent', owner: 'agent', team: '@alma/agent' },
  { prefix: 'src/app/api/agent', owner: 'frozen-legacy', team: '@alma/agent', integrationOnly: true },
  { prefix: 'src/app', owner: 'erp', team: '@alma/erp' },
  { prefix: 'src/lib', owner: 'erp', team: '@alma/erp' },
];

function resolveOwner(path) {
  const p = path.replace(/^\.\//, '');
  for (const z of ZONES) {
    const isFile = z.prefix.includes('.');
    if (isFile ? p === z.prefix || p.startsWith(z.prefix) : p === z.prefix || p.startsWith(z.prefix + '/')) return z;
  }
  return null;
}

function emitCodeowners() {
  const lines = [
    '# GENERATED — src/agent/contracts/ownership.ts (G01 / SPEC-003). Proposal only.',
    '',
  ];
  for (const z of ZONES) lines.push(`${z.prefix.includes('.') ? '/' + z.prefix : '/' + z.prefix + '/'} ${z.team}`);
  process.stdout.write(lines.join('\n') + '\n');
}

function checkOwner(owner, files) {
  if (files.length === 0) {
    // default: files changed vs the branch base (main)
    try {
      const base = execSync('git merge-base HEAD main', { encoding: 'utf8' }).trim();
      files = execSync(`git diff --name-only ${base} HEAD`, { encoding: 'utf8' }).trim().split('\n').filter(Boolean);
    } catch {
      files = [];
    }
  }
  const violations = [];
  for (const f of files) {
    const z = resolveOwner(f);
    if (!z) violations.push({ file: f, code: 'UNOWNED_PATH' });
    else if (z.integrationOnly && owner !== 'integration') violations.push({ file: f, code: 'INTEGRATION_ONLY', detail: z.prefix });
    else if (z.owner !== owner && !z.integrationOnly) violations.push({ file: f, code: 'OWNERSHIP_CONFLICT', detail: `owned by ${z.owner}` });
  }
  console.log(`ownership check: owner=${owner}, ${files.length} files`);
  if (violations.length === 0) {
    console.log('PASS — every changed file is within the session owner zones');
    process.exit(0);
  }
  console.log(`FAIL — ${violations.length} ownership violation(s):`);
  for (const v of violations) console.log(`  ${v.file}  [${v.code}${v.detail ? ' ' + v.detail : ''}]`);
  process.exit(1);
}

const args = process.argv.slice(2);
if (args.includes('--emit-codeowners')) {
  emitCodeowners();
} else {
  const oi = args.indexOf('--owner');
  const owner = oi >= 0 ? args[oi + 1] : 'G01';
  const files = args.filter((a, i) => !a.startsWith('--') && i !== oi + 1);
  checkOwner(owner, files);
}
