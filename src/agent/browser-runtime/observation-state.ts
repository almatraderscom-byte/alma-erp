/**
 * Browser compact observation state (G15 / SPEC-147).
 *
 * Realises INV-07 for the browser: the model NEVER sees a raw page. A raw DOM
 * snapshot can be huge and can carry secrets (tokens in inputs, emails, bearer
 * strings in labels). This transform (reusing the G10 result-firewall redaction
 * idea) produces the bounded, secret-redacted `Observation` the action phase is
 * allowed to consume:
 *
 *   1. DROP every element `value` — values never reach the model.
 *   2. REDACT secret-shaped label text (password/token/bearer/JWT/email/long
 *      hex|base64) to `[REDACTED]`, deterministically.
 *   3. TRUNCATE labels to a char cap.
 *   4. CAP the element set by interactivity priority (buttons/links/inputs first).
 *   5. Enforce a hard serialized-byte ceiling — over it ⇒ fail-closed.
 *
 * Pure + deterministic (INV-01): caps/`nowMs` injected, no clock/RNG/IO. Returns a
 * G01 `ComponentResult<Observation>` plus a `CompactionReport`.
 */
import { completed, type ComponentFailure, type ComponentResult, type ExecutionIdentity, type FailureStatus } from '@/agent/contracts';
import { MAX_OBSERVED_ELEMENTS, type Observation, type ObservedElement } from './contract';

export const OBSERVATION_REASON_CODES = {
  OVERSIZE: 'BR_OBS_OVERSIZE',
  MALFORMED: 'BR_OBS_COMPACT_MALFORMED',
} as const;
export type ObservationReasonCode =
  (typeof OBSERVATION_REASON_CODES)[keyof typeof OBSERVATION_REASON_CODES];

/** A raw element as captured from the page (may be large / contain secrets). */
export interface RawElement {
  ref: string;
  role: string;
  label: string;
  /** Captured value — DROPPED during compaction (never modeled). */
  value?: string;
  /** Whether the element is interactive (prioritised when capping). */
  interactive?: boolean;
}

export interface RawSnapshot {
  identity: ExecutionIdentity;
  observedAtMs: number;
  rawUrl: string;
  elements: RawElement[];
}

export interface CompactionCaps {
  maxElements: number;
  maxLabelChars: number;
  maxBytes: number;
}

export interface CompactionReport {
  rawCount: number;
  keptCount: number;
  droppedCount: number;
  redactedCount: number;
  bytes: number;
}

export const REDACTED = '[REDACTED]';

// Deterministic secret-shape patterns (mirrors G10 firewall redaction intent).
const SECRET_LABEL_RE = /password|secret|token|api[_-]?key|authorization|bearer|passwd|credential/i;
const JWT_RE = /eyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}/;
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;
const LONG_TOKEN_RE = /\b[A-Za-z0-9+/=_-]{24,}\b/;

function bfail(status: FailureStatus, reasonCodes: string[]): ComponentFailure {
  return { status, reasonCodes, evidenceIds: [] };
}

/** True iff a label looks like it contains or names a secret. */
export function isSecretLabel(label: string): boolean {
  return SECRET_LABEL_RE.test(label) || JWT_RE.test(label) || EMAIL_RE.test(label) || LONG_TOKEN_RE.test(label);
}

/** Redact + truncate one label deterministically. Returns [text, wasRedacted]. */
export function redactLabel(label: string, maxChars: number): [string, boolean] {
  if (isSecretLabel(label)) return [REDACTED, true];
  const trimmed = label.length > maxChars ? label.slice(0, maxChars) : label;
  return [trimmed, false];
}

/** Strip host+path from a URL, dropping query/fragment (which may carry secrets). */
export function redactUrl(rawUrl: string): string {
  const noFragment = rawUrl.split('#')[0];
  const noQuery = noFragment.split('?')[0];
  return noQuery.length > 0 ? noQuery : rawUrl;
}

// Interactive roles first (stable priority), then original order preserved.
const INTERACTIVE_ROLES = new Set(['button', 'link', 'textbox', 'checkbox', 'combobox', 'menuitem', 'tab', 'option']);

function priority(e: RawElement): number {
  if (e.interactive === true) return 0;
  if (INTERACTIVE_ROLES.has(e.role)) return 0;
  return 1;
}

/**
 * Compact a raw snapshot into the bounded, redacted `Observation` the model may
 * see. Fail-closed: an invalid snapshot or a compacted view that still exceeds the
 * hard byte ceiling is rejected (OVERSIZE) — the model never receives an oversized
 * or unredacted view.
 */
export function compactObservation(
  snapshot: RawSnapshot,
  caps: CompactionCaps,
): { result: ComponentResult<Observation>; report: CompactionReport | null } {
  const emptyReport: CompactionReport | null = null;
  if (
    !snapshot ||
    !snapshot.identity ||
    !Number.isInteger(snapshot.observedAtMs) ||
    snapshot.observedAtMs < 0 ||
    !Array.isArray(snapshot.elements) ||
    !Number.isInteger(caps.maxElements) || caps.maxElements <= 0 ||
    !Number.isInteger(caps.maxLabelChars) || caps.maxLabelChars <= 0 ||
    !Number.isInteger(caps.maxBytes) || caps.maxBytes <= 0
  ) {
    return { result: bfail('FAILED_FINAL', [OBSERVATION_REASON_CODES.MALFORMED]), report: emptyReport };
  }

  const effectiveMax = Math.min(caps.maxElements, MAX_OBSERVED_ELEMENTS);

  // Stable priority sort: interactive first; ties keep original index order.
  const indexed = snapshot.elements.map((e, i) => ({ e, i }));
  indexed.sort((a, b) => priority(a.e) - priority(b.e) || a.i - b.i);

  const kept = indexed.slice(0, effectiveMax);
  let redactedCount = 0;
  const elements: ObservedElement[] = kept.map(({ e }) => {
    const [label, wasRedacted] = redactLabel(e.label, caps.maxLabelChars);
    if (wasRedacted) redactedCount++;
    // value is intentionally dropped (never modeled).
    return { ref: e.ref, role: e.role, label };
  });

  const observation: Observation = {
    identity: snapshot.identity,
    observedAtMs: snapshot.observedAtMs,
    urlRef: redactUrl(snapshot.rawUrl),
    elements,
  };

  const bytes = Buffer.byteLength(JSON.stringify(observation), 'utf8');
  const report: CompactionReport = {
    rawCount: snapshot.elements.length,
    keptCount: elements.length,
    droppedCount: snapshot.elements.length - elements.length,
    redactedCount,
    bytes,
  };

  if (bytes > caps.maxBytes) {
    return { result: bfail('FAILED_FINAL', [OBSERVATION_REASON_CODES.OVERSIZE]), report };
  }

  return { result: completed(observation, [], { browser: '1.0.0' }), report };
}
