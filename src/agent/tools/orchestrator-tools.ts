/**
 * Orchestrator tools — delegation + explicit planning for multi-step tasks.
 */
import type { AgentTool } from './registry'
import { prisma } from '@/lib/prisma'
import { SPECIALIST_ROLE_KEYS, SPECIALIST_ROLES, type SpecialistRole } from '@/agent/lib/models/specialist-roles'
import type { AgentBusinessId } from '@/lib/agent-api/business-context'
import {
  createPlan,
  loadPlan,
  updatePlanStatus,
  selfCheck,
  formatPlanForDisplay,
  enrollPlanForAutodrive,
} from '@/agent/lib/planner'
import { isAutodriveEnabled } from '@/agent/lib/autodrive-config'
import { scanSignalsToPlanDrive, selectDrivableSignals } from '@/agent/lib/plan-driver/signal-scan'
import { buildOwnerBriefingData } from '@/agent/lib/owner-briefing-data'

// Roles that run directly without an owner "transfer to worker?" card. Marketing
// + content are owner-approved to flow straight to Qwen; their internal money/
// posting steps still hit their own action-level approval gates.
// Exported so the core turn-loop can short-circuit the head's SECOND turn after one
// of these runs (the worker's output is the answer — no need to re-wrap it on Sonnet).
export const AUTO_RUN_ROLES = new Set<SpecialistRole>(['marketer', 'content'])

const delegate_to_specialist: AgentTool = {
  name: 'delegate_to_specialist',
  description:
    'Delegate ONE focused sub-task to a specialist sub-agent that runs with a narrowed, role-appropriate tool set. ' +
    'Use this to break a larger job into pieces — e.g. send data-pulling to "analyst", market/competitor research to "researcher", ' +
    'ALL marketing to "marketer" (it owns marketing end-to-end: Facebook posts, ad campaigns, AND preparing any office-staff ' +
    'task a campaign needs), copy/creative drafting to "content", staff/operations checks to "ops", ' +
    'on-page SEO audits / fix drafts / keyword-rank tracking to "seo". ' +
    'NOTE: "marketer" and "content" run DIRECTLY with no "transfer to worker?" card — just delegate marketing and it happens; ' +
    'their money/posting/dispatch steps still surface their own approval cards. ' +
    'The sub-agent gathers real data with its tools and returns a concise Bangla summary you can build on. ' +
    'Prefer delegating discrete sub-tasks of multi-step work so each runs focused; keep simple single-step answers yourself.',
  input_schema: {
    type: 'object' as const,
    properties: {
      role: {
        type: 'string',
        enum: SPECIALIST_ROLE_KEYS,
        description: 'Which specialist to delegate to: researcher | analyst | marketer | content | ops | seo',
      },
      task: {
        type: 'string',
        description: 'A clear, self-contained brief of exactly what the specialist should do and what to return.',
      },
    },
    required: ['role', 'task'],
  },
  handler: async (input) => {
    const role = String(input.role ?? '') as SpecialistRole
    const task = String(input.task ?? '').trim()
    if (!SPECIALIST_ROLE_KEYS.includes(role)) {
      return { success: false, error: `invalid role: ${role}. Valid: ${SPECIALIST_ROLE_KEYS.join(', ')}` }
    }
    if (!task) return { success: false, error: 'task is required' }

    const businessId = (input.businessId as AgentBusinessId | undefined) ?? 'ALMA_LIFESTYLE'
    const conversationId = typeof input.conversationId === 'string' ? input.conversationId : undefined
    const modelId = typeof input.modelId === 'string' ? input.modelId : undefined

    // Approval gate (test mode, DELEGATION_APPROVAL=true): do NOT run the worker —
    // ask the owner first. The worker starts only after the owner approves the
    // confirm card (handled in /api/assistant/actions/[id]/approve, type 'delegation').
    //
    // EXCEPTION — marketing/content run DIRECTLY (no "transfer to worker?" card).
    // The owner wants Qwen to handle marketing seamlessly, not as a visible
    // sub-agent hop. Safety is unchanged: the money/posting steps inside (publish
    // a post, spend on ads, dispatch a staff task) keep their OWN action-level
    // approval gates — only the redundant delegation card is removed.
    if (process.env.DELEGATION_APPROVAL !== 'false' && !AUTO_RUN_ROLES.has(role)) {
      let modelLabel = 'worker'
      try {
        const { resolveSubagentModel } = await import('@/agent/lib/models/tier-router')
        modelLabel = (await resolveSubagentModel(role)).model.label
      } catch { /* fall back to generic label */ }
      const roleLabel = SPECIALIST_ROLES[role]?.label ?? role
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const db = prisma as any
      const action = await db.agentPendingAction.create({
        data: {
          conversationId: conversationId ?? null,
          businessId,
          type: 'delegation',
          payload: { role, task, businessId, conversationId, modelId },
          summary: `${roleLabel} (${modelLabel}) কে এই কাজ দিয়ে করাব?\n\n${task}`,
        },
      })
      return {
        success: true,
        data: {
          pendingActionId: action.id,
          summary: `${roleLabel} (${modelLabel}) কে transfer করব?`,
          actionType: 'delegation',
          awaitingApproval: true,
        },
      }
    }

    const { runSubAgent } = await import('@/agent/lib/models/subagent')
    const result = await runSubAgent({ role, task, businessId, conversationId, modelId })

    if (!result.success) {
      return { success: false, error: result.error ?? 'sub-agent failed' }
    }
    return {
      success: true,
      data: {
        role: result.role,
        roleLabel: result.roleLabel,
        summary: result.summary,
        toolsUsed: result.toolsUsed,
      },
    }
  },
}

