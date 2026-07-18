/**
 * Phase 48 — explicit task success criteria + checkpoints for the browser
 * operator.
 *
 * Rules:
 * - Criteria are declared BEFORE action. A publish/click/log without a
 *   verifiable end-state is not a completed task, it is an attempt.
 * - At completion the runner independently RE-READS the final state (url +
 *   visible text + selectors) and evaluates the criteria — a step log alone
 *   never proves success.
 * - Checkpoints capture url/tab/last-verified-step/artifact/error/next-action
 *   so long work can move to the VPS queue and resume cleanly.
 */

export type SuccessCriterion =
  | { kind: 'url_matches'; pattern: string }
  | { kind: 'selector_exists'; selector: string }
  | { kind: 'text_present'; text: string }
  | { kind: 'text_absent'; text: string }

export interface CriteriaValidation {
  ok: boolean
  errors: string[]
}

const KINDS = new Set(['url_matches', 'selector_exists', 'text_present', 'text_absent'])

/** Structural check: every criterion well-formed, at least one present. */
export function validateCriteria(criteria: unknown): CriteriaValidation {
  const errors: string[] = []
  if (!Array.isArray(criteria) || criteria.length === 0) {
    return { ok: false, errors: ['at least one success criterion is required — no criteria, no verifiable task'] }
  }
  if (criteria.length > 10) errors.push('too many criteria (max 10)')
  for (const [i, c] of criteria.entries()) {
    const raw = c as Record<string, unknown>
    if (!raw || typeof raw !== 'object' || !KINDS.has(String(raw.kind))) {
      errors.push(`criterion[${i}]: unknown kind "${String(raw?.kind)}"`)
      continue
    }
    const kind = String(raw.kind)
    if (kind === 'url_matches') {
      const pattern = String(raw.pattern ?? '')
      if (!pattern) errors.push(`criterion[${i}]: pattern required`)
      else {
        try {
          new RegExp(pattern)
        } catch {
          errors.push(`criterion[${i}]: pattern is not a valid regex`)
        }
      }
    }
    if (kind === 'selector_exists' && !String(raw.selector ?? '').trim()) errors.push(`criterion[${i}]: selector required`)
    if ((kind === 'text_present' || kind === 'text_absent') && !String(raw.text ?? '').trim()) {
      errors.push(`criterion[${i}]: text required`)
    }
  }
  return { ok: errors.length === 0, errors }
}

export interface FinalState {
  url: string
  visibleText: string
  /** Selectors that exist on the final page (runner-evaluated). */
  presentSelectors: string[]
}

export interface CriteriaEvaluation {
  passed: boolean
  results: Array<{ criterion: SuccessCriterion; passed: boolean; detail: string }>
}

/** Independent end-state verification. Pure. */
export function evaluateCriteria(criteria: SuccessCriterion[], state: FinalState): CriteriaEvaluation {
  const results = criteria.map((criterion) => {
    switch (criterion.kind) {
      case 'url_matches': {
        const passed = new RegExp(criterion.pattern).test(state.url)
        return { criterion, passed, detail: passed ? `url "${state.url}" matches` : `url "${state.url}" does not match /${criterion.pattern}/` }
      }
      case 'selector_exists': {
        const passed = state.presentSelectors.includes(criterion.selector)
        return { criterion, passed, detail: passed ? `selector found` : `selector "${criterion.selector}" absent on final page` }
      }
      case 'text_present': {
        const passed = state.visibleText.includes(criterion.text)
        return { criterion, passed, detail: passed ? 'text found' : `text "${criterion.text.slice(0, 60)}" not on final page` }
      }
      case 'text_absent': {
        const passed = !state.visibleText.includes(criterion.text)
        return { criterion, passed, detail: passed ? 'text correctly absent' : `forbidden text "${criterion.text.slice(0, 60)}" IS on final page` }
      }
    }
  })
  return { passed: results.every((r) => r.passed), results }
}

// ── Phase 67: the pre-execution TASK CONTRACT ────────────────────────────────
// Every browser task must declare, BEFORE any action: which domains it may
// touch, whether it is read or write, its success criteria, the actions it must
// never take, and the conditions that hand control to the owner. Each step is
// then checked against this contract — cross-domain navigation, a prohibited
// action, or a handoff trigger stops the autonomous run deterministically.

/** Actions that ALWAYS interrupt to the owner, regardless of task (roadmap). */
export const ALWAYS_HANDOFF_ACTIONS = [
  'password', 'mfa', 'otp', 'captcha', 'account_recovery',
  'permission_grant', 'security_setting', 'legal_accept', 'payment', 'final_submit',
] as const

