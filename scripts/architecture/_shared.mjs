// Shared helpers for AIOS architecture governance scripts (G01).
// Node built-ins only — no third-party deps, deterministic output.
import { readdirSync, statSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

export const REPO_ROOT = process.cwd();

const DEFAULT_SKIP = new Set([
  'node_modules',
  '.next',
  '.git',
  'dist',
  'build',
  'coverage',
  '.turbo',
  '.vercel',
]);

/** Recursively list files under `dir`, skipping build/vendor directories. */
export function walk(dir, { skip = DEFAULT_SKIP, exts = null } = {}) {
  const out = [];
  const root = join(REPO_ROOT, dir);
  const stack = [root];
  while (stack.length) {
    const cur = stack.pop();
    let entries;
    try {
      entries = readdirSync(cur, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (e.isDirectory()) {
        if (skip.has(e.name)) continue;
        stack.push(join(cur, e.name));
      } else if (e.isFile()) {
        if (exts && !exts.some((x) => e.name.endsWith(x))) continue;
        out.push(join(cur, e.name));
      }
    }
  }
  return out.sort();
}

export function rel(abs) {
  return relative(REPO_ROOT, abs).split(sep).join('/');
}

export function read(abs) {
  try {
    return readFileSync(abs, 'utf8');
  } catch {
    return '';
  }
}

export function exists(pathRel) {
  try {
    statSync(join(REPO_ROOT, pathRel));
    return true;
  } catch {
    return false;
  }
}

/** Stable JSON with sorted keys for deterministic diffs. */
export function stableJson(value) {
  return JSON.stringify(sortDeep(value), null, 2);
}

function sortDeep(v) {
  if (Array.isArray(v)) return v.map(sortDeep);
  if (v && typeof v === 'object') {
    const out = {};
    for (const k of Object.keys(v).sort()) out[k] = sortDeep(v[k]);
    return out;
  }
  return v;
}
