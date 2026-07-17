#!/usr/bin/env node
// ios-feature-parity-check.mjs — NP-0 action-level parity checker.
//
// Route-level coverage is iosp0-route-contract-check.mjs; this checker guards the
// ACTION level so a screen cannot be route-green while feature-red:
//   1. Contract file validates against its schema shape (no external deps).
//   2. Every non-native surface/action must carry a plannedPhase (NP-1..NP-9) —
//      open work is TRACKED, never hidden. The checker prints the open ledger
//      grouped by phase and fails only on UNTRACKED gaps.
//   3. openWeb( call-site counts per Swift file must match the checked-in
//      snapshot: a GAIN fails (undocumented new internal web escape); a DROP
//      fails with "refresh the snapshot" (so removals are recorded deliberately).
//   4. Exceptions must be public-web / system-handoff / login-fallback only —
//      an internal ALMA page is never a valid exception target.
//
// Usage: node scripts/ios-feature-parity-check.mjs [--strict]
//   default: exit 0 while open gaps are all tracked with plannedPhase.
//   --strict: exit 1 if ANY non-native action remains (NP-9 release gate).

import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CONTRACT = join(ROOT, 'ios', 'feature-parity-contract.json');
const SWIFT_DIR = join(ROOT, 'ios', 'App', 'App');
const STRICT = process.argv.includes('--strict');

const fail = [];
const warn = [];

let contract;
try {
  contract = JSON.parse(readFileSync(CONTRACT, 'utf8'));
} catch (e) {
  console.error(`FEATURE CONTRACT UNREADABLE: ${e.message}`);
  process.exit(1);
}

// ── 1. Shape validation (dependency-free) ────────────────────────────────────
const SURFACE_STATES = ['native', 'partial', 'missing', 'routing', 'ux', 'retired', 'public-web'];
const ACTION_STATES = ['native', 'system-handoff', 'public-web', 'missing', 'retired'];
const ACTION_KINDS = ['read', 'write', 'export', 'upload', 'deep-link', 'oauth', 'navigation'];
const EXC_CLASSES = ['public-web', 'system-handoff', 'login-fallback'];
const PHASE_RE = /^NP-[0-9]$/;

for (const key of ['version', 'generatedFor', 'baseline', 'surfaces', 'exceptions', 'openWebAllowlist']) {
  if (!(key in contract)) fail.push(`contract missing top-level key: ${key}`);
}
if (!contract.baseline?.sha) fail.push('baseline.sha missing');

const actionIds = new Set();
for (const s of contract.surfaces ?? []) {
  const where = `surface ${s.id ?? '<no id>'}`;
  if (!s.id || !/^(AG|AU|AD|TR|FN|OP|DN)-\d{2}$/.test(s.id)) fail.push(`${where}: bad or missing id`);
  if (!SURFACE_STATES.includes(s.state)) fail.push(`${where}: bad state "${s.state}"`);
  if (!Array.isArray(s.actions) || s.actions.length === 0) fail.push(`${where}: no actions`);
  if (s.plannedPhase && !PHASE_RE.test(s.plannedPhase)) fail.push(`${where}: bad plannedPhase "${s.plannedPhase}"`);
  for (const a of s.actions ?? []) {
    const aw = `${where} action ${a.id ?? '<no id>'}`;
    if (!a.id) fail.push(`${aw}: missing id`);
    else if (actionIds.has(a.id)) fail.push(`${aw}: duplicate action id`);
    else actionIds.add(a.id);
    if (a.id && s.id && !a.id.startsWith(s.id + '.')) fail.push(`${aw}: action id must be prefixed by its surface id`);
    if (!ACTION_KINDS.includes(a.kind)) fail.push(`${aw}: bad kind "${a.kind}"`);
    if (!ACTION_STATES.includes(a.state)) fail.push(`${aw}: bad state "${a.state}"`);
    if (a.plannedPhase && !PHASE_RE.test(a.plannedPhase)) fail.push(`${aw}: bad plannedPhase`);
  }
}

// ── 2. Open ledger: every non-native action needs a plannedPhase ─────────────
const open = []; // {phase, id, title, state}
for (const s of contract.surfaces ?? []) {
  for (const a of s.actions ?? []) {
    if (a.state === 'native' || a.state === 'retired') continue;
    if (a.state === 'system-handoff' || a.state === 'public-web') continue; // approved classes
    const phase = a.plannedPhase ?? s.plannedPhase;
    if (!phase) fail.push(`UNTRACKED GAP: ${a.id} (${a.title ?? ''}) state=${a.state} has no plannedPhase`);
    else open.push({ phase, id: a.id, title: a.title ?? '', state: a.state });
  }
}

// ── 3. openWeb( snapshot ─────────────────────────────────────────────────────
const live = {};
for (const f of readdirSync(SWIFT_DIR)) {
  if (!f.endsWith('.swift')) continue;
  const src = readFileSync(join(SWIFT_DIR, f), 'utf8');
  const n = (src.match(/openWeb\(/g) ?? []).length;
  if (n > 0) live[f] = n;
}
const snap = contract.openWebAllowlist ?? {};
for (const [f, n] of Object.entries(live)) {
  const s = snap[f] ?? 0;
  if (n > s) fail.push(`openWeb GAIN: ${f} has ${n} call sites, snapshot allows ${s} — document the new escape (exception or plannedPhase) and refresh the snapshot`);
  else if (n < s) fail.push(`openWeb DROP: ${f} has ${n} call sites, snapshot says ${s} — escape removed; refresh the snapshot to record it`);
}
for (const [f, s] of Object.entries(snap)) {
  if (!(f in live)) fail.push(`openWeb DROP: ${f} now has 0 call sites, snapshot says ${s} — refresh the snapshot`);
}

// ── 4. Exceptions sanity ─────────────────────────────────────────────────────
const INTERNAL_RE = /^\/(?!app\/download|invoice\/share|privacy-policy)[a-z]/i;
for (const ex of contract.exceptions ?? []) {
  const where = `exception ${ex.id ?? '<no id>'}`;
  if (!EXC_CLASSES.includes(ex.class)) fail.push(`${where}: bad class "${ex.class}"`);
  if (!ex.reason) fail.push(`${where}: missing reason`);
  if (ex.class === 'public-web' && INTERNAL_RE.test(ex.target ?? '')) {
    fail.push(`${where}: "${ex.target}" looks like an INTERNAL route — internal pages are never valid exceptions`);
  }
}

// ── Report ───────────────────────────────────────────────────────────────────
const byPhase = {};
for (const o of open) (byPhase[o.phase] ??= []).push(o);
const phases = Object.keys(byPhase).sort();
console.log(`feature-parity contract: ${contract.surfaces?.length ?? 0} surfaces, ${actionIds.size} actions, ${contract.exceptions?.length ?? 0} exceptions`);
console.log(`open (tracked) actions: ${open.length}`);
for (const p of phases) {
  console.log(`  ${p}: ${byPhase[p].length} → ${byPhase[p].map((o) => o.id).join(', ')}`);
}
for (const w of warn) console.log(`WARN: ${w}`);

if (STRICT && open.length > 0) {
  fail.push(`--strict: ${open.length} tracked open actions remain (release gate)`);
}
if (fail.length) {
  console.error(`\nFEATURE PARITY CHECK FAILED (${fail.length}):`);
  for (const f of fail) console.error(`  ✗ ${f}`);
  process.exit(1);
}
console.log('\nFEATURE PARITY CHECK OK' + (STRICT ? ' (strict)' : ` — ${open.length} open actions tracked by phase, none hidden`));
