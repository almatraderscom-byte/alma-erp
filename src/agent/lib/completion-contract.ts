/**
 * Deterministic completion contract for complex and Mac work.
 *
 * Model text is never completion evidence.  A turn may finish only when every
 * declared criterion has evidence; otherwise the harness must continue within
 * its bounded budget or save an explicit blocker checkpoint.  This module is
 * pure so the owner-turn loop and durable WorkflowRun state can use the exact
 * same verdict without provider-specific judgement.
 */
import type { TurnWorkClass } from '@/agent/config'

export type CompletionCriterionState = 'pending' | 'satisfied' | 'blocked'

export interface CompletionCriterion {
  id: string
  labelBn: string
  state: CompletionCriterionState
  /** A receipt, test result, screenshot URL, or independently-read state. */
  evidence?: string | null
  blocker?: string | null
}

export interface CompletionContract {
  version: 1
  taskRef: string
  taskKind: 'complex' | 'mac'
  workClass: Extract<TurnWorkClass, 'deep' | 'long_run'>
  startedAt: string
  attempt: number
  maxAttempts: number
  criteria: CompletionCriterion[]
}

export function isCompletionContract(value: unknown): value is CompletionContract {
  if (!value || typeof value !== 'object') return false
  const v = value as Partial<CompletionContract>
  return v.version === 1
    && typeof v.taskRef === 'string'
    && (v.taskKind === 'complex' || v.taskKind === 'mac')
    && (v.workClass === 'deep' || v.workClass === 'long_run')
    && typeof v.attempt === 'number'
    && typeof v.maxAttempts === 'number'
    && Array.isArray(v.criteria)
}

export function completionContractFromFacts(
  facts: Record<string, unknown> | null | undefined,
): CompletionContract | null {
  return isCompletionContract(facts?.completionContract) ? facts.completionContract : null
}

export type CompletionDecision =
  | { action: 'complete'; reasonBn: string }
  | { action: 'continue'; reasonBn: string; missing: CompletionCriterion[]; attemptsLeft: number }
  | { action: 'checkpoint'; reasonBn: string; missing: CompletionCriterion[]; blocker: string }

const DEFAULT_ATTEMPTS: Record<CompletionContract['workClass'], number> = {
  deep: 4,
  long_run: 12,
}

export function createCompletionContract(input: {
  taskRef: string
  taskKind: CompletionContract['taskKind']
  workClass: CompletionContract['workClass']
  criteria?: Array<{ id: string; labelBn: string }>
  now?: string
}): CompletionContract {
  const defaults = input.taskKind === 'mac'
    ? [
        { id: 'action_result', labelBn: 'অনুমোদিত Mac action ফল দিয়েছে' },
        { id: 'before_proof', labelBn: 'কাজের আগের marked screenshot আছে' },
        { id: 'after_proof', labelBn: 'কাজের পরের marked screenshot আছে' },
        { id: 'postcondition', labelBn: 'ফল আলাদা করে যাচাই হয়েছে' },
      ]
    : [
        { id: 'scope_executed', labelBn: 'চাওয়া পুরো scope বাস্তবে execute হয়েছে' },
        { id: 'success_criteria', labelBn: 'ঘোষিত success criteria সব মিটেছে' },
        { id: 'independent_proof', labelBn: 'পরীক্ষা/receipt/re-read proof আছে' },
        { id: 'delivery', labelBn: 'ফল বা artifact মালিকের কাছে পৌঁছেছে' },
      ]
  const source = input.criteria?.length ? input.criteria : defaults
  const seen = new Set<string>()
  const criteria = source.filter((c) => {
    const id = c.id.trim()
    if (!id || seen.has(id)) return false
    seen.add(id)
    return true
  }).map((c) => ({ ...c, id: c.id.trim(), state: 'pending' as const }))
  if (!criteria.length) throw new Error('completion_contract_requires_criteria')
  return {
    version: 1,
    taskRef: input.taskRef,
    taskKind: input.taskKind,
    workClass: input.workClass,
    startedAt: input.now ?? new Date().toISOString(),
    attempt: 0,
    maxAttempts: DEFAULT_ATTEMPTS[input.workClass],
    criteria,
  }
}

/**
 * Rebuild a contract from the durable plan on every hop. Plan rows, rather than
 * the previous model's prose, are the resume source of truth.
 */
