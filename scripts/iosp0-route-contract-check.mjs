#!/usr/bin/env node
// IOSP-0 route-contract fixture check.
// Usage: node scripts/iosp0-route-contract-check.mjs
// Verifies, with zero build steps:
//   1. every Next.js page route exists in ios/route-contract.json;
//   2. every fixture entry has a valid classification/nativeHandler;
//   3. every exact-pattern entry marked nativeHandler:"native" has a matching
//      case in ios/App/App/AlmaNativeRouter.swift (dynamic entries checked via
//      their pathParam prefix);
//   4. no duplicate paths.
// Exit code 0 = contract consistent; 1 = violations printed.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const fixture = JSON.parse(readFileSync(join(root, 'ios/route-contract.json'), 'utf8'));
const routerSrc = readFileSync(join(root, 'ios/App/App/AlmaNativeRouter.swift'), 'utf8');

// --- collect web routes from src/app/**/page.tsx (skip api/) ---
function webRoutes(dir, prefix = '') {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (!statSync(p).isDirectory()) {
      if (/^page\.(tsx|ts|jsx)$/.test(name)) out.push(prefix === '' ? '/' : prefix);
      continue;
    }
    if (name === 'api') continue;
    // route groups (group) don't add a segment
    const seg = name.startsWith('(') ? '' : `/${name}`;
    out.push(...webRoutes(p, prefix + seg));
  }
  return out;
}
const web = [...new Set(webRoutes(join(root, 'src/app')))].sort();

const validClass = new Set(['native-required', 'system-handoff', 'public-web-allowed', 'temporary-web']);
const validHandler = new Set(['native', 'web', 'tab']);
const errors = [];

const paths = fixture.routes.map(r => r.path);
const dup = paths.filter((p, i) => paths.indexOf(p) !== i);
if (dup.length) errors.push(`duplicate fixture paths: ${dup.join(', ')}`);

for (const r of fixture.routes) {
  if (!validClass.has(r.classification)) errors.push(`${r.path}: invalid classification "${r.classification}"`);
  if (!validHandler.has(r.nativeHandler)) errors.push(`${r.path}: invalid nativeHandler "${r.nativeHandler}"`);
  if (r.nativeHandler === 'native' && r.pattern === 'exact') {
    if (!routerSrc.includes(`"${r.path}"`)) errors.push(`${r.path}: marked native but no exact case in AlmaNativeRouter.swift`);
  }
  if (r.nativeHandler === 'native' && r.pattern === 'dynamic') {
    const prefix = r.path.replace(/\[.+\]$/, '');
    if (!routerSrc.includes(`after: "${prefix}"`)) errors.push(`${r.path}: marked native dynamic but no pathParam(after: "${prefix}") in router`);
  }
}

for (const w of web) {
  if (!paths.includes(w)) errors.push(`web route ${w} missing from route-contract.json`);
}

if (errors.length) {
  console.error(`ROUTE CONTRACT FAIL (${errors.length}):`);
  for (const e of errors) console.error(`  - ${e}`);
  process.exit(1);
}
console.log(`ROUTE CONTRACT OK: ${fixture.routes.length} fixture routes cover ${web.length} web routes.`);
const byClass = {};
for (const r of fixture.routes) byClass[r.classification] = (byClass[r.classification] ?? 0) + 1;
console.log(JSON.stringify(byClass));
const gaps = fixture.routes.filter(r => r.gapPhase);
console.log(`open gaps: ${gaps.length} → ${gaps.map(g => `${g.path} (${g.gapPhase})`).join(', ')}`);
