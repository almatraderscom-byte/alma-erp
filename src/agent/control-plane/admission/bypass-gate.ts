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
const IMPORT_TO_ADMISSION = /agent\/control-plane\/admission\/([a-z0-9-]+)/;

export interface BypassViolation {
  file: string;
  importSpec: string;
  module: string;
}

/**
 * Is `importSpec` (from `fromFile`) an admission bypass? True when a file OUTSIDE
 * the admission package imports one of its internal modules directly.
 */
export function isAdmissionBypass(fromFile: string, importSpec: string): BypassViolation | null {
  if (fromFile.replace(/^\.\//, '').includes(ADMISSION_PATH)) return null; // inside the package
  const m = IMPORT_TO_ADMISSION.exec(importSpec);
  if (!m) return null;
  const mod = m[1];
  if ((ADMISSION_INTERNAL_MODULES as readonly string[]).includes(mod)) {
    return { file: fromFile, importSpec, module: mod };
  }
  return null;
}
