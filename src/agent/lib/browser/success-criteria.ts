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