// ── Plan tools ────────────────────────────────────────────────────────────

const make_plan: AgentTool = {
  name: 'make_plan',
  description:
    'Create a structured plan for a complex multi-step task (≥3 steps). ' +
    'Returns an ordered plan with step IDs that the owner can review before execution. ' +
    'Use this INSTEAD of ad-hoc tool-spraying for big tasks (e.g. "Eid campaign full setup", ' +
    '"monthly report + restock + promotion"). Each step can optionally specify a tool and dependencies.',
  input_schema: {
    type: 'object' as const,
    properties: {
      goal: {
        type: 'string',
        description: 'The high-level goal to plan for (Bangla or English)',
      },
      steps: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            action: { type: 'string', description: 'What this step does' },
            tool_name: { type: 'string', description: 'Optional: which tool to call' },
            depends_on: {
              type: 'array',
              items: { type: 'string' },
              description: 'Step IDs this depends on (empty = can run immediately or in parallel)',
            },
          },
          required: ['action'],
        },
        description: 'Ordered list of steps. First step gets id "step-1", second "step-2", etc.',
      },
    },
    required: ['goal', 'steps'],
  },
  handler: async (input) => {
    const goal = String(input.goal ?? '').trim()
    if (!goal) return { success: false, error: 'goal is required' }

    const rawSteps = input.steps as Array<{
      action?: string
      tool_name?: string
      depends_on?: string[]
    }> | undefined
    if (!rawSteps || rawSteps.length < 2) {
      return { success: false, error: 'A plan needs at least 2 steps. For simple tasks, just use tools directly.' }
    }

    const stepIds = rawSteps.map((_, i) => `step-${i + 1}`)
    const steps = rawSteps.map((s, i) => ({
      action: String(s.action ?? `Step ${i + 1}`),
      toolName: s.tool_name ? String(s.tool_name) : undefined,
      dependsOn: (s.depends_on ?? [])
        .map(d => String(d))
        .filter(d => stepIds.includes(d)),
    }))

    const conversationId = typeof input.conversationId === 'string' ? input.conversationId : undefined
    const businessId = (input.businessId as string | undefined) ?? 'ALMA_LIFESTYLE'

    try {
      const plan = await createPlan({ goal, steps, conversationId, businessId })

      const stepsSummary = plan.steps.map((s, i) => ({
        id: stepIds[i],
        dbId: s.id,
        action: s.action,
        tool: s.toolName ?? null,
        depends_on: s.dependsOn,
      }))

      return {
        success: true,
        data: {
          plan_id: plan.id,
          goal: plan.goal,
          status: plan.status,
          steps: stepsSummary,
          total_steps: plan.steps.length,
          display: formatPlanForDisplay(plan),
          message: `Plan তৈরি হয়েছে (${plan.steps.length} steps)। Review করুন, তারপর execute_plan কল করুন।`,
        },
      }
    } catch (err) {
      return { success: false, error: `Plan creation failed: ${err instanceof Error ? err.message : String(err)}` }
    }
  },
}

