#!/usr/bin/env node
// SPEC-130 — Direct external-call bypass CI gate (runner).
// Walks src/agent/** and FAILS (exit 1) if any external tool side-effect reaches a
// provider/network WITHOUT going through the gateway's execution adapter seam:
//  (A) a gateway-core file (src/agent/tool-gateway/**, except the adapter stage)
//      makes a direct network call (fetch/axios/WebSocket/http client), or
//  (B) a file OUTSIDE the gateway that IMPORTS the gateway also makes a direct call
//      for that side-effect. Add `gateway-adapter-ok` on the line to opt out.
// Mirrors bypass-gate.ts (the tested source); kept dependency-free.
// Scope: src/agent only. Pre-existing agent code that neither lives in the gateway
// nor imports it is out of scope (never false-flagged) — the gateway is the new,
// forward-looking choke point. Usage: node src/agent/tool-gateway/check-gateway-bypass.mjs [--json]
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const ROOT = process.cwd();
const SKIP = new Set(['node_modules', '.next', '.git', 'dist', 'build', 'coverage']);
const GATEWAY_PATH = 'src/agent/tool-gateway/';
const ADAPTER_STAGE = 'src/agent/tool-gateway/stages/execution-adapter.ts';
const OPT_OUT = 'gateway-adapter-ok';
const NETWORK_CALL_RE =
  /\bfetch\s*\(|\baxios\b|\bnew\s+WebSocket\s*\(|\bnode-fetch\b|\bhttps?\.request\s*\(|\bgot\s*\(|\bsuperagent\b/;
const IMPORT_RE =
  /(?:import|export)\s[^'"]*?from\s*['"]([^'"]+)['"]|import\s*['"]([^'"]+)['"]|(?:import|require)\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

const norm = (p) => p.split(sep).join('/');
const isTest = (f) => f.includes('/__tests__/') || f.endsWith('.test.ts');
const insideGateway = (f) => f.includes(GATEWAY_PATH);
const isAdapterStage = (f) => f.endsWith(ADAPTER_STAGE);

function importsGateway(src) {
  let m;
  IMPORT_RE.lastIndex = 0;
  while ((m = IMPORT_RE.exec(src))) {
    const spec = m[1] || m[2] || m[3];
    if (spec && /(?:^|\/)tool-gateway(?:\/|$)|@\/agent\/tool-gateway/.test(spec)) return true;
  }
  return false;
}

function offendingLines(src) {
  const hits = [];
  src.split('\n').forEach((raw, i) => {
    const line = raw.trim();
    if (line.startsWith('*') || line.startsWith('//')) return;
    if (line.includes(OPT_OUT)) return;
    if (NETWORK_CALL_RE.test(line)) hits.push({ line: i + 1, text: line.slice(0, 80) });
  });
  return hits;
}

function walk(dir) {
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
  const files = walk('src/agent');
  const violations = [];
  for (const abs of files) {
    const rel = norm(relative(ROOT, abs));
    if (isTest(rel)) continue;
    const src = readFileSync(abs, 'utf8');
    if (insideGateway(rel) && !isAdapterStage(rel)) {
      for (const h of offendingLines(src)) violations.push({ file: rel, kind: 'gateway-core-network-call', line: h.line, detail: h.text });
    } else if (!insideGateway(rel) && importsGateway(src)) {
      for (const h of offendingLines(src)) violations.push({ file: rel, kind: 'gateway-aware-bypass', line: h.line, detail: h.text });
    }
  }

  if (process.argv.includes('--json')) {
    process.stdout.write(JSON.stringify({ scanned: files.length, violations }, null, 2) + '\n');
  } else {
    console.log(`gateway bypass gate: ${files.length} files scanned`);
    if (violations.length === 0) console.log('PASS — no external side-effect bypasses the gateway adapter seam');
    else { console.log(`FAIL — ${violations.length} bypass(es):`); for (const v of violations) console.log(`  ${v.file}:${v.line} [${v.kind}] ${v.detail}`); }
  }
  process.exit(violations.length === 0 ? 0 : 1);
}
main();