export interface BrowserTaskContract {
  /** Registrable domains this task may touch (e.g. ['facebook.com']). */
  targetDomains: string[]
  /** Read-only or write-capable — a read task may never take a write action. */
  scope: 'read' | 'write'
  criteria: SuccessCriterion[]
  /** Action ids this task must never take (task-specific prohibitions). */
  prohibitedActions: string[]
  /** Extra owner-handoff triggers on top of ALWAYS_HANDOFF_ACTIONS. */
  ownerHandoffTriggers: string[]
}

/** Reduce a URL/host to its registrable-ish domain for scope comparison. */
export function domainOf(urlOrHost: string): string {
  let host = (urlOrHost ?? '').trim().toLowerCase()
  try {
    if (host.includes('://')) host = new URL(host).hostname
  } catch { /* fall through with raw */ }
  host = host.replace(/^www\./, '').split('/')[0].split(':')[0]
  return host
}

/** A domain is in scope if it equals or is a subdomain of an allowed domain. */
export function domainInScope(domain: string, allowed: string[]): boolean {
  const d = domainOf(domain)
  return allowed.some((a) => {
    const base = domainOf(a)
    return d === base || d.endsWith(`.${base}`)
  })
}

/** Structural validation of the contract (declared before execution). */
export function validateContract(contract: Partial<BrowserTaskContract> | null | undefined): CriteriaValidation {
  const errors: string[] = []
  if (!contract || typeof contract !== 'object') return { ok: false, errors: ['task contract is required before any browser action'] }
  if (!Array.isArray(contract.targetDomains) || contract.targetDomains.length === 0) {
    errors.push('targetDomains: at least one in-scope domain is required')
  }
  if (contract.scope !== 'read' && contract.scope !== 'write') errors.push("scope must be 'read' or 'write'")
  const cv = validateCriteria(contract.criteria)
  if (!cv.ok) errors.push(...cv.errors)
  return { ok: errors.length === 0, errors }
}

export interface StepDecision {
  allowed: boolean
  requiresHandoff: boolean
  reason: string
}

/**
 * Enforce the contract on ONE proposed step. Order matters: cross-domain and
 * prohibited actions BLOCK; always/owner-handoff triggers interrupt to the
 * owner; a write action under a read scope blocks. Pure + deterministic.
 */
export function checkStepAgainstContract(
  contract: BrowserTaskContract,
  step: { domain: string; action: string; isWrite?: boolean },
): StepDecision {
  const action = (step.action ?? '').trim().toLowerCase()

  if (!domainInScope(step.domain, contract.targetDomains)) {
    return { allowed: false, requiresHandoff: false, reason: `cross-domain: ${domainOf(step.domain)} not in task scope` }
  }
  if (contract.prohibitedActions.map((a) => a.toLowerCase()).includes(action)) {
    return { allowed: false, requiresHandoff: false, reason: `prohibited action for this task: ${action}` }
  }
  if (step.isWrite && contract.scope === 'read') {
    return { allowed: false, requiresHandoff: false, reason: 'write action attempted under a read-only task scope' }
  }
  const handoff = new Set<string>([...ALWAYS_HANDOFF_ACTIONS, ...contract.ownerHandoffTriggers.map((a) => a.toLowerCase())])
  if (handoff.has(action)) {
    return { allowed: false, requiresHandoff: true, reason: `owner handoff required for: ${action}` }
  }
  return { allowed: true, requiresHandoff: false, reason: 'in scope' }
}

export interface BrowserCheckpoint {
  url: string | null
  tab: string | null
  lastVerifiedStep: number
  artifact: string | null
  error: string | null
  nextAction: string | null
  savedAt: string
}

/** Build a resumable checkpoint (long work → VPS queue → clean recovery). */
export function buildCheckpoint(input: Partial<Omit<BrowserCheckpoint, 'savedAt'>>): BrowserCheckpoint {
  return {
    url: input.url ?? null,
    tab: input.tab ?? null,
    lastVerifiedStep: Math.max(0, Math.floor(input.lastVerifiedStep ?? 0)),
    artifact: input.artifact ?? null,
    error: input.error ?? null,
    nextAction: input.nextAction ?? null,
    savedAt: new Date().toISOString(),
  }
}

/** Parse a stored checkpoint; null when unusable (forces a fresh start, never a guess). */
export function restoreCheckpoint(raw: string | null | undefined): BrowserCheckpoint | null {
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as BrowserCheckpoint
    if (typeof parsed !== 'object' || parsed === null) return null
    if (!Number.isFinite(parsed.lastVerifiedStep)) return null
    return parsed
  } catch {
    return null
  }
}