const execute_plan: AgentTool = {
  name: 'execute_plan',
  description:
    'Execute a previously created plan (by plan_id). When autodrive is ON the plan is ' +
    'enrolled under the autonomous Plan-Driver, which pursues it to completion step by ' +
    'step on its own (and escalates to you if it stalls or hits a cost cap). When autodrive ' +
    'is OFF it falls back to a self-check and you run each ready step yourself. ' +
    'Optionally pass done_criteria — a plain-language "what counts as DONE" the completion ' +
    'gate checks the finished work against.',
  input_schema: {
    type: 'object' as const,
    properties: {
      plan_id: {
        type: 'string',
        description: 'The plan ID returned by make_plan',
      },
      done_criteria: {
        type: 'string',
        description: 'Optional plain-language definition of done — what real outcome means the goal is achieved.',
      },
    },
    required: ['plan_id'],
  },
  handler: async (input) => {
    const planId = String(input.plan_id ?? '').trim()
    if (!planId) return { success: false, error: 'plan_id is required' }
    const doneCriteria = typeof input.done_criteria === 'string' && input.done_criteria.trim()
      ? input.done_criteria.trim()
      : undefined

    try {
      const plan = await loadPlan(planId)
      if (!plan) return { success: false, error: `Plan not found: ${planId}` }
      if (plan.status === 'done') {
        return { success: true, data: { status: 'already_done', display: formatPlanForDisplay(plan) } }
      }

      // Autodrive ON → hand the plan to the autonomous driver and return. The
      // worker tick advances it step by step; the head does not run steps inline.
      if (isAutodriveEnabled()) {
        await enrollPlanForAutodrive(planId, { doneCriteria })
        const updated = await loadPlan(planId)
        return {
          success: true,
          data: {
            plan_id: planId,
            status: updated?.status ?? 'executing',
            autodrive: true,
            display: updated ? formatPlanForDisplay(updated) : plan.goal,
            message: 'Plan স্বয়ংক্রিয় Plan-Driver-এ দেওয়া হলো — ধাপে ধাপে নিজে শেষ করবে, আটকে গেলে বা খরচ সীমায় পৌঁছালে আপনাকে জানাবে।',
          },
        }
      }

      await updatePlanStatus(planId, 'executing')

      const check = selfCheck(plan)
      const statusNote = check.allDone
        ? 'All steps completed successfully.'
        : `${check.completedCount}/${check.totalCount} done.` +
          (check.failedSteps.length > 0 ? ` Failed: ${check.failedSteps.join(', ')}` : '') +
          (check.pendingSteps.length > 0 ? ` Pending: ${check.pendingSteps.join(', ')}` : '')

      await updatePlanStatus(planId, check.allDone ? 'done' : 'approved', statusNote)

      const updatedPlan = await loadPlan(planId)

      return {
        success: true,
        data: {
          plan_id: planId,
          status: updatedPlan?.status ?? 'approved',
          self_check: check,
          display: updatedPlan ? formatPlanForDisplay(updatedPlan) : statusNote,
          message: check.allDone
            ? 'Plan সম্পূর্ণ — সব steps সফল।'
            : `Plan approved। এখন প্রতিটি step tool call দিয়ে execute করুন — ready steps থেকে শুরু করুন।`,
        },
      }
    } catch (err) {
      return { success: false, error: `Plan execution failed: ${err instanceof Error ? err.message : String(err)}` }
    }
  },
}

