/**
 * Admission bypass gate (G02 / SPEC-020).
 *
 * Enforces that the admission control plane is the ONLY door: code outside the
 * admission package must enter through the public entrypoints (`gateway` /
 * `task-envelope`), never by importing an internal stage module directly. That
 * keeps every request going through `admit()` — no stage can be invoked around
 * the gateway. Pure checker; the .mjs runner walks the repo and applies it.
 */

export const ADMISSION_PUBLIC_ENTRYPOINTS = ['gateway', 'task-envelope', 'index'] as const;

/** Internal stage/impl modules that outsiders must NOT import directly. */
export const ADMISSION_INTERNAL_MODULES = [
  'registry',
  'normalize',
  'fast-path',
  'intent',
  'complexity',
  'planning',
  'risk',
  'dedup',
] as const;

const ADMISSION_PATH = 'src/agent/control-plane/admission/';
const IMPORT_TO_ADMISSION = /(?:^|\/)src\/agent\/control-plane\/admission\/([a-z0-9-]+)/;

export interface BypassViolation {
  file: string;
  importSpec: string;
  module: string;
}

/**
 * Resolve an import specifier from `fromFile` to a repo-relative POSIX path.
 * Relative specs (`./admission/x`, `../admission/x`) are resolved against the
 * importing file's directory; `@/…` maps to `src/…`. This is what lets the gate
 * catch relative-path bypasses (Vercel review), not just alias/absolute ones.
 */
function resolveToRepoPath(fromFile: string, spec: string): string {
  const from = fromFile.replace(/^\.\//, '');
  if (spec.startsWith('.')) {
    const parts = from.split('/').slice(0, -1); // dir of fromFile
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

/**
 * Is `importSpec` (from `fromFile`) an admission bypass? True when a file OUTSIDE
 * the admission package imports one of its internal modules directly — via alias,
 * absolute, OR relative path.
 */
export function isAdmissionBypass(fromFile: string, importSpec: string): BypassViolation | null {
  if (fromFile.replace(/^\.\//, '').includes(ADMISSION_PATH)) return null; // inside the package
  const resolved = resolveToRepoPath(fromFile, importSpec);
  const m = IMPORT_TO_ADMISSION.exec(resolved);
  if (!m) return null;
  const mod = m[1];
  if ((ADMISSION_INTERNAL_MODULES as readonly string[]).includes(mod)) {
    return { file: fromFile, importSpec, module: mod };
  }
  return null;
}
