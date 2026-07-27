/**
 * The checklist he can watch tick.
 *
 * Owner, 2026-07-27: *"'৫টার মধ্যে ৩টা শেষ' দেখেন না … এটা UI component হওয়া
 * দরকার, টেক্সট নয়।"*
 *
 * And he is right that what exists today is text: the constitution tells the
 * model to write a small plan for anything over three steps, and the SEO skill
 * literally instructs it to type a markdown checklist. A typed checklist does
 * not change when step 3 finishes.
 *
 * The real thing was already there and simply not on the wire. `AgentPlan` +
 * `AgentPlanStep` store the steps with `status`, `startedAt` and `doneAt`, and
 * `planner.ts` moves them through pending → running → done/failed as work
 * happens. Nothing carried that to the chat.
 *
 * This module is the projection: plan rows → one compact frame the thread can
 * render, plus the "has anything actually changed?" test, because re-sending an
 * identical checklist every tool round is how a live element becomes wallpaper.
 */

export type PlanStepStatus = 'pending' | 'running' | 'done' | 'failed' | 'blocked' | string

export interface PlanStepRow {
  seq: number
  action: string
  status: PlanStepStatus
}

export interface PlanProgress {
  planId: string
  goal: string
  steps: Array<{ seq: number; action: string; status: PlanStepStatus }>
  doneCount: number
  total: number
  /** The one line that answers "কোন পর্যায়ে আছি" without reading the list. */
  headline: string
}

const BN_DIGITS = '০১২৩৪৫৬৭৮৯'
const bn = (n: number): string => String(n).replace(/\d/g, (d) => BN_DIGITS[Number(d)])

/** Steps that count as finished for the "N of M" headline. */
function isDone(status: PlanStepStatus): boolean {
  return status === 'done'
}

export function buildPlanProgress(
  planId: string,
  goal: string,
  rows: PlanStepRow[],
): PlanProgress | null {
  if (!planId || rows.length === 0) return null
  const steps = [...rows].sort((a, b) => a.seq - b.seq)
  const doneCount = steps.filter((s) => isDone(s.status)).length
  const running = steps.find((s) => s.status === 'running')
  const failed = steps.filter((s) => s.status === 'failed').length

  // The headline names what is happening NOW, not just the ratio — "3 of 5"
  // tells him how far, "এখন X" tells him what he is waiting for.
  const where = running ? ` · এখন: ${running.action}` : ''
  const problem = failed > 0 ? ` · ${bn(failed)}টা আটকেছে` : ''
  const headline = `${bn(doneCount)}/${bn(steps.length)} ধাপ শেষ${where}${problem}`

  return { planId, goal, steps, doneCount, total: steps.length, headline }
}

/**
 * Has the checklist changed in a way worth re-sending? Compares the status
 * vector, not the object — a plan row touched by an unrelated write (cost
 * accounting, `updatedAt`) must not re-render the component.
 */
export function planProgressSignature(p: PlanProgress | null): string {
  if (!p) return ''
  return `${p.planId}:${p.steps.map((s) => `${s.seq}${s.status[0]}`).join('')}`
}
