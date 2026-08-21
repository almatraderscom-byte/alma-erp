/**
 * Plan before work, on a big job — owner ask 2026-07-26.
 *
 * *"ami jodi tmk ei seo audit fix korte ditam, tmi age etar jnne nije ekta full
 * plan ready korte, erpor amk ek sathe ei full fix er jnne tmr joto question ba
 * approve lagle … age theke confirm hoye … erpor tmi sei plan moto nije step by
 * step kaj sesh korte."*
 *
 * What he watched instead: a big SEO job dribbled out as twenty-to-thirty-second
 * fragments, each ending in another approval card, with no plan he could see.
 * His complaint is not that it asks — it is that it asks piecemeal, forever.
 *
 * So: the FIRST turn of a big job is a planning turn. One message with the whole
 * shape and every decision needed, then it stops. He answers once. After that it
 * executes without asking again.
 *
 * The guarantee is not the wording. On a planning turn the staging and write
 * tools are simply not in the head's hands — the same lever that made listen
 * mode and the chat modes hold. It cannot half-start the work while "planning".
 *
 * Deliberately narrow: only the FIRST deep-work turn of a conversation that has
 * never staged anything. The moment a card exists, planning is over and this
 * never fires again in that chat.
 */
import { prisma } from '@/lib/prisma'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = prisma as any

/** Tools a planning turn must NOT hold — anything that stages or changes work. */
export const PLAN_TURN_WITHHELD = new Set([
  'draft_seo_fixes',
  'update_product_web',
  'publish_product',
  'unpublish_product',
  'set_product_featured',
  'submit_to_indexnow',
  'schedule_content',
  'schedule_content_batch',
  'draft_marketing_campaign',
  'launch_campaign',
  'dispatch_staff_tasks',
  'send_customer_message',
  'execute_plan',
])

export function filterToolsForPlanTurn<T extends { name: string }>(tools: T[]): {
  tools: T[]
  removed: string[]
} {
  const kept = tools.filter((t) => !PLAN_TURN_WITHHELD.has(t.name))
  return { tools: kept, removed: tools.filter((t) => PLAN_TURN_WITHHELD.has(t.name)).map((t) => t.name) }
}

/**
 * Pick the deterministic tool binding for a provider round.
 *
 * A prospective plan is control state for the whole job, so until it succeeds
 * it must outrank a workflow/contract tool that would otherwise start doing one
 * piece of the work before the owner has seen the checklist. Once the plan
 * exists, the caller passes `null` and ordinary binding resumes unchanged.
 */
export function chooseRoundBoundTool(input: {
  iteration: number
  planTool: string | null
  contractTool: string | null
  workflowTool: string | null
}): string | null {
  if (input.planTool) return input.planTool
  if (input.contractTool) return input.contractTool
  return input.iteration === 0 ? input.workflowTool : null
}

export function shouldInjectProspectivePlanTool(input: {
  planFirst: boolean
  planSatisfied: boolean
  lastBudgetRound: boolean
  shippedToolNames: Iterable<string>
}): boolean {
  return input.planFirst
    && !input.planSatisfied
    && !input.lastBudgetRound
    && !new Set(input.shippedToolNames).has('make_plan')
}

/**
 * A provider may emit ordinary text before honoring a forced `make_plan` call.
 * That text is pre-plan draft material: it has no tool evidence yet and showing
 * it makes a complete-looking reply appear, disappear, and later persist beside
 * the real verified answer. Keep it private; the next round can speak after the
 * durable prospective plan is visible.
 */
export function shouldWithholdProspectivePlanRoundProse(
  boundToolName: string | null,
): boolean {
  return boundToolName === 'make_plan'
}

/**
 * Provider tool-choice support is advisory in practice: compatible endpoints
 * have returned siblings and duplicate named calls beside a forced make_plan.
 * The controller therefore accepts exactly one plan-control call and rejects
 * everything else before any business executor or owner-facing tool event.
 */
export function partitionProspectivePlanCalls<T extends { name: string }>(
  calls: T[],
  prospectivePlanRound: boolean,
): { accepted: T[]; rejected: T[] } {
  if (!prospectivePlanRound) return { accepted: calls, rejected: [] }
  const accepted: T[] = []
  const rejected: T[] = []
  for (const call of calls) {
    if (call.name === 'make_plan' && accepted.length === 0) accepted.push(call)
    else rejected.push(call)
  }
  return { accepted, rejected }
}

export function prospectivePlanExitText(trackerVisible: boolean): string {
  return trackerVisible
    ? '⚠️ Step tracker তৈরি হয়েছে, কিন্তু এই turn-এর round limit শেষে কাজ শুরু হয়নি—কোনো business action চালাইনি। আবার চেষ্টা করুন।'
    : '⚠️ Plan তৈরি হয়েছে, কিন্তু step tracker verify করা যায়নি—তাই কোনো কাজ শুরু করিনি। আবার চেষ্টা করুন।'
}

export type ProspectivePlanToolInput = {
  goal: string
  steps: Array<{
    action: string
    tool_name?: string
    depends_on?: string[]
  }>
}

