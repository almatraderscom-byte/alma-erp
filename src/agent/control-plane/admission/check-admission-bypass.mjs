#!/usr/bin/env node
// SPEC-020 — Admission bypass CI gate (runner).
// Walks src/** and fails (exit 1) if any file outside the admission package
// imports an internal admission stage module directly, bypassing the gateway.
// Mirrors bypass-gate.ts (kept dependency-free; the .ts is the tested source).
// Usage: node src/agent/control-plane/admission/check-admission-bypass.mjs [--json]
import { readdirSync, statSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const ROOT = process.cwd();
const SKIP = new Set(['node_modules', '.next', '.git', 'dist', 'build', 'coverage']);
const ADMISSION_PATH = 'src/agent/control-plane/admission/';
const INTERNAL = ['registry', 'normalize', 'fast-path', 'intent', 'complexity', 'planning', 'risk', 'dedup'];
// Also matches bare side-effect imports `import '...'` (Vercel review).
const IMPORT_RE = /(?:import|export)\s[^'"]*?from\s*['"]([^'"]+)['"]|import\s*['"]([^'"]+)['"]|(?:import|require)\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
const TO_ADMISSION = /(?:^|\/)src\/agent\/control-plane\/admission\/([a-z0-9-]+)/;

// Resolve a spec from `fromRel` to a repo-relative path so relative imports
// (`./admission/x`, `../admission/x`) are caught, not just alias/absolute ones.
function resolveToRepoPath(fromRel, spec) {
  if (spec.startsWith('.')) {
    const parts = fromRel.split('/').slice(0, -1);
    for (const seg of spec.split('/')) {
      if (seg === '.' || seg === '') continue;
      if (seg === '..') parts.pop();
      else parts.push(seg);
    }
    return parts.join('/');
  }
  if (spec.startsWith('@/')) return 'src/' + spec.slice(2);
  return spec;
}

function walkSafe(dir) {
  const out = [];
  const rec = (d) => {
    let entries;
    try { entries = readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const abs = join(d, e.name);
      if (e.isDirectory()) { if (!SKIP.has(e.name)) rec(abs); }
      else if (/\.(ts|tsx|mjs|js)$/.test(e.name)) out.push(abs);
    }
  };
  rec(join(ROOT, dir));
  return out;
}

function main() {
  const files = walkSafe('src');
  const violations = [];
  for (const abs of files) {
    const rel = relative(ROOT, abs).split(sep).join('/');
    if (rel.includes(ADMISSION_PATH)) continue; // inside the package
    const src = readFileSync(abs, 'utf8');
    let m;
    IMPORT_RE.lastIndex = 0;
    while ((m = IMPORT_RE.exec(src))) {
      const spec = m[1] || m[2] || m[3];
      if (!spec) continue;
      const hit = TO_ADMISSION.exec(resolveToRepoPath(rel, spec));
      if (hit && INTERNAL.includes(hit[1])) violations.push({ file: rel, importSpec: spec, module: hit[1] });
    }
  }
  if (process.argv.includes('--json')) {
    process.stdout.write(JSON.stringify({ scanned: files.length, violations }, null, 2) + '\n');
  } else {
    console.log(`admission bypass gate: ${files.length} files scanned`);
    if (violations.length === 0) console.log('PASS — no code bypasses the admission gateway (public entrypoints only)');
    else { console.log(`FAIL — ${violations.length} bypass(es):`); for (const v of violations) console.log(`  ${v.file} -> ${v.importSpec} (internal: ${v.module})`); }
  }
  process.exit(violations.length === 0 ? 0 : 1);
}
main();