const get_plan: AgentTool = {
  name: 'get_plan',
  description: 'Retrieve the current status of a plan by ID.',
  input_schema: {
    type: 'object' as const,
    properties: {
      plan_id: { type: 'string', description: 'The plan ID' },
    },
    required: ['plan_id'],
  },
  handler: async (input) => {
    const planId = String(input.plan_id ?? '').trim()
    if (!planId) return { success: false, error: 'plan_id is required' }
    try {
      const plan = await loadPlan(planId)
      if (!plan) return { success: false, error: `Plan not found: ${planId}` }
      const check = selfCheck(plan)
      return {
        success: true,
        data: {
          plan_id: plan.id,
          goal: plan.goal,
          status: plan.status,
          self_check: check,
          display: formatPlanForDisplay(plan),
        },
      }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  },
}

const scan_business_signals: AgentTool = {
  name: 'scan_business_signals',
  description:
    'Proactively scan the business RIGHT NOW for urgent signals — urgent low stock / reorders, ' +
    'high-severity order problems (stuck/pile-up/mismatch), customers whose 24h reply window is ' +
    'closing, and repeat low-performing staff. Use this when the owner asks "কী কী জরুরি / কী দেখা দরকার / ' +
    'নিজে থেকে কাজ ধরো" or wants a proactive sweep. When autodrive is ON, each NEW signal is pulled into ' +
    'the autonomous Plan-Driver (deduped — never a duplicate of an already-active pursuit). When autodrive ' +
    'is OFF this is a read-only preview of what WOULD be pursued. Owner-facing, surface the result in Bangla.',
  input_schema: {
    type: 'object' as const,
    properties: {
      business_id: {
        type: 'string',
        description: "Business scope: 'ALMA_LIFESTYLE' (default) or 'ALMA_TRADING'.",
      },
    },
    required: [],
  },
  handler: async (input) => {
    const businessId = (String(input.business_id ?? '').trim() || 'ALMA_LIFESTYLE') as AgentBusinessId
    try {
      // Autodrive ON → actually enroll the new signals (force past the throttle so a
      // manual "scan now" is responsive; dedup still prevents duplicates).
      if (isAutodriveEnabled()) {
        const res = await scanSignalsToPlanDrive({ businessId, force: true })
        return {
          success: true,
          data: {
            autodrive: true,
            scanned: res.scanned,
            created: res.created,
            message: res.created.length
              ? `${res.created.length}টি নতুন জরুরি কাজ নিজে থেকে Plan-Driver-এ নিলাম — শেষ না হওয়া পর্যন্ত চেষ্টা করব।`
              : 'এই মুহূর্তে নতুন জরুরি signal নেই যেটা এখনো ধরা হয়নি।',
          },
        }
      }

      // Autodrive OFF → read-only preview of what would be pursued.
      const briefing = await buildOwnerBriefingData()
      const signals = selectDrivableSignals(briefing)
      return {
        success: true,
        data: {
          autodrive: false,
          previewOnly: true,
          signals: signals.map((s) => ({ area: s.area, urgency: s.urgency, goal: s.goal })),
          message: signals.length
            ? `${signals.length}টি জরুরি signal পেয়েছি (নিচে)। Autodrive চালু থাকলে এগুলো নিজে থেকে follow-up-এ নিতাম।`
            : 'এই মুহূর্তে জরুরি কোনো signal নেই।',
        },
      }
    } catch (err) {
      return { success: false, error: `Signal scan failed: ${err instanceof Error ? err.message : String(err)}` }
    }
  },
}

const check_owner_silence: AgentTool = {
  name: 'check_owner_silence',
  description:
    'Read-only: check the owner-silence escalation ladder RIGHT NOW. Shows every approval still ' +
    'waiting on the owner, how long the oldest has been unacknowledged, and which rung of the ' +
    'escalation ladder that puts us on (L0 normal reminder → L1 loud alert → L2 critical/call-worthy). ' +
    'Use when the owner asks "কী কী আটকে আছে / কতক্ষণ ধরে / কোন কিছু হারিয়ে যাচ্ছে কিনা". Surfaces ' +
    'the picture only — it never approves or escalates. Owner-facing, answer in Bangla.',
  input_schema: {
    type: 'object' as const,
    properties: {},
    required: [],
  },
  handler: async () => {
    try {
      const { collectPendingItems } = await import('@/agent/lib/pending-followup')
      const { computeSilenceEscalation } = await import('@/agent/lib/owner-silence-ladder')
      const items = await collectPendingItems()
      const esc = computeSilenceEscalation(items, Date.now())
      return {
        success: true,
        data: {
          previewOnly: true,
          level: esc.level,
          levelLabel: esc.levelLabel,
          oldestAgeMin: esc.oldestAgeMin,
          hasCritical: esc.hasCritical,
          callWarranted: esc.callWarranted,
          pending: items.map((i) => ({ label: i.label, ageMin: Math.max(0, Math.floor((Date.now() - i.createdAt.getTime()) / 60_000)) })),
          message: items.length
            ? `${items.length}টি বিষয় আপনার সিদ্ধান্তের অপেক্ষায় — সবচেয়ে পুরোনোটা ~${esc.oldestAgeMin} মিনিট ধরে। ladder এখন ${esc.levelLabel}।`
            : 'এই মুহূর্তে আপনার সিদ্ধান্তের অপেক্ষায় কিছু আটকে নেই — সব পরিষ্কার।',
        },
      }
    } catch (err) {
      return { success: false, error: `Silence check failed: ${err instanceof Error ? err.message : String(err)}` }
    }
  },
}

const check_quiet_hours: AgentTool = {
  name: 'check_quiet_hours',
  description:
    'Read-only: check the quiet-hours / DND (Do-Not-Disturb) state RIGHT NOW. Shows whether DND is ' +
    'enabled, the night window (Dhaka hours), whether we are inside quiet hours this moment, and how ' +
    'many routine pings are HELD in the queue waiting for the morning digest. Use when the owner asks ' +
    '"রাতে কি বিরক্ত করবে / DND চালু আছে কিনা / রাতে কী জমেছে / সকালে কী পাব". During quiet hours routine ' +
    'tier-1/2 pings are held; tier-3 emergencies and salah reminders still pierce DND. Surfaces the ' +
    'picture only — it never sends or flushes. Owner-facing, answer in Bangla.',
  input_schema: {
    type: 'object' as const,
    properties: {},
    required: [],
  },
  handler: async () => {
    try {
      const { quietHoursStatus } = await import('@/agent/lib/quiet-hours')
      const s = await quietHoursStatus()
      const message = !s.enabled
        ? 'DND বন্ধ — এই মুহূর্তে সব notification সরাসরি যাবে, রাতেও।'
        : s.isQuietNow
          ? `এখন quiet hours (${s.windowDhaka}) চলছে — routine ping জমা রাখছি (${s.heldCount}টি), সকালে এক brief-এ পাবেন। জরুরি (tier-3) ও সালাহ reminder এখনই যাবে।`
          : `এখন quiet hours-এর বাইরে — সব notification সরাসরি যাচ্ছে। রাতের window: ${s.windowDhaka}। জমা আছে ${s.heldCount}টি।`
      return {
        success: true,
        data: {
          previewOnly: true,
          enabled: s.enabled,
          windowDhaka: s.windowDhaka,
          isQuietNow: s.isQuietNow,
          heldCount: s.heldCount,
          heldPreview: s.heldPreview,
          message,
        },
      }
    } catch (err) {
      return { success: false, error: `Quiet-hours check failed: ${err instanceof Error ? err.message : String(err)}` }
    }
  },
}

const get_action_cards: AgentTool = {
  name: 'get_action_cards',
  description:
    'Read-only: turn the current business insights into owner-facing ONE-TAP ACTION CARDS. Each card pairs ' +
    'a problem (low stock, stuck/piled-up pending orders, high cancel/return) with ONE recommended action ' +
    'and the exact step the agent would run if you say "do it". Use when the owner asks "আজ কী করা দরকার / ' +
    'এক্ষুনি কী অ্যাকশন নেব / suggestion গুলো action-এ নাও / কোনটা আগে করব". High-urgency cards come first. ' +
    'This only PREVIEWS the cards — nothing executes until the owner picks one (e.g. "১ নম্বরটা করো"). ' +
    'Owner-facing, answer in Bangla.',
  input_schema: {
    type: 'object' as const,
    properties: {
      limit: { type: 'number', description: 'Max cards to return (default 8)' },
    },
    required: [],
  },
  handler: async (input) => {
    try {
      const { getActionCards } = await import('@/agent/lib/action-cards')
      const limit = typeof input.limit === 'number' && input.limit > 0 ? Math.floor(input.limit) : undefined
      const res = await getActionCards({ limit })
      return {
        success: true,
        data: {
          previewOnly: true,
          count: res.cards.length,
          cards: res.cards,
          message: res.summaryBangla,
        },
      }
    } catch (err) {
      return { success: false, error: `Action-cards build failed: ${err instanceof Error ? err.message : String(err)}` }
    }
  },
}

const get_workflow_history: AgentTool = {
  name: 'get_workflow_history',
  description:
    'Step-by-step history of a long workflow run (e.g. client SEO batch) — what happened, in order, ' +
    'from its durable graph checkpoints (LG-8). USE when the owner asks "কী হয়েছিল", "কতদূর হলো", ' +
    '"batch er ki obostha", or wants a post-mortem of a long job. Read-only. ' +
    'Without runId it reports the conversation\'s most recent workflow run.',
  input_schema: {
    type: 'object' as const,
    properties: {
      runId: { type: 'string', description: 'WorkflowRun id (optional — defaults to the most recent run in this conversation)' },
      conversationId: { type: 'string', description: 'Server-managed conversation id — omit; the server fills it automatically.' },
    },
  },
  handler: async (input) => {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const db = prisma as any
      const runId = input.runId ? String(input.runId) : null
      const conversationId = input.conversationId ? String(input.conversationId) : null
      const row = runId
        ? await db.workflowRun.findUnique({ where: { id: runId } })
        : conversationId
          ? await db.workflowRun.findFirst({ where: { conversationId }, orderBy: { updatedAt: 'desc' } })
          : null
      if (!row) {
        return { success: true, data: { found: false, message: 'এই conversation-এ কোনো workflow run পাওয়া যায়নি।' } }
      }
      const { getSeoBatchGraphHistory } = await import('@/agent/lib/graph/seo-batch-graph')
      let steps = await getSeoBatchGraphHistory(String(row.id))
      if (!steps.length) {
        // LG-6 slice 2: template runs (product_post, ad_campaign, …) live in
        // their own graph threads — map onto the same step shape.
        const { getWorkflowRunGraphHistory } = await import('@/agent/lib/graph/workflow-run-graph')
        steps = (await getWorkflowRunGraphHistory(String(row.id))).map((s) => ({
          stateLabel: s.labelBn || s.state,
          eventType: s.cause,
          currentIndex: null,
          checkpointId: s.checkpointId,
          createdAt: s.createdAt,
        }))
      }
      return {
        success: true,
        data: {
          found: true,
          run: {
            id: row.id,
            kind: row.kind,
            status: row.status,
            state: row.state,
            goal: String(row.goal ?? '').slice(0, 300),
            updatedAt: row.updatedAt,
          },
          // Oldest-first for the owner's reading order; [] when the run predates
          // the graph mirror (LG-6 gate off at the time) — say so honestly.
          steps: [...steps].reverse(),
          note: steps.length
            ? null
            : 'এই run-টার ধাপভিত্তিক checkpoint history নেই (পুরনো run বা graph mirror তখন বন্ধ ছিল) — শুধু বর্তমান অবস্থা দেখানো যাচ্ছে।',
        },
      }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  },
}

export const ORCHESTRATOR_TOOLS: AgentTool[] = [delegate_to_specialist, make_plan, execute_plan, get_plan, scan_business_signals, check_owner_silence, check_quiet_hours, get_action_cards, get_workflow_history]