function cleanProspectiveStep(value: string): string {
  return value
    .replace(/^\s*(?:step\s*)?[0-9০-৯]+\s*[:.)–—-]?\s*/i, '')
    .replace(/\.\s+(?:then|do\s+not|don't|never|এরপর|তারপর)\b[\s\S]*$/i, '.')
    .trim()
}

/**
 * Weak tool-calling heads occasionally send the plan under `plan`, use
 * `{ step, description }`, or omit the goal even though the owner supplied an
 * exact numbered checklist. The `make_plan` handler correctly rejects those
 * malformed arguments, but a plan-first turn must not then fall back to a list
 * of failed tool calls pretending to be the requested plan.
 *
 * Normalize only the prospective-plan control call. Valid schema-shaped input
 * is preserved, while an explicit numbered owner checklist is the authoritative
 * recovery source. This changes no business data and invents no completed work.
 */
export function normalizeProspectivePlanInput(
  raw: unknown,
  ownerInstructions: string,
): ProspectivePlanToolInput {
  const input = raw && typeof raw === 'object' && !Array.isArray(raw)
    ? raw as Record<string, unknown>
    : {}
  const rawSteps = Array.isArray(input.steps)
    ? input.steps
    : Array.isArray(input.plan) ? input.plan : []
  const normalized = rawSteps.flatMap((entry) => {
    if (typeof entry === 'string') {
      const action = cleanProspectiveStep(entry)
      return action ? [{ action }] : []
    }
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return []
    const row = entry as Record<string, unknown>
    const action = cleanProspectiveStep(String(
      row.action ?? row.step ?? row.description ?? '',
    ))
    if (!action) return []
    const tool = String(row.tool_name ?? row.toolName ?? '').trim()
    const rawDeps = row.depends_on ?? row.dependsOn
    const deps = Array.isArray(rawDeps)
      ? rawDeps.map((value: unknown) => String(value).trim()).filter(Boolean)
      : []
    return [{
      action,
      ...(tool && tool !== 'none' ? { tool_name: tool } : {}),
      ...(deps.length ? { depends_on: deps } : {}),
    }]
  })

  let steps = normalized
  if (steps.length < 2) {
    const numbered: Array<{ action: string }> = []
    const numberedPattern = /(?:^|[;\n:]\s*)(?:step\s*)?([1-9১-৯])[.)]?\s+(.+?)(?=(?:\s*;\s*|\n+)\s*(?:step\s*)?[1-9১-৯][.)]?\s+|$)/gi
    for (const match of ownerInstructions.matchAll(numberedPattern)) {
      const action = cleanProspectiveStep(match[2] ?? '')
      if (action) numbered.push({ action })
    }
    if (numbered.length >= 2) steps = numbered
  }

  if (steps.length < 2) {
    const clauses = ownerInstructions
      .split(/\s*(?:;|\n|\bthen\b|তারপর|এরপর)\s*/i)
      .map(cleanProspectiveStep)
      .filter((value) => value.length >= 3)
    if (clauses.length >= 2) steps = clauses.map((action) => ({ action }))
  }

  // A forced plan call should never create an unbounded wall of model-authored
  // rows. Two through eight mirrors the native dock's useful checklist scale.
  steps = steps.slice(0, 8)
  const goal = String(input.goal ?? input.title ?? '').trim()
    || ownerInstructions.trim().slice(0, 240)
    || 'Requested multi-step work'
  return { goal, steps }
}

/**
 * Is this the planning turn for a big job?
 *
 * Requires ALL of: Boss asked for deep/whole-scope work, and this conversation
 * has never staged a pending action. Reading tools stay available, because a
 * plan written without looking at the real numbers is worthless — he wants the
 * scope counted, not guessed.
 */
export async function isPlanFirstTurn(input: {
  conversationId: string
  deepWork: boolean
}): Promise<boolean> {
  if (!input.deepWork) return false
  try {
    const staged = await db.agentPendingAction.count({ where: { conversationId: input.conversationId } })
    return staged === 0
  } catch {
    // Fail open to normal work: a DB hiccup must never block Boss's job behind a
    // planning turn he did not ask for.
    return false
  }
}

/**
 * The contract for a planning turn. Explicit about the ONE thing he was most
 * annoyed by — being asked again later for things that could have been settled
 * here.
 */
export function planFirstNote(): string {
  return (
    '[SERVER REQUIREMENT — planning turn]\n'
    + '• এটা বড় কাজ, আর এটা তোমার **পরিকল্পনার টার্ন**। এই টার্নে কোনো কাজ শুরু কোরো না, '
    + 'কোনো approval card বানিও না — ওই টুলগুলো এখন তোমার হাতেই নেই।\n'
    + '• আগে পড়ার টুল দিয়ে **আসল মাপটা নাও** (কতগুলো, কোনগুলো) — অনুমানে প্ল্যান লিখো না।\n'
    + '• তারপর একটা মেসেজেই দাও: (১) ধাপে ধাপে প্ল্যান, (২) মোট কত সময়/কত ব্যাচ লাগবে, '
    + '(৩) Boss-এর কাছ থেকে তোমার **সব** প্রশ্ন ও অনুমতি একসাথে — পরে আর জিজ্ঞেস করার সুযোগ নেই ধরে নাও।\n'
    + '• পরিকল্পনাটা শুধু prose-এ লিখে থেমো না — make_plan দিয়ে durable ধাপ বানাও, যাতে Boss এখনই tracker-এ পুরো তালিকা দেখতে পান।\n'
    + '• Boss একবার সায় দিলে তুমি পুরো প্ল্যান নিজে শেষ করবে, প্রতিটা ধাপের পর সংক্ষেপে জানাবে, '
    + 'আর ছোট ছোট বিষয়ে বারবার অনুমতি চাইবে না।'
  )
}
