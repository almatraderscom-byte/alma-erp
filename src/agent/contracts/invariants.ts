/**
 * AIOS architecture invariants and forbidden-dependency rules (G01 / SPEC-002).
 *
 * Deterministic registry the governance scripts and later groups read. No LLM,
 * no I/O. The forbidden-dependency model encodes the CLAUDE.md one-way rule:
 * ERP code must never import `src/agent/**`; the agent may import shared libs.
 */

/** The ten non-negotiable invariants, frozen from GLOBAL_AGENT_CONTRACT.md. */
export const ARCHITECTURE_INVARIANTS = [
  { id: 'INV-01', text: 'No LLM call for deterministic validation, routing, permission, budget arithmetic or postcondition checking.' },
  { id: 'INV-02', text: 'Every authoritative operation carries tenant, actor, agent, workflow, step and correlation identities.' },
  { id: 'INV-03', text: 'Every model call is pre-authorized by the Cost Governor once it exists.' },
  { id: 'INV-04', text: 'Every external side effect goes through the Tool Gateway once it exists.' },
  { id: 'INV-05', text: 'Permissions and approvals fail closed.' },
  { id: 'INV-06', text: 'Unknown external outcomes enter reconciliation; never blindly retried.' },
  { id: 'INV-07', text: 'Full provider/tool payloads stay in evidence storage; models receive bounded views.' },
  { id: 'INV-08', text: 'New behavior is feature-flagged and rollback-tested.' },
  { id: 'INV-09', text: 'Existing public behavior remains compatible until migration evidence passes.' },
  { id: 'INV-10', text: 'Completion requires executable proof, not an explanation.' },
] as const;

export type InvariantId = (typeof ARCHITECTURE_INVARIANTS)[number]['id'];

/**
 * Logical zones of the repository. Per CLAUDE.md the agent lives in THREE
 * places — `src/agent/**`, `src/app/agent/**` (its Next.js UI) and
 * `src/app/api/assistant/**` (its API) — so those are agent-side zones, not
 * ERP. `src/app/api/agent/**` is the frozen legacy agent API (also agent-side).
 */
export type Zone =
  | 'erp-app'
  | 'erp-api'
  | 'shared-lib'
  | 'agent'
  | 'agent-app'
  | 'assistant-api'
  | 'agent-contracts'
  | 'legacy-agent-api';

/**
 * Allowed import directions. `from` zone may import a module resolving into
 * `to` zone only if listed here. The core rule: ERP zones must NOT depend on
 * `agent`. Everything may depend on `shared-lib`.
 */
export const FORBIDDEN_IMPORT_RULES = [
  { from: 'erp-app', forbiddenTo: ['agent', 'agent-contracts'], reason: 'ERP must not import the agent module (one-way dependency).' },
  { from: 'erp-api', forbiddenTo: ['agent', 'agent-contracts'], reason: 'ERP must not import the agent module (one-way dependency).' },
  { from: 'shared-lib', forbiddenTo: ['agent', 'agent-contracts'], reason: 'Shared libs must not depend on the agent module.' },
] as const;

export const INVARIANT_REASON_CODES = {
  FORBIDDEN_IMPORT: 'FORBIDDEN_IMPORT',
  UNKNOWN_ZONE: 'UNKNOWN_ZONE',
} as const;

/** Classify a repo-relative file path into a Zone. */
export function zoneOf(path: string): Zone | 'other' {
  const p = path.replace(/^\.\//, '');
  // Agent-side zones first (order matters — these are subsets of src/app).
  if (p.startsWith('src/app/api/agent/')) return 'legacy-agent-api';
  if (p.startsWith('src/app/api/assistant/')) return 'assistant-api';
  if (p.startsWith('src/app/agent/')) return 'agent-app';
  if (p.startsWith('src/agent/contracts/')) return 'agent-contracts';
  if (p.startsWith('src/agent/')) return 'agent';
  // ERP zones.
  if (p.startsWith('src/app/api/')) return 'erp-api';
  if (p.startsWith('src/app/')) return 'erp-app';
  if (p.startsWith('src/lib/')) return 'shared-lib';
  return 'other';
}

/** Resolve an import specifier to the zone it targets (or null if external). */
export function importTargetZone(spec: string): Zone | 'other' | null {
  // Match `@/agent/...`, `src/agent/...`, and relative paths already normalised
  // by the caller into repo-relative form.
  if (/^@\/agent\/contracts(\/|$)/.test(spec) || /(^|\/)src\/agent\/contracts(\/|$)/.test(spec))
    return 'agent-contracts';
  if (/^@\/agent(\/|$)/.test(spec) || /(^|\/)src\/agent(\/|$)/.test(spec)) return 'agent';
  if (/^@\/lib(\/|$)/.test(spec) || /(^|\/)src\/lib(\/|$)/.test(spec)) return 'shared-lib';
  return null;
}

export interface ForbiddenImportViolation {
  file: string;
  fromZone: Zone | 'other';
  importSpec: string;
  toZone: Zone | 'other';
  reasonCode: string;
  reason: string;
}

/**
 * Pure check: is importing `importSpec` from a file in `fromZone` forbidden?
 * Returns a violation record or null.
 */
export function checkImport(
  file: string,
  fromZone: Zone | 'other',
  importSpec: string,
): ForbiddenImportViolation | null {
  const toZone = importTargetZone(importSpec);
  if (toZone === null) return null; // external / unrelated
  const rule = FORBIDDEN_IMPORT_RULES.find((r) => r.from === fromZone);
  if (!rule) return null;
  if ((rule.forbiddenTo as readonly string[]).includes(toZone)) {
    return {
      file,
      fromZone,
      importSpec,
      toZone,
      reasonCode: INVARIANT_REASON_CODES.FORBIDDEN_IMPORT,
      reason: rule.reason,
    };
  }
  return null;
}
