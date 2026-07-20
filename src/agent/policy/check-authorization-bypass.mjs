#!/usr/bin/env node
// SPEC-110 — Authorization bypass CI gate (runner).
// Walks src/** and fails (exit 1) if any file OUTSIDE the policy package either
//  (1) deep-imports a policy layer (rbac/abac/relationship) AND calls .evaluate()
//      — self-authorizing around the engine, or
//  (2) gates on a raw privileged-role literal (=== 'owner', .roles.includes('admin'))
//      — hand-rolled authz. Add `policy-bypass-ok` on the line to opt out (reviewed).
// Mirrors bypass-gate.ts (the tested source); kept dependency-free.
// Scope: src/agent only. The policy engine governs AIOS AGENT operations; the
// live ERP (src/app, src/lib) has its own authorization and is out of scope for
// this repo (never modified) — and its 'owner' string literals are data values
// (authorType/dateSource/task-source), not role checks, so scanning it would be
// all false positives. Usage: node src/agent/policy/check-authorization-bypass.mjs [--json]
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const ROOT = process.cwd();
const SKIP = new Set(['node_modules', '.next', '.git', 'dist', 'build', 'coverage']);
const POLICY_PATH = 'src/agent/policy/';
const IMPORT_RE = /(?:import|export)\s[^'"]*?from\s*['"]([^'"]+)['"]|import\s*['"]([^'"]+)['"]|(?:import|require)\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
const TO_LAYER = /(?:^|\/)src\/agent\/policy\/(rbac|abac|relationship)(?:\.ts)?$/;
const TO_AUTHZ_PKG = /(?:^|\/)src\/agent\/(policy|identity)(?:\/|$)/;
const PRIV = ['owner', 'admin', 'root', 'superuser'];
const RAW_ROLE = new RegExp(
  `(===|!==|==|!=)\\s*['"\`](${PRIV.join('|')})['"\`]` +
    `|\\.(roles|scopes)\\b[\\s\\S]{0,40}?\\.includes\\(\\s*['"\`](${PRIV.join('|')})['"\`]\\s*\\)`,
);

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
  const files = walkSafe('src/agent');
  const violations = [];
  for (const abs of files) {
    const rel = relative(ROOT, abs).split(sep).join('/');
    if (rel.includes(POLICY_PATH)) continue; // inside the engine
    const src = readFileSync(abs, 'utf8');

    // (1) layer deep-import + .evaluate()
    let importsLayer = null;
    let authzAware = false;
    let m;
    IMPORT_RE.lastIndex = 0;
    while ((m = IMPORT_RE.exec(src))) {
      const spec = m[1] || m[2] || m[3];
      if (!spec) continue;
      const resolved = resolveToRepoPath(rel, spec);
      const hit = TO_LAYER.exec(resolved);
      if (hit) importsLayer = hit[1];
      if (TO_AUTHZ_PKG.test(resolved)) authzAware = true;
    }
    if (importsLayer && /\.evaluate\s*\(/.test(src)) {
      violations.push({ file: rel, kind: 'layer-evaluate', detail: `imports layer "${importsLayer}" and calls .evaluate() directly` });
    }

    // (2) hand-rolled authz on a privileged role literal — only in authz-aware files
    if (!authzAware) continue;
    src.split('\n').forEach((line, i) => {
      if (/policy-bypass-ok/.test(line)) return;
      if (RAW_ROLE.test(line)) {
        violations.push({ file: rel, kind: 'hand-rolled-authz', line: i + 1, detail: line.trim().slice(0, 80) });
      }
    });
  }

  if (process.argv.includes('--json')) {
    process.stdout.write(JSON.stringify({ scanned: files.length, violations }, null, 2) + '\n');
  } else {
    console.log(`authorization bypass gate: ${files.length} files scanned`);
    if (violations.length === 0) console.log('PASS — no code bypasses the policy engine (decide()/runIfAuthorized only)');
    else { console.log(`FAIL — ${violations.length} bypass(es):`); for (const v of violations) console.log(`  ${v.file}${v.line ? ':' + v.line : ''} [${v.kind}] ${v.detail}`); }
  }
  process.exit(violations.length === 0 ? 0 : 1);
}
main();
