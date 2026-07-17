#!/usr/bin/env node
// Route-contract check (IOSP-0 fixture + IOSP-1 coordinator cross-check).
// Usage: node scripts/iosp0-route-contract-check.mjs
// Verifies, with zero build steps:
//   1. every Next.js page route exists in ios/route-contract.json;
//   2. every fixture entry has a valid classification/nativeHandler;
//   3. every exact-pattern entry marked nativeHandler:"native" has a matching
//      case in ios/App/App/AlmaNativeRouter.swift (dynamic entries checked via
//      their pathParam prefix);
//   4. no duplicate paths;
//   5. (IOSP-1) AlmaNavCoordinator.swift's allowlists mirror the fixture BOTH
//      ways: every temporary-web/public-web fixture route is in the coordinator,
//      every coordinator allowlist entry is in the fixture with the matching
//      classification, and every nativeHandler:"tab" route is in tabRootIndex.
// Exit code 0 = contract consistent; 1 = violations printed.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const fixture = JSON.parse(readFileSync(join(root, 'ios/route-contract.json'), 'utf8'));
const routerSrc = readFileSync(join(root, 'ios/App/App/AlmaNativeRouter.swift'), 'utf8');
const coordSrc = readFileSync(join(root, 'ios/App/App/AlmaNavCoordinator.swift'), 'utf8');

// --- parse the coordinator's Swift literal sets (IOSP-1) ---
function swiftSet(src, name) {
  const m = src.match(new RegExp(`${name}[^=]*=\\s*\\[([^\\]]*)\\]`, 's'));
  if (!m) return null;
  return [...m[1].matchAll(/"([^"]+)"/g)].map(x => x[1]);
}
const coordTemporary = swiftSet(coordSrc, 'temporaryWebRoutes');
const coordPublic = swiftSet(coordSrc, 'publicWebRoutes');
const coordPublicPrefixes = swiftSet(coordSrc, 'publicWebPrefixes');
const coordTabRoots = [...coordSrc.matchAll(/"(\/[^"]*)":\s*\d+/g)].map(x => x[1]);

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

// --- IOSP-1: coordinator ↔ fixture cross-check ---
if (!coordTemporary || !coordPublic || !coordPublicPrefixes) {
  errors.push('AlmaNavCoordinator.swift: could not parse allowlist sets (temporaryWebRoutes/publicWebRoutes/publicWebPrefixes)');
} else {
  const fixTemporary = fixture.routes.filter(r => r.classification === 'temporary-web' && r.pattern === 'exact').map(r => r.path);
  const fixPublicExact = fixture.routes.filter(r => r.classification === 'public-web-allowed' && r.pattern === 'exact').map(r => r.path);
  const fixPublicDynamic = fixture.routes.filter(r => r.classification === 'public-web-allowed' && r.pattern === 'dynamic').map(r => r.path.replace(/\[.+\]$/, ''));
  for (const p of fixTemporary) if (!coordTemporary.includes(p)) errors.push(`${p}: temporary-web in fixture but missing from AlmaNavCoordinator.temporaryWebRoutes`);
  for (const p of coordTemporary) if (!fixTemporary.includes(p)) errors.push(`${p}: in AlmaNavCoordinator.temporaryWebRoutes but not temporary-web in fixture`);
  for (const p of fixPublicExact) if (!coordPublic.includes(p)) errors.push(`${p}: public-web-allowed in fixture but missing from AlmaNavCoordinator.publicWebRoutes`);
  for (const p of coordPublic) if (!fixPublicExact.includes(p)) errors.push(`${p}: in AlmaNavCoordinator.publicWebRoutes but not public-web-allowed in fixture`);
  for (const p of fixPublicDynamic) if (!coordPublicPrefixes.includes(p)) errors.push(`${p}: dynamic public-web route has no AlmaNavCoordinator.publicWebPrefixes entry`);
  for (const r of fixture.routes) {
    if (r.nativeHandler === 'tab' && !coordTabRoots.includes(r.path)) {
      errors.push(`${r.path}: nativeHandler "tab" but missing from AlmaNavCoordinator.tabRootIndex`);
    }
  }
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
