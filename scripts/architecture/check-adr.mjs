#!/usr/bin/env node
// SPEC-007 — ADR lint gate. Validates every docs/architecture/adr/ADR-*.md
// filename + required sections + status, and checks sequential numbering.
// Usage: node scripts/architecture/check-adr.mjs
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT } from './_shared.mjs';

const ADR_DIR = join(REPO_ROOT, 'docs/architecture/adr');
const FILENAME_RE = /^ADR-(\d{4})-([a-z0-9]+(?:-[a-z0-9]+)*)\.md$/;
const REQUIRED = ['Status', 'Context', 'Decision', 'Consequences'];
const STATUSES = ['Proposed', 'Accepted', 'Superseded', 'Rejected'];

function main() {
  let files;
  try {
    files = readdirSync(ADR_DIR).filter((f) => f.startsWith('ADR-') && f.endsWith('.md')).sort();
  } catch {
    console.log('FAIL — docs/architecture/adr missing');
    process.exit(1);
  }
  const issues = [];
  const ids = [];
  for (const f of files) {
    const m = FILENAME_RE.exec(f);
    if (!m) {
      issues.push(`${f}: bad filename (want ADR-NNNN-kebab-title.md)`);
      continue;
    }
    ids.push(Number(m[1]));
    const body = readFileSync(join(ADR_DIR, f), 'utf8');
    if (!/^#\s+ADR-\d{4}:/m.test(body)) issues.push(`${f}: missing "# ADR-NNNN: <title>" heading`);
    for (const s of REQUIRED) if (!new RegExp(`^##\\s+${s}\\b`, 'm').test(body)) issues.push(`${f}: missing "## ${s}"`);
    const sm = /^##\s+Status\s*\n+([^\n]+)/m.exec(body);
    if (sm && !STATUSES.some((s) => sm[1].trim().startsWith(s))) issues.push(`${f}: bad status "${sm[1].trim()}"`);
  }
  ids.sort((a, b) => a - b);
  for (let i = 0; i < ids.length; i++) if (ids[i] !== i + 1) { issues.push(`non-sequential ADR numbering near ADR-${String(ids[i]).padStart(4, '0')}`); break; }

  console.log(`ADR lint: ${files.length} record(s)`);
  if (issues.length === 0) { console.log('PASS — all ADRs well-formed and sequential'); process.exit(0); }
  console.log('FAIL:'); for (const i of issues) console.log('  ' + i); process.exit(1);
}
main();
