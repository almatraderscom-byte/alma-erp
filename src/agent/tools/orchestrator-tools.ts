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
} from '@/agent/lib/planner'

const delegate_to_specialist: AgentTool = {
  name: 'delegate_to_specialist',
  description:
    'Delegate ONE focused sub-task to a specialist sub-agent that runs with a narrowed, role-appropriate tool set. ' +
    'Use this to break a larger job into pieces — e.g. send data-pulling to "analyst", market/competitor research to "researcher", ' +
    'Facebook/ads planning to "marketer", copy/creative drafting to "content", staff/operations checks to "ops". ' +
    'The sub-agent gathers real data with its tools and returns a concise Bangla summary you can build on. ' +
    'Prefer delegating discrete sub-tasks of multi-step work so each runs focused; keep simple single-step answers yourself.',
  input_schema: {
    type: 'object' as const,
    properties: {
      role: {
        type: 'string',
        enum: SPECIALIST_ROLE_KEYS,
        description: 'Which specialist to delegate to: researcher | analyst | marketer | content | ops',
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
    if (process.env.DELEGATION_APPROVAL === 'true') {
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
    'Execute a previously created plan (by plan_id). Runs steps respecting dependency order. ' +
    'Independent steps run in parallel. If a step fails, execution STOPS and reports the failure. ' +
    'After all steps complete, runs a self-check comparing results against the original goal.',
  input_schema: {
    type: 'object' as const,
    properties: {
      plan_id: {
        type: 'string',
        description: 'The plan ID returned by make_plan',
      },
    },
    required: ['plan_id'],
  },
  handler: async (input) => {
    const planId = String(input.plan_id ?? '').trim()
    if (!planId) return { success: false, error: 'plan_id is required' }

    try {
      const plan = await loadPlan(planId)
      if (!plan) return { success: false, error: `Plan not found: ${planId}` }
      if (plan.status === 'done') {
        return { success: true, data: { status: 'already_done', display: formatPlanForDisplay(plan) } }
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

export const ORCHESTRATOR_TOOLS: AgentTool[] = [delegate_to_specialist, make_plan, execute_plan, get_plan]