export function completionContractFromPlanProgress(input: {
  planId: string
  goal: string
  rows: Array<{ seq: number; action: string; status: string }>
  workClass: CompletionContract['workClass']
}): CompletionContract | null {
  if (!input.planId || !input.rows.length) return null
  const rows = [...input.rows].sort((a, b) => a.seq - b.seq)
  const contract = createCompletionContract({
    taskRef: input.planId,
    taskKind: 'complex',
    workClass: input.workClass,
    criteria: rows.map((row) => ({
      id: `step_${row.seq}`,
      labelBn: row.action,
    })),
  })
  return {
    ...contract,
    criteria: contract.criteria.map((criterion, index) => {
      const row = rows[index]
      if (row.status === 'done') {
        return { ...criterion, state: 'satisfied', evidence: `plan:${input.planId}:step:${row.seq}:done` }
      }
      if (row.status === 'failed' || row.status === 'blocked') {
        return {
          ...criterion,
          state: 'blocked',
          blocker: `plan_step_${row.status}:${row.action}`,
        }
      }
      return criterion
    }),
  }
}

export function recordCompletionCriterion(
  contract: CompletionContract,
  input: { id: string; state: CompletionCriterionState; evidence?: string | null; blocker?: string | null },
): CompletionContract {
  let found = false
  const criteria = contract.criteria.map((criterion) => {
    if (criterion.id !== input.id) return criterion
    found = true
    if (input.state === 'satisfied' && !input.evidence?.trim()) {
      throw new Error(`completion_evidence_required:${input.id}`)
    }
    if (input.state === 'blocked' && !input.blocker?.trim()) {
      throw new Error(`completion_blocker_required:${input.id}`)
    }
    return {
      ...criterion,
      state: input.state,
      evidence: input.evidence?.trim() || null,
      blocker: input.blocker?.trim() || null,
    }
  })
  if (!found) throw new Error(`completion_criterion_unknown:${input.id}`)
  return { ...contract, criteria }
}

/** Count one bounded recovery/continue attempt, never beyond the cap. */
export function advanceCompletionAttempt(contract: CompletionContract): CompletionContract {
  return { ...contract, attempt: Math.min(contract.maxAttempts, contract.attempt + 1) }
}

export function decideCompletion(contract: CompletionContract): CompletionDecision {
  const blocked = contract.criteria.find((criterion) => criterion.state === 'blocked')
  const missing = contract.criteria.filter((criterion) => criterion.state !== 'satisfied')
  if (blocked) {
    return {
      action: 'checkpoint',
      reasonBn: `কাজটা শেষ বলা যাবে না — “${blocked.labelBn}” ধাপে blocker আছে।`,
      missing,
      blocker: blocked.blocker || 'explicit_blocker',
    }
  }
  if (!missing.length) {
    return { action: 'complete', reasonBn: 'সব success criterion প্রমাণসহ পূরণ হয়েছে।' }
  }
  const attemptsLeft = Math.max(0, contract.maxAttempts - contract.attempt)
  if (attemptsLeft > 0) {
    return {
      action: 'continue',
      reasonBn: `এখনো ${missing.length}টা criterion বাকি — bounded budget-এর মধ্যে কাজ চালিয়ে যেতে হবে।`,
      missing,
      attemptsLeft,
    }
  }
  return {
    action: 'checkpoint',
    reasonBn: 'Recovery budget শেষ; অসম্পূর্ণ কাজকে done না বলে checkpoint রাখতে হবে।',
    missing,
    blocker: 'completion_recovery_budget_exhausted',
  }
}

/** Compact control note for the next model round; no raw internal reasoning. */
export function completionContinuationNote(decision: CompletionDecision): string {
  if (decision.action === 'complete') return ''
  const missing = decision.missing.map((criterion) => `• ${criterion.id}: ${criterion.labelBn}`).join('\n')
  if (decision.action === 'continue') {
    return `[COMPLETION CONTRACT — continue, do not close]\n${missing}\nAttempts left: ${decision.attemptsLeft}. Gather real evidence; prose is not proof.`
  }
  return `[COMPLETION CONTRACT — checkpoint required]\n${missing}\nBlocker: ${decision.blocker}. Never claim done.`
}
