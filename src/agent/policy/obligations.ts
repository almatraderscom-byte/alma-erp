/**
 * Policy obligations and redaction (G11 / SPEC-109).
 *
 * A permit is rarely unconditional. Layers attach OBLIGATIONS to their permit
 * vote (SPEC-105 already unions them onto `PolicyDecisionValue.obligations`) —
 * "you may read this, but redact the customer's phone", "mask the card", "this
 * access must be audited". This module gives obligations a canonical, typed,
 * serializable form and a DETERMINISTIC applier that transforms a payload into
 * the bounded view the model/caller is actually allowed to see (INV-07).
 *
 * Obligations travel as compact strings so they pass unchanged through the
 * engine's `string[]`:
 *   redact:<path>            drop the value → "[REDACTED]"
 *   mask:<path>[:keepLast]   keep last N chars (default 4), mask the rest
 *   audit                    this access must be recorded (no data change)
 *   deny_export              value must not leave the tenant (flagged, no change)
 *
 * Pure, deterministic: no I/O, no LLM (INV-01). Bounded: obligation count and
 * path depth are capped so a decision cannot drive unbounded work.
 */
export const OBLIGATION_REASON_CODES = {
  APPLIED: 'OBLIGATION_APPLIED',
  MALFORMED: 'OBLIGATION_MALFORMED',
} as const;

export type ObligationKind = 'redact' | 'mask' | 'audit' | 'deny_export';

export interface Obligation {
  kind: ObligationKind;
  /** Dotted path into the payload for redact/mask; absent for audit/deny_export. */
  target?: string;
  /** mask: number of trailing chars to keep. */
  keepLast?: number;
  /** The original canonical string. */
  raw: string;
}

export const MAX_OBLIGATIONS = 128;
export const MAX_PATH_DEPTH = 16;
export const REDACTED = '[REDACTED]';
const DEFAULT_MASK_KEEP = 4;
const MASK_CHAR = '*';

/** Parse one canonical obligation string. Returns null if malformed. */
export function parseObligation(raw: string): Obligation | null {
  const parts = raw.split(':');
  const kind = parts[0];
  switch (kind) {
    case 'audit':
    case 'deny_export':
      return parts.length === 1 ? { kind, raw } : null;
    case 'redact':
      return parts.length === 2 && parts[1] ? { kind, target: parts[1], raw } : null;
    case 'mask': {
      if (parts.length < 2 || !parts[1]) return null;
      let keepLast = DEFAULT_MASK_KEEP;
      if (parts.length === 3) {
        const n = Number(parts[2]);
        if (!Number.isInteger(n) || n < 0) return null;
        keepLast = n;
      } else if (parts.length > 3) {
        return null;
      }
      return { kind: 'mask', target: parts[1], keepLast, raw };
    }
    default:
      return null;
  }
}

/** Mask a value keeping the last `keepLast` characters. Non-strings → REDACTED. */
export function maskValue(value: unknown, keepLast: number): string {
  if (typeof value !== 'string') {
    // A non-string secret has no safe partial form → full redaction.
    return REDACTED;
  }
  if (keepLast <= 0 || keepLast >= value.length) {
    return keepLast >= value.length ? value : MASK_CHAR.repeat(value.length);
  }
  const shown = value.slice(value.length - keepLast);
  return MASK_CHAR.repeat(value.length - keepLast) + shown;
}

// ── Bounded deep clone + path mutation (data-only) ──────────────────────────

function deepClone<T>(v: T): T {
  if (v === null || typeof v !== 'object') return v;
  if (Array.isArray(v)) return v.map((x) => deepClone(x)) as unknown as T;
  const out: Record<string, unknown> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) out[k] = deepClone(val);
  return out as T;
}

/** Apply `fn` to the value at `path`, if the path exists. Returns whether it hit. */
function transformAtPath(
  root: Record<string, unknown>,
  path: string,
  fn: (current: unknown) => unknown,
): boolean {
  const segs = path.split('.');
  if (segs.length > MAX_PATH_DEPTH) return false;
  let cur: unknown = root;
  for (let i = 0; i < segs.length - 1; i++) {
    if (cur === null || typeof cur !== 'object') return false;
    cur = (cur as Record<string, unknown>)[segs[i]];
  }
  if (cur === null || typeof cur !== 'object') return false;
  const last = segs[segs.length - 1];
  if (!(last in (cur as Record<string, unknown>))) return false;
  (cur as Record<string, unknown>)[last] = fn((cur as Record<string, unknown>)[last]);
  return true;
}

export interface ObligationApplyResult<T> {
  /** The bounded, redacted/masked view of the payload. */
  value: T;
  /** Obligations that were successfully applied (parsed + hit a path or flag). */
  applied: Obligation[];
  /** Raw obligation strings that failed to parse. */
  malformed: string[];
  /** True if any `audit` obligation was present. */
  auditRequired: boolean;
  /** True if any `deny_export` obligation was present. */
  denyExport: boolean;
}

/**
 * Apply a decision's obligations to a payload, producing the bounded view the
 * caller is allowed to see. Deterministic; never mutates the input (deep-clones
 * first). Unknown/malformed obligations are reported, NOT silently ignored, and
 * NEVER widen access (fail-closed: a malformed redact leaves the field dropped
 * only if a later valid one hits — an unparseable one just surfaces in
 * `malformed`, it does not expose anything it otherwise would).
 */
export function applyObligations<T>(payload: T, obligations: string[]): ObligationApplyResult<T> {
  const value = deepClone(payload);
  const applied: Obligation[] = [];
  const malformed: string[] = [];
  let auditRequired = false;
  let denyExport = false;

  const bounded = obligations.slice(0, MAX_OBLIGATIONS);
  const asRecord =
    value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : null;

  for (const raw of bounded) {
    const ob = parseObligation(raw);
    if (!ob) { malformed.push(raw); continue; }
    switch (ob.kind) {
      case 'audit':
        auditRequired = true; applied.push(ob); break;
      case 'deny_export':
        denyExport = true; applied.push(ob); break;
      case 'redact':
        if (asRecord && transformAtPath(asRecord, ob.target!, () => REDACTED)) applied.push(ob);
        break;
      case 'mask':
        if (asRecord && transformAtPath(asRecord, ob.target!, (cur) => maskValue(cur, ob.keepLast ?? DEFAULT_MASK_KEEP))) {
          applied.push(ob);
        }
        break;
    }
  }

  return { value, applied, malformed, auditRequired, denyExport };
}

/** Build a canonical obligation string (for layers attaching obligations). */
export const obligation = {
  redact: (path: string): string => `redact:${path}`,
  mask: (path: string, keepLast = DEFAULT_MASK_KEEP): string => `mask:${path}:${keepLast}`,
  audit: (): string => 'audit',
  denyExport: (): string => 'deny_export',
};
