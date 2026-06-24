/**
 * Phase 6A — Staff manager agent tools.
 * These run in the agent's tool-call loop (Vercel, not worker).
 * The agent proposes/approves tasks; the worker handles dispatch timing.
 *
 * Phase 7: All queries are scoped to `businessId` from the server context
 * (defaults to ALMA_LIFESTYLE). Trading conversations route here too — they
 * just get a Trading-only staff pool and Trading-only pending actions.
 */
import { prisma } from '@/lib/prisma'
import { buildStaffTaskProposal, _resetProfileCache } from '@/agent/lib/staff-task-proposal'
import { buildTradingTaskProposal } from '@/agent/lib/trading-task-proposal'
import {
  syncPendingDispatchAction,
  refreshAndApproveDispatch,
  prepareCorrectedDispatchPending,
  loadProposedTasksForDate,
  buildDispatchSummary,
  getDispatchBreakdownForDate,
  loadPriorActiveTasksForDate,
} from '@/agent/lib/staff-dispatch-sync'
import {
  buildMergeOwnerFocusReply,
  buildApproveResultBangla,
  formatTasksGroupedByStaff,
  makeDispatchSafeDetail,
} from '@/agent/lib/staff-task-format'
import { enforceIslamicGreeting } from '@/agent/lib/islamic-greeting'
import { prepareStaffOutboundMessage } from '@/agent/lib/alma-team-voice'
import {
  announcementContradictsRecentDispatch,
  buildCorrectionNoticeMessage,
  getStaffDispatchCorrectionContext,
} from '@/agent/lib/dispatch-correction-notice'
import type { AgentTool } from './registry'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = prisma as any

/** Mirrors the staff_tasks_type_check DB constraint — any insert outside this set
 * aborts on the check. Used to clamp LLM-supplied task types. */
const ALLOWED_STAFF_TASK_TYPES = new Set<string>([
  'ad_creative', 'product_content', 'product_photo', 'video_reel', 'listing_update',
  'order_followup', 'page_management', 'customer_reply', 'content_support',
  'office_task', 'stock_check', 'misc', 'strategist_directive',
])

// ── Business context helpers ────────────────────────────────────────────────

type BusinessId = 'ALMA_LIFESTYLE' | 'ALMA_TRADING'

/**
 * Resolve businessId from tool input (server context overrides any model value).
 * Returns 'ALMA_LIFESTYLE' as the safe default for legacy callers.
 */
function bizFrom(input: Record<string, unknown> | undefined): BusinessId {
  const raw = input?.businessId
  return raw === 'ALMA_TRADING' ? 'ALMA_TRADING' : 'ALMA_LIFESTYLE'
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function dhakaToday(): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Dhaka' }) // YYYY-MM-DD
}

async function resolveActiveProposalDate(
  explicit: string | undefined,
  businessId: BusinessId,
): Promise<string> {
  if (explicit) return explicit
  const pending = await db.agentPendingAction.findFirst({
    where: { type: 'dispatch_staff_tasks', status: 'pending', businessId },
    orderBy: { createdAt: 'desc' },
    select: { payload: true },
  })
  const payloadDate = (pending?.payload as { date?: string } | null)?.date
  return payloadDate || dhakaToday()
}

async function findStaffByName(staffName: string, businessId: BusinessId) {
  const trimmed = staffName.trim()
  if (!trimmed) return null
  const exact = await db.agentStaff.findFirst({
    where: {
      name: { equals: trimmed, mode: 'insensitive' },
      active: true,
      businessId,
    },
    select: { id: true, name: true },
  })
  if (exact) return exact
  return db.agentStaff.findFirst({
    where: {
      name: { contains: trimmed, mode: 'insensitive' },
      active: true,
      businessId,
    },
    select: { id: true, name: true },
  })
}

function buildStaffMessageDraftSummary(
  staff: Array<{ name: string }>,
  message: string,
  sendVoice: boolean,
  label = 'স্টাফ মেসেজ',
): string {
  const names = staff.map((s) => s.name).join(', ')
  const voiceLine = sendVoice ? 'হ্যাঁ (শুধু স্টাফ)' : 'না'
  const preview = message.length > 1200 ? `${message.slice(0, 1200)}…` : message
  return (
    `📢 ${label} — অনুমোদন প্রয়োজন\n\n` +
    `প্রাপক: ${names}\n` +
    `ভয়েস নোট: ${voiceLine}\n\n` +
    `--- ড্রাফ্ট ---\n${preview}\n---`
  )
}

async function createStaffAnnouncementPending(opts: {
  staff: Array<{ id: string; name: string; telegramChatId: string | null }>
  message: string
  sendVoice: boolean
  conversationId?: string
  label?: string
  businessId: BusinessId
}) {
  const prepared = prepareStaffOutboundMessage(opts.message)
  const summary = buildStaffMessageDraftSummary(
    opts.staff,
    prepared,
    opts.sendVoice,
    opts.label,
  )
  const action = await db.agentPendingAction.create({
    data: {
      conversationId: opts.conversationId ? String(opts.conversationId) : null,
      type: 'staff_announcement',
      businessId: opts.businessId,
      payload: {
        message: prepared,
        staffChatIds: opts.staff.map((s) => ({
          id: s.id,
          name: s.name,
          chatId: s.telegramChatId,
        })),
        sendVoice: opts.sendVoice,
        businessId: opts.businessId,
      },
      summary,
      costEstimate: 0,
      status: 'pending',
    },
  })
  return { pendingActionId: action.id as string, summary, preparedMessage: prepared }
}

// ── prepare_staff_task_proposal ───────────────────────────────────────────────

const prepare_staff_task_proposal: AgentTool = {
  name: 'prepare_staff_task_proposal',
  description:
    'Build a NEW full-team task plan for dispatch (all active staff in the current business). ' +
    'Lifestyle conversation → Lifestyle staff + orders/inventory/marketing focus. ' +
    'Trading conversation → Trading staff + USDT volume/merchant/report focus (Lifestyle staff NEVER included). ' +
    'Use ONLY when owner wants to CREATE/plan/dispatch tasks — NOT when asking what tasks already exist. ' +
    'For status questions ("Eyafi ke ki task dewa hoise") use get_staff_tasks(staffName=...) instead. ' +
    'FIRST announce checking sources, call read tools, THEN this tool.',
  input_schema: {
    type: 'object' as const,
    properties: {
      date: { type: 'string', description: 'YYYY-MM-DD (default: today Dhaka)' },
      saveProposal: { type: 'boolean', description: 'Save tasks as proposed (default true)' },
      createApprovalCard: { type: 'boolean', description: 'Create dispatch confirm card (default true)' },
      conversationId: { type: 'string' },
    },
  },
  handler: async (input) => {
    try {
      const businessId = bizFrom(input)
      const date = (input.date as string) || dhakaToday()
      const save = input.saveProposal !== false
      const createCard = input.createApprovalCard !== false

      // Trading branch — uses TradingAccount/volume/report data.
      if (businessId === 'ALMA_TRADING') {
        const proposal = await buildTradingTaskProposal(date)
        if (!proposal.success) return { success: false, error: proposal.error }

        if (save) {
          await db.agentStaffTask.deleteMany({
            where: { proposedFor: new Date(date), status: 'proposed', businessId },
          })
          await db.agentStaffTask.createMany({
            data: proposal.tasks.map((t) => ({
              staffId: t.staffId,
              businessId,
              title: t.title,
              detail: t.detail ?? null,
              type: t.type,
              source: t.source,
              status: 'proposed',
              proposedFor: new Date(date),
            })),
          })
        }

        let pendingActionId: string | undefined
        if (createCard && save) {
          await db.agentPendingAction.updateMany({
            where: { type: 'dispatch_staff_tasks', status: 'pending', businessId },
            data: { status: 'superseded', resolvedAt: new Date() },
          })
          pendingActionId = (await syncPendingDispatchAction(date, undefined, businessId)) ?? undefined
        }

        return {
          success: true,
          data: {
            businessId,
            date,
            taskCount: proposal.tasks.length,
            tasks: proposal.tasks,
            perStaff: proposal.perStaff,
            summaryBangla: proposal.summaryBangla,
            pendingActionId,
            message:
              'Trading প্রস্তাব তৈরি। Owner Approve করলে worker শুধুমাত্র Trading staff (ALMA_TRADING) এর Telegram-এ পাঠাবে।',
          },
        }
      }

      // Lifestyle branch (existing behaviour).
      const proposal = await buildStaffTaskProposal(date)
      if (!proposal.success) return { success: false, error: proposal.error }

      if (!proposal.tasks.length) {
        return { success: false, error: 'ডেটা থেকে কোনো টাস্ক জেনারেট হয়নি — ERP/অর্ডার চেক করুন' }
      }

      if (save) {
        await db.agentStaffTask.deleteMany({
          where: { proposedFor: new Date(date), status: 'proposed', businessId },
        })
        await db.agentStaffTask.createMany({
          data: proposal.tasks.map((t) => ({
            staffId: t.staffId,
            businessId,
            title: t.title,
            detail: t.detail ?? null,
            type: t.type,
            productRef: t.productRef ?? null,
            source: t.source,
            status: 'proposed',
            proposedFor: new Date(date),
          })),
        })
      }

      let pendingActionId: string | undefined
      if (createCard && save) {
        await db.agentPendingAction.updateMany({
          where: { type: 'dispatch_staff_tasks', status: 'pending', businessId },
          data: { status: 'superseded', resolvedAt: new Date() },
        })
        pendingActionId = (await syncPendingDispatchAction(date, undefined, businessId)) ?? undefined
      }

      return {
        success: true,
        data: {
          businessId,
          date,
          taskCount: proposal.tasks.length,
          tasks: proposal.tasks,
          rotationPicks: proposal.rotationPicks,
          topProducts: proposal.topProducts,
          carryForwardCount: proposal.carryForwardCount,
          pendingOrders: proposal.pendingOrders,
          summaryBangla: proposal.summaryBangla,
          pendingActionId,
          message:
            'প্রস্তাব তৈরি হয়েছে। মালিককে summaryBangla দেখান এবং Approve করতে বলুন — তারপর স্টাফকে Telegram-এ যাবে।',
        },
      }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  },
}

// ── get_staff_tasks ───────────────────────────────────────────────────────────

const get_staff_tasks: AgentTool = {
  name: 'get_staff_tasks',
  description:
    'Returns tasks for a date (default: today) — proposed, sent, approved, done, carried. ' +
    'USE when owner asks what tasks someone HAS (status lookup), e.g. "Eyafi ke ki task dewa hoise". ' +
    'Filter one person with staffName (fuzzy). Shows grouped formattedBangla with sent vs pending sections. ' +
    'Do NOT use prepare_staff_task_proposal for status questions.',
  input_schema: {
    type: 'object' as const,
    properties: {
      date:     { type: 'string', description: 'YYYY-MM-DD (default: today in Asia/Dhaka)' },
      staffId:  { type: 'string', description: 'Filter by staff ID (optional)' },
      staffName: { type: 'string', description: 'Filter by staff name — fuzzy, e.g. Eyafi, Mustahid' },
      statusFilter: { type: 'string', description: 'Comma-separated statuses (default: all except cancelled)' },
    },
  },
  handler: async (input) => {
    try {
      const businessId = bizFrom(input)
      const date = (input.date as string) || dhakaToday()
      const where: Record<string, unknown> = { proposedFor: new Date(date), businessId }

      if (input.staffId) {
        where.staffId = String(input.staffId)
      } else if (input.staffName) {
        const staff = await findStaffByName(String(input.staffName), businessId)
        if (!staff) {
          return { success: false, error: `"${input.staffName}" পাওয়া যায়নি। get_all_staff দিয়ে নাম চেক করুন।` }
        }
        where.staffId = staff.id
      }

      if (input.statusFilter) {
        where.status = { in: String(input.statusFilter).split(',').map((s) => s.trim()) }
      } else {
        where.status = { notIn: ['cancelled'] }
      }

      const tasks = await db.agentStaffTask.findMany({
        where,
        include: { staff: { select: { id: true, name: true, role: true, telegramChatId: true } } },
        orderBy: [{ staffId: 'asc' }, { createdAt: 'asc' }],
      })

      const staffTasks: Record<string, { staff: unknown; tasks: unknown[] }> = {}
      for (const t of tasks) {
        const key = t.staff.id
        if (!staffTasks[key]) staffTasks[key] = { staff: t.staff, tasks: [] }
        staffTasks[key].tasks.push({
          id: t.id, title: t.title, type: t.type, status: t.status,
          detail: t.detail, productRef: t.productRef, source: t.source,
          completedAt: t.completedAt,
        })
      }

      const formattedBangla = formatTasksGroupedByStaff(
        tasks.map((t: { id: string; title: string; type: string; status: string; staff: { name: string } }) => ({
          id: t.id,
          title: t.title,
          type: t.type,
          status: t.status,
          staff: t.staff,
        })),
        {
          header: input.staffName
            ? `📋 ${String(input.staffName)} — ${date}`
            : `📋 স্টাফ টাস্ক — ${date}`,
        },
      )

      const sentPendingCount = tasks.filter((t: { status: string }) => t.status === 'sent').length
      const doneCount = tasks.filter((t: { status: string }) => t.status === 'done').length
      const proposedCount = tasks.filter((t: { status: string }) => t.status === 'proposed').length
      const approvedCount = tasks.filter((t: { status: string }) => t.status === 'approved').length

      return {
        success: true,
        data: {
          date,
          staffFilter: input.staffName ? String(input.staffName) : null,
          totalTasks: tasks.length,
          sentPendingCount,
          doneCount,
          proposedCount,
          approvedCount,
          /** @deprecated use sentPendingCount — sent ≠ done */
          sentOrActiveCount: sentPendingCount + doneCount,
          staffGroups: Object.values(staffTasks),
          formattedBangla,
          message:
            'Owner-কে formattedBangla দেখান। sent=পাঠানো(Done হয়নি), done=সম্পন্ন — গুলিয়ে বলবেন না।',
        },
      }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  },
}

// ── get_all_staff ─────────────────────────────────────────────────────────────

const get_all_staff: AgentTool = {
  name: 'get_all_staff',
  description:
    'Returns all active staff members scoped to the current business (ALMA_LIFESTYLE or ALMA_TRADING) with IDs + Telegram link status. Cross-business staff are NEVER returned.',
  input_schema: { type: 'object' as const, properties: {} },
  handler: async (input) => {
    try {
      const businessId = bizFrom(input)
      const staff = await db.agentStaff.findMany({
        where: { active: true, businessId },
        select: { id: true, name: true, role: true, telegramChatId: true, businessId: true, userId: true },
        orderBy: { name: 'asc' },
      })
      return { success: true, data: staff }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  },
}

// ── propose_staff_tasks ───────────────────────────────────────────────────────

const propose_staff_tasks: AgentTool = {
  name: 'propose_staff_tasks',
  description:
    'Saves a batch of proposed tasks for a given date (status=proposed). ' +
    'Called by the agent during morning planning before the owner approval card. ' +
    'Clears any existing proposed tasks for that date first to avoid duplicates.',
  input_schema: {
    type: 'object' as const,
    properties: {
      date: { type: 'string', description: 'YYYY-MM-DD (default: today in Asia/Dhaka)' },
      tasks: {
        type: 'array',
        description: 'Array of task objects',
        items: {
          type: 'object',
          properties: {
            staffId:    { type: 'string' },
            title:      { type: 'string' },
            detail:     { type: 'string', description: '2–3 line simple Bangla — name tool (Canva/CapCut/Website admin), step-by-step' },
            type:       { type: 'string', enum: ['ad_creative','product_content','product_photo','video_reel','listing_update','order_followup','page_management','customer_reply','content_support','office_task','stock_check','organic_marketing','offer_idea','misc'] },
            productRef: { type: 'string' },
            source:     { type: 'string', enum: ['rotation','pattern','owner','agent'] },
          },
          required: ['staffId', 'title', 'type'],
        },
      },
    },
    required: ['tasks'],
  },
  handler: async (input) => {
    try {
      const businessId = bizFrom(input)
      const date = (input.date as string) || dhakaToday()
      const tasks = input.tasks as Array<{
        staffId: string; title: string; detail?: string;
        type: string; productRef?: string; source?: string;
      }>
      if (!tasks?.length) return { success: false, error: 'tasks array is empty' }

      // Clear existing proposed tasks for this date (only proposed — don't touch approved/sent)
      await db.agentStaffTask.deleteMany({
        where: { proposedFor: new Date(date), status: 'proposed', businessId },
      })

      const created = await db.agentStaffTask.createMany({
        data: tasks.map(t => ({
          staffId:    t.staffId,
          businessId,
          title:      t.title,
          detail:     t.detail ?? null,
          type:       t.type || 'misc',
          productRef: t.productRef ?? null,
          source:     t.source || 'agent',
          status:     'proposed',
          proposedFor: new Date(date),
        })),
      })

      const pendingActionId = await syncPendingDispatchAction(date, undefined, businessId)

      return {
        success: true,
        data: {
          date,
          tasksCreated: created.count,
          pendingActionId: pendingActionId ?? undefined,
          message: pendingActionId
            ? 'Tasks saved and pending dispatch card synced from DB.'
            : 'Tasks saved (no pending card — call approve_and_dispatch_tasks if needed).',
        },
      }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  },
}

// ── merge_into_proposal ───────────────────────────────────────────────────────

const merge_into_proposal: AgentTool = {
  name: 'merge_into_proposal',
  description:
    'Add/edit/remove tasks in the ACTIVE unapproved proposal — never discard existing tasks. ' +
    'MUST persist via this tool (not text-only lists). Re-show full updated list for approval. ' +
    'When owner adds for ONE staff only, other staff proposed tasks stay unchanged — explain prior sent vs new per person (ownerFocusBangla). ' +
    'Before approve: get_current_proposal to verify DB matches what owner saw. Use add_staff_task_now only when NO active proposal.',
  input_schema: {
    type: 'object' as const,
    properties: {
      date: { type: 'string', description: 'YYYY-MM-DD of the active proposal (default: pending proposal date)' },
      staffName: { type: 'string', description: 'Which staff member the task is for' },
      additions: {
        type: 'array',
        description: 'New tasks to append',
        items: {
          type: 'object',
          properties: {
            title: { type: 'string' },
            detail: { type: 'string' },
            type: { type: 'string', description: 'One of: ad_creative, product_content, product_photo, video_reel, listing_update, order_followup, page_management, customer_reply, content_support, office_task, stock_check, strategist_directive, misc (default misc)' },
          },
          required: ['title'],
        },
      },
      edits: {
        type: 'array',
        description: 'Edits to existing proposed tasks',
        items: {
          type: 'object',
          properties: {
            taskId: { type: 'string' },
            newTitle: { type: 'string' },
            newDetail: { type: 'string' },
          },
          required: ['taskId'],
        },
      },
      removeTaskIds: {
        type: 'array',
        items: { type: 'string' },
        description: 'Task IDs to remove from the proposal',
      },
    },
    required: ['staffName'],
  },
  handler: async (input) => {
    try {
      const businessId = bizFrom(input)
      const date = await resolveActiveProposalDate(input.date as string | undefined, businessId)
      const staffName = String(input.staffName)
      const staff = await findStaffByName(staffName, businessId)
      if (!staff) return { success: false, error: `Staff "${staffName}" not found in ${businessId}.` }

      const additions = (input.additions ?? []) as Array<{ title: string; detail?: string; type?: string }>
      const edits = (input.edits ?? []) as Array<{ taskId: string; newTitle?: string; newDetail?: string }>
      const removeTaskIds = (input.removeTaskIds ?? []) as string[]

      if (!additions.length && !edits.length && !removeTaskIds.length) {
        return { success: false, error: 'No additions, edits, or removals specified.' }
      }

      const beforeProposed = await loadProposedTasksForDate(date, businessId)
      const beforeIds = new Set(beforeProposed.map((t) => t.id))

      if (additions.length) {
        await db.agentStaffTask.createMany({
          data: additions.map((t) => ({
            staffId: staff.id,
            businessId,
            title: t.title,
            detail: t.detail ?? null,
            // type/source must satisfy the staff_tasks_type_check / _source_check DB
            // constraints. An LLM-supplied type outside the allowed set (e.g. the old
            // "learning"/"custom" hint) would abort the insert, so clamp to 'misc'.
            type: ALLOWED_STAFF_TASK_TYPES.has(t.type ?? '') ? t.type : 'misc',
            status: 'proposed',
            proposedFor: new Date(date),
            source: 'owner',
          })),
        })
      }

      for (const e of edits) {
        const patch: Record<string, string> = {}
        if (e.newTitle) patch.title = e.newTitle
        if (e.newDetail) patch.detail = e.newDetail
        if (Object.keys(patch).length) {
          await db.agentStaffTask.updateMany({
            where: {
              id: e.taskId,
              staffId: staff.id,
              status: 'proposed',
              proposedFor: new Date(date),
              businessId,
            },
            data: patch,
          })
        }
      }

      if (removeTaskIds.length) {
        await db.agentStaffTask.deleteMany({
          where: {
            id: { in: removeTaskIds },
            staffId: staff.id,
            status: 'proposed',
            proposedFor: new Date(date),
            businessId,
          },
        })
      }

      const staffTasks = await db.agentStaffTask.findMany({
        where: { staffId: staff.id, status: 'proposed', proposedFor: new Date(date), businessId },
        select: { id: true, title: true, detail: true, type: true },
        orderBy: { createdAt: 'asc' },
      })

      const allProposed = await loadProposedTasksForDate(date, businessId)
      const newTaskIds = allProposed.filter((t) => !beforeIds.has(t.id)).map((t) => t.id)
      const newCountForStaff = allProposed.filter(
        (t) => !beforeIds.has(t.id) && t.staff.name === staff.name,
      ).length

      const priorActive = await loadPriorActiveTasksForDate(date, businessId)
      const allStaffNames = [
        ...new Set([
          ...priorActive.map((t) => t.staff.name),
          ...allProposed.map((t) => t.staff.name),
        ]),
      ]

      const summaryBangla = await buildDispatchSummary(
        date,
        allProposed,
        { changedStaff: staff.name, newTaskIds },
        businessId,
      )

      const ownerFocusBangla = buildMergeOwnerFocusReply(
        staff.name,
        newCountForStaff,
        priorActive,
        allStaffNames,
      )

      const pendingActionId = await syncPendingDispatchAction(
        date,
        { changedStaff: staff.name, newTaskIds },
        businessId,
      )

      return {
        success: true,
        data: {
          status: 'merged',
          date,
          staffName: staff.name,
          staffTasks,
          allTasks: allProposed.map((t) => ({
            id: t.id,
            staffName: t.staff.name,
            title: t.title,
            type: t.type,
          })),
          taskCount: allProposed.length,
          newTaskIds,
          newCountForStaff,
          ownerFocusBangla,
          summaryBangla,
          pendingActionId,
          message:
            `Proposal updated for ${staff.name}. Show ownerFocusBangla first, then approval card (summaryBangla). ` +
            `Other staff unchanged — do NOT say you assigned new tasks to them.`,
        },
      }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  },
}

// ── approve_pending_dispatch ──────────────────────────────────────────────────

const approve_pending_dispatch: AgentTool = {
  name: 'approve_pending_dispatch',
  description:
    'Approve the CURRENTLY pending staff-task dispatch so the worker actually sends it. ' +
    'Use when the owner says "approve", "পাঠাও", "approve korlam", "হ্যাঁ পাঠাও" AND a dispatch_staff_tasks ' +
    'pending action already exists. This flips it to approved so the worker dispatches. ' +
    'Do NOT create a new proposal/card when one is already pending — approve the existing one.',
  input_schema: {
    type: 'object' as const,
    properties: {
      date: { type: 'string', description: 'YYYY-MM-DD (default: from pending action or today Dhaka)' },
    },
  },
  handler: async (input) => {
    try {
      const businessId = bizFrom(input)
      const date = (input.date as string) || undefined
      const pending = await db.agentPendingAction.findFirst({
        where: { type: 'dispatch_staff_tasks', status: 'pending', businessId },
        orderBy: { createdAt: 'desc' },
        select: { payload: true },
      })
      const payload = pending?.payload as { date?: string } | undefined
      const actionDate = date || payload?.date || dhakaToday()

      if (payload?.date && date && payload.date !== date) {
        return {
          success: false,
          error: `Pending dispatch is for ${payload.date}, not ${date}. Approve that date or omit date.`,
        }
      }

      const result = await refreshAndApproveDispatch(actionDate, undefined, businessId)
      if (!result.ok) {
        return {
          success: true,
          data: {
            status: 'none_pending',
            message: 'কোনো proposed টাস্ক নেই। আগে merge_into_proposal বা propose_staff_tasks চালান।',
          },
        }
      }

      const breakdown = await getDispatchBreakdownForDate(result.date, businessId)
      const summaryBangla = buildApproveResultBangla(breakdown, result.taskCount)

      return {
        success: true,
        data: {
          status: 'approved_queued',
          approvedActionId: result.pendingActionId,
          date: result.date,
          taskCount: result.taskCount,
          taskIds: result.taskIds,
          breakdown,
          summaryBangla,
          message:
            `${summaryBangla} Worker dispatch করবে — আগে পাঠানো টাস্ক "সম্পন্ন/done" বলবেন না যতক্ষণ status=done না।`,
        },
      }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  },
}

// ── get_dispatch_status ───────────────────────────────────────────────────────

const get_dispatch_status: AgentTool = {
  name: 'get_dispatch_status',
  description:
    'Check REAL staff task status for a date. taskCounts by DB status (sent=পাঠানো Done হয়নি, done=সম্পন্ন). ' +
    'deliveryByStaff = Telegram messages delivered (NOT task completion). Use BEFORE claiming tasks sent/done.',
  input_schema: {
    type: 'object' as const,
    properties: {
      date: { type: 'string', description: 'YYYY-MM-DD (default: today Dhaka)' },
    },
  },
  handler: async (input) => {
    try {
      const businessId = bizFrom(input)
      const date = (input.date as string) || dhakaToday()
      const proposedFor = new Date(date)

      const statusRows = await db.agentStaffTask.groupBy({
        by: ['status'],
        where: { proposedFor, businessId },
        _count: { _all: true },
      })

      const taskCounts: Record<string, number> = {}
      for (const row of statusRows as Array<{ status: string; _count: { _all: number } }>) {
        taskCounts[row.status] = row._count._all
      }

      let deliveryByStaff: Record<string, { delivered: number; failed: number }> | null = null
      try {
        const dayStart = new Date(`${date}T00:00:00+06:00`)
        const rows = await db.agentOutbox.findMany({
          where: { type: 'task_dispatch', createdAt: { gte: dayStart } },
          select: { staffName: true, status: true },
        })
        const byStaff: Record<string, { delivered: number; failed: number }> = {}
        for (const r of rows as Array<{ staffName: string | null; status: string }>) {
          const name = r.staffName ?? '—'
          byStaff[name] ??= { delivered: 0, failed: 0 }
          if (r.status === 'delivered') byStaff[name].delivered++
          if (r.status === 'failed') byStaff[name].failed++
        }
        deliveryByStaff = byStaff
      } catch {
        deliveryByStaff = null
      }

      const pendingAction = await db.agentPendingAction.findFirst({
        where: { type: 'dispatch_staff_tasks', businessId },
        orderBy: { createdAt: 'desc' },
        select: { status: true, createdAt: true },
      })

      const correctionContext = await getStaffDispatchCorrectionContext(date)
      const breakdown = await getDispatchBreakdownForDate(date, businessId)

      return {
        success: true,
        data: {
          date,
          taskCounts,
          breakdown,
          pendingActionStatus: pendingAction?.status ?? 'none',
          pendingActionCreatedAt: pendingAction?.createdAt ?? null,
          deliveryByStaff,
          correctionContext,
          statusRules: {
            sent: 'পাঠানো — স্টাফের কাছে আছে, Done হয়নি (সম্পন্ন নয়)',
            done: 'সম্পন্ন — স্টাফ Done চেপেছে',
            proposed: 'প্রস্তাবিত — approve হলে পাঠাবে',
            outboxDelivered: 'Telegram মেসেজ পৌঁছেছে — টাস্ক সম্পন্ন নয়',
          },
          correctionNoticeRule:
            'After wrong-task correction: call send_dispatch_correction_notice (reads outbox). ' +
            'Never say "নতুন লিস্ট শীঘ্রই আসবে" if correctionContext shows new_already_sent.',
          note: deliveryByStaff === null
            ? 'Outbox not available — rely on task status counts; Staff Monitor for delivery proof.'
            : 'deliveryByStaff = Telegram messages only. Task completion = taskCounts.done.',
        },
      }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  },
}

// ── get_lunch_status ──────────────────────────────────────────────────────────

const get_lunch_status: AgentTool = {
  name: 'get_lunch_status',
  description:
    'Who is on lunch today (45min allowance) and completed records. Flag repeated overruns in staff reports — occasional overrun kindly. ' +
    'Use when owner asks "ke lunch e ache?" or lunch patterns.',
  input_schema: {
    type: 'object' as const,
    properties: {
      date: { type: 'string', description: 'YYYY-MM-DD (default: today Dhaka)' },
    },
  },
  handler: async (input) => {
    try {
      const businessId = bizFrom(input)
      const date = (input.date as string) || dhakaToday()
      const now = Date.now()

      const rows = await db.staffLunch.findMany({
        where: { lunchDate: date, businessId },
        orderBy: { startedAt: 'desc' },
        select: {
          staffId: true,
          staffName: true,
          startedAt: true,
          endedAt: true,
          durationMin: true,
          overage: true,
        },
      })

      const onLunch = rows
        .filter((r: { endedAt: Date | null }) => !r.endedAt)
        .map((r: { staffName: string | null; startedAt: Date }) => {
          const mins = Math.round((now - new Date(r.startedAt).getTime()) / 60000)
          return {
            name: r.staffName ?? '—',
            minutes: mins,
            overAllowance: mins > 45,
            critical: mins >= 60,
          }
        })

      const completed = rows
        .filter((r: { endedAt: Date | null }) => r.endedAt)
        .map((r: { staffName: string | null; durationMin: number | null; overage: boolean }) => ({
          name: r.staffName ?? '—',
          durationMin: r.durationMin,
          overage: r.overage,
        }))

      return {
        success: true,
        data: {
          date,
          currentlyOnLunch: onLunch,
          completedToday: completed,
          summaryBangla:
            onLunch.length === 0
              ? `আজ (${date}) কেউ লাঞ্চে নেই।`
              : onLunch
                  .map(
                    (s: { name: string; minutes: number; overAllowance: boolean }) =>
                      `${s.name}: ${s.minutes} মিনিট${s.overAllowance ? ' (৪৫+)' : ''}`,
                  )
                  .join('; '),
        },
      }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  },
}

// ── get_current_proposal ──────────────────────────────────────────────────────

const get_current_proposal: AgentTool = {
  name: 'get_current_proposal',
  description:
    'Returns the ACTUAL proposed tasks saved in DB for a date — this is what will be dispatched on approve. ' +
    'Call after merge_into_proposal and BEFORE approve_pending_dispatch to verify the list matches what you showed the owner.',
  input_schema: {
    type: 'object' as const,
    properties: {
      date: { type: 'string', description: 'YYYY-MM-DD (default: today Dhaka)' },
    },
  },
  handler: async (input) => {
    try {
      const businessId = bizFrom(input)
      const date = (input.date as string) || dhakaToday()
      const proposed = await loadProposedTasksForDate(date, businessId)
      const byStaff: Record<string, Array<{ id: string; title: string; type: string }>> = {}
      for (const t of proposed) {
        const name = t.staff.name
        byStaff[name] ??= []
        byStaff[name].push({ id: t.id, title: t.title, type: t.type })
      }
      return {
        success: true,
        data: {
          date,
          totalTasks: proposed.length,
          byStaff,
          summaryBangla: await buildDispatchSummary(date, proposed, undefined, businessId),
          note: 'This DB snapshot is dispatched on approve — never show the owner a list you have not saved via merge_into_proposal / propose_staff_tasks.',
        },
      }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  },
}

// ── correct_and_redispatch_staff_tasks ────────────────────────────────────────

const correct_and_redispatch_staff_tasks: AgentTool = {
  name: 'correct_and_redispatch_staff_tasks',
  description:
    'Wrong tasks were already sent. Cancels sent/approved tasks for the date and creates a PENDING dispatch approval card ' +
    'from the CURRENT proposed list in DB — does NOT send to staff until the owner explicitly approves. ' +
    'Use when owner says "ভুল টাস্ক গেছে", "আগেরটা বাদ দিয়ে ঠিকটা পাঠাও". ' +
    'Correct proposed tasks MUST already be in DB (merge_into_proposal / propose_staff_tasks) before calling. ' +
    'After calling, show the full list and wait for approve_pending_dispatch — never auto-dispatch.',
  input_schema: {
    type: 'object' as const,
    properties: {
      date: { type: 'string', description: 'YYYY-MM-DD (default: today Dhaka)' },
    },
  },
  handler: async (input) => {
    try {
      const businessId = bizFrom(input)
      const date = (input.date as string) || dhakaToday()
      const proposed = await loadProposedTasksForDate(date, businessId)
      if (!proposed.length) {
        return {
          success: false,
          error: 'DB-তে proposed টাস্ক নেই। আগে merge_into_proposal দিয়ে সঠিক তালিকা সেভ করুন।',
        }
      }

      const result = await prepareCorrectedDispatchPending(date, businessId)
      if (!result.ok) {
        return { success: false, error: 'Redispatch prep failed — no proposed tasks after cancel.' }
      }

      return {
        success: true,
        data: {
          status: 'correction_pending_approval',
          date,
          pendingActionId: result.pendingActionId,
          cancelledWrongTasks: result.cancelledCount,
          proposedTaskCount: result.proposedCount,
          taskIds: result.taskIds,
          summaryBangla: result.summaryBangla,
          message:
            `${result.cancelledCount}টি ভুল টাস্ক cancelled। ${result.proposedCount}টি সঠিক টাস্ক approval card-এ তৈরি — ` +
            'এখনো পাঠানো হয়নি। মালিক Approve/পাঠাও বললে approve_pending_dispatch চালান। ' +
            '"পাঠানো হয়েছে" বলবেন না — get_dispatch_status দিয়ে verify করুন।',
        },
      }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  },
}

// ── approve_and_dispatch_tasks ────────────────────────────────────────────────

const approve_and_dispatch_tasks: AgentTool = {
  name: 'approve_and_dispatch_tasks',
  description:
    'Creates a NEW pending approval card for proposed tasks. ' +
    'If a dispatch_staff_tasks card is ALREADY pending, do NOT use this — use approve_pending_dispatch instead. ' +
    'Use after propose_staff_tasks when no pending dispatch card exists yet.',
  input_schema: {
    type: 'object' as const,
    properties: {
      date:           { type: 'string', description: 'YYYY-MM-DD (default: today)' },
      conversationId: { type: 'string' },
    },
  },
  handler: async (input) => {
    try {
      const businessId = bizFrom(input)
      const date = (input.date as string) || dhakaToday()
      const proposed = await db.agentStaffTask.findMany({
        where: { proposedFor: new Date(date), status: 'proposed', businessId },
        include: { staff: { select: { name: true } } },
      })
      if (!proposed.length) return { success: false, error: `No proposed tasks found for ${date}` }

      const existingPending = await db.agentPendingAction.findFirst({
        where: { type: 'dispatch_staff_tasks', status: 'pending', businessId },
        orderBy: { createdAt: 'desc' },
        select: { id: true },
      })
      if (existingPending) {
        return {
          success: false,
          error:
            'A pending dispatch card already exists. Use approve_pending_dispatch when the owner approves in chat — do NOT create another card.',
          pendingActionId: existingPending.id as string,
        }
      }

      // Resolve any stale pending dispatch actions
      await db.agentPendingAction.updateMany({
        where: { type: 'dispatch_staff_tasks', status: 'pending', businessId },
        data: { status: 'superseded', resolvedAt: new Date() },
      })

      const summary = proposed
        .map((t: { staff: { name: string }; title: string; type: string }) =>
          `• ${t.staff.name}: ${t.title} (${t.type})`)
        .join('\n')

      const action = await db.agentPendingAction.create({
        data: {
          conversationId: input.conversationId ? String(input.conversationId) : null,
          type:     'dispatch_staff_tasks',
          businessId,
          payload:  { date, taskIds: proposed.map((t: { id: string }) => t.id), businessId },
          summary:  `স্টাফ টাস্ক ডিসপ্যাচ — ${date}\n\n${summary}`,
          costEstimate: 0,
          status:   'pending',
        },
      })

      return {
        success: true,
        data: {
          pendingActionId: action.id as string,
          summary:  action.summary,
          taskCount: proposed.length,
          status: 'queued_for_dispatch',
          message:
            'Tasks queued. Delivery to each staff is confirmed by the worker — do NOT tell the owner "sent" until the worker confirmation arrives. If asked, say tasks are queued and confirmation is pending.',
        },
      }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  },
}

// ── add_staff_task_now ─────────────────────────────────────────────────────────

const add_staff_task_now: AgentTool = {
  name: 'add_staff_task_now',
  description:
    'Adds a single task to today\'s list for a staff member mid-day when there is NO active unapproved proposal. ' +
    'If a pending staff proposal exists, use merge_into_proposal instead. ' +
    'Creates a PENDING ACTION — owner must approve before the task is saved and the staff member is notified.',
  input_schema: {
    type: 'object' as const,
    properties: {
      staffId:        { type: 'string', description: 'Staff member ID' },
      title:          { type: 'string', description: 'Task title (Bangla preferred)' },
      type:           { type: 'string', enum: ['ad_creative','product_content','stock_check','listing_update','order_followup','misc'] },
      detail:         { type: 'string', description: 'Optional task detail' },
      conversationId: { type: 'string' },
    },
    required: ['staffId', 'title', 'type'],
  },
  handler: async (input) => {
    try {
      const businessId = bizFrom(input)
      const staffId = String(input.staffId)
      const staff = await db.agentStaff.findFirst({
        where: { id: staffId, businessId },
        select: { name: true, businessId: true },
      })
      if (!staff) {
        return { success: false, error: `Staff ${staffId} not found in ${businessId}.` }
      }

      const summary = `${staff.name}-কে নতুন টাস্ক যোগ: "${input.title}" (${input.type})`

      const action = await db.agentPendingAction.create({
        data: {
          conversationId: input.conversationId ? String(input.conversationId) : null,
          type:     'add_staff_task_now',
          businessId,
          payload:  {
            staffId, staffName: staff.name,
            title: String(input.title),
            type:  String(input.type),
            detail: input.detail ? String(input.detail) : null,
            date:  dhakaToday(),
            businessId,
          },
          summary,
          costEstimate: 0,
          status:  'pending',
        },
      })

      return {
        success: true,
        data: { pendingActionId: action.id as string, summary, message: 'Pending owner approval.' },
      }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  },
}

// ── send_dispatch_correction_notice ───────────────────────────────────────────

const send_dispatch_correction_notice: AgentTool = {
  name: 'send_dispatch_correction_notice',
  description:
    'After wrong-task correction: prepare correction notice DRAFT for staff (pending Approve). ' +
    'Reads agent_outbox — if a new task_dispatch was ALREADY delivered (even 1 min ago), ' +
    'tells staff to follow THAT list (never "coming soon"). ' +
    'Call AFTER approve_pending_dispatch + get_dispatch_status confirms delivery. ' +
    'Does NOT send until owner approves via approve_pending_staff_message. ' +
    'Do NOT use send_staff_announcement for this — this tool verifies outbox first.',
  input_schema: {
    type: 'object' as const,
    properties: {
      date: { type: 'string', description: 'YYYY-MM-DD (default: today Dhaka)' },
      staffIds: {
        type: 'array',
        items: { type: 'string' },
        description: 'Limit to specific staff (optional — default: staff with task_dispatch today)',
      },
      sendVoice: { type: 'boolean', description: 'TTS voice note (default: true)' },
    },
  },
  handler: async (input) => {
    try {
      const businessId = bizFrom(input)
      const date = (input.date as string) || dhakaToday()
      const staffIds = input.staffIds as string[] | undefined
      const sendVoice = input.sendVoice !== false

      const ctx = await getStaffDispatchCorrectionContext(date, staffIds)
      if (!ctx.length) {
        return {
          success: false,
          error: 'আজ কোনো task_dispatch outbox নেই — আগে approve_pending_dispatch + get_dispatch_status দিয়ে verify করুন।',
        }
      }

      const staffRows = await db.agentStaff.findMany({
        where: {
          active: true,
          businessId,
          telegramChatId: { not: null },
          id: {
            in: ctx.map((c) => c.staffId).filter((id): id is string => Boolean(id)),
          },
        },
        select: { id: true, name: true, telegramChatId: true },
      })

      const staffById = new Map(staffRows.map((s: { id: string }) => [s.id, s]))
      const messageGroups = new Map<string, typeof staffRows>()

      for (const c of ctx) {
        if (!c.staffId) continue
        const row = staffById.get(c.staffId)
        if (!row) continue
        const message = enforceIslamicGreeting(buildCorrectionNoticeMessage(c.staffName, c.situation))
        const bucket = messageGroups.get(message) ?? []
        bucket.push(row)
        messageGroups.set(message, bucket)
      }

      if (!messageGroups.size) {
        return { success: false, error: 'No Telegram-linked staff found for correction notice.' }
      }

      const sent: Array<{ messagePreview: string; staff: string[]; situation: string; pendingActionId: string }> = []
      for (const [message, group] of messageGroups) {
        const { pendingActionId, summary } = await createStaffAnnouncementPending({
          staff: group,
          message,
          sendVoice,
          conversationId: input.conversationId as string | undefined,
          label: 'ডিসপ্যাচ সংশোধন নোটিশ',
          businessId,
        })
        const sample = ctx.find((c) => c.staffId === group[0]?.id)
        sent.push({
          messagePreview: message.slice(0, 80),
          staff: group.map((s: { name: string }) => s.name),
          situation: sample?.situation ?? 'unknown',
          pendingActionId,
        })
      }

      return {
        success: true,
        data: {
          status: 'pending_approval',
          pendingActionId: sent[0]?.pendingActionId,
          pendingActionIds: sent.map((s) => s.pendingActionId),
          date,
          drafts: sent,
          correctionContext: ctx,
          message:
            `${sent.length}টি correction notice draft তৈরি — এখনো পাঠানো হয়নি। ` +
            'মালিক প্রতিটি Approve করলে পাঠানো হবে (approve_pending_staff_message বা Approve বাটন)।',
        },
      }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  },
}

// ── send_staff_announcement ───────────────────────────────────────────────────

const send_staff_announcement: AgentTool = {
  name: 'send_staff_announcement',
  description:
    'Prepare a staff announcement/news/notice DRAFT (text + optional voice to STAFF only). ' +
    'Creates a PENDING confirm card — does NOT send until owner approves. ' +
    'NOT a task — no Done buttons, no completion tracking. ' +
    'Use for: rule changes, policy updates, office notices, reminders, personal messages to staff. ' +
    'Write from ALMA team voice ("আমরা/ALMA টিম"), never as owner proxy. ' +
    'After draft, wait for Approve — never say "পাঠানো হয়েছে" before approval + outbox proof. ' +
    'Do NOT use for wrong-task correction notices — use send_dispatch_correction_notice instead. ' +
    'Do NOT use this for work assignments — use propose_staff_tasks or add_staff_task_now for those.',
  input_schema: {
    type: 'object' as const,
    properties: {
      message: {
        type: 'string',
        description: 'The announcement message in Bangla. Will be sent as text AND voice note.',
      },
      staffIds: {
        type: 'array',
        items: { type: 'string' },
        description: 'Specific staff IDs to send to (optional — if empty, sends to ALL active staff with Telegram linked)',
      },
      sendVoice: {
        type: 'boolean',
        description: 'Also send as voice note via TTS (default: true)',
      },
    },
    required: ['message'],
  },
  handler: async (input) => {
    try {
      const message = String(input.message ?? '').trim()
      if (!message) return { success: false, error: 'message is required' }

      const businessId = bizFrom(input)
      const sendVoice = input.sendVoice !== false
      const staffIds = input.staffIds as string[] | undefined
      const date = dhakaToday()

      const contradiction = await announcementContradictsRecentDispatch(message, date, staffIds)
      if (contradiction.blocked) {
        return { success: false, error: contradiction.reason }
      }

      const where: Record<string, unknown> = {
        active: true,
        businessId,
        telegramChatId: { not: null },
      }
      if (staffIds?.length) {
        where.id = { in: staffIds }
      }

      const staff = await db.agentStaff.findMany({
        where,
        select: { id: true, name: true, telegramChatId: true },
      })

      if (!staff.length) {
        return {
          success: true,
          data: {
            status: 'no_staff',
            message: `No active staff with Telegram linked found in ${businessId}.`,
          },
        }
      }

      const { pendingActionId, summary } = await createStaffAnnouncementPending({
        staff,
        message,
        sendVoice,
        conversationId: input.conversationId as string | undefined,
        businessId,
      })

      return {
        success: true,
        data: {
          status: 'pending_approval',
          pendingActionId,
          summary,
          recipients: staff.map((s: { name: string }) => s.name),
          count: staff.length,
          voiceIncluded: sendVoice,
          message:
            'ড্রাফ্ট তৈরি হয়েছে — মালিক Approve করলে পাঠানো হবে। "পাঠানো হয়েছে" বলবেন না।',
        },
      }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  },
}

// ── update_staff_task_status ──────────────────────────────────────────────────

const update_staff_task_status: AgentTool = {
  name: 'update_staff_task_status',
  description:
    'Updates the status of a specific task (e.g., mark done, cancel, carry). ' +
    'No confirm card needed — use for agent-driven status tracking.',
  input_schema: {
    type: 'object' as const,
    properties: {
      taskId:  { type: 'string', description: 'Task ID' },
      status:  { type: 'string', enum: ['approved','sent','done','carried','cancelled'] },
    },
    required: ['taskId', 'status'],
  },
  handler: async (input) => {
    try {
      const updated = await db.agentStaffTask.update({
        where: { id: String(input.taskId) },
        data: {
          status: String(input.status),
          ...(input.status === 'done' ? { completedAt: new Date() } : {}),
        },
        select: { id: true, title: true, status: true },
      })
      return { success: true, data: updated }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  },
}

// ── get_marketing_history ─────────────────────────────────────────────────────

const get_marketing_history: AgentTool = {
  name: 'get_marketing_history',
  description:
    'Returns the last promotion date for each product. ' +
    'Use in morning planning to detect products not promoted in 30+ days.',
  input_schema: {
    type: 'object' as const,
    properties: {
      business:     { type: 'string', description: 'Filter by business name (optional)' },
      notSinceDays: { type: 'number', description: 'Only products not promoted in N days (default: 30)' },
    },
  },
  handler: async (input) => {
    try {
      const days   = Number(input.notSinceDays ?? 30)
      const cutoff = new Date(Date.now() - days * 86400 * 1000)
      const where: Record<string, unknown> = { lastPromotedAt: { lt: cutoff } }
      if (input.business) where.business = String(input.business)

      const rows = await db.agentProductMarketingHistory.findMany({
        where,
        orderBy: { lastPromotedAt: 'asc' },
        take: 50,
      })
      return { success: true, data: { cutoffDays: days, products: rows } }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  },
}

// ── update_staff_task_profile ────────────────────────────────────────────────

const update_staff_task_profile: AgentTool = {
  name: 'update_staff_task_profile',
  description:
    'Updates a staff member\'s task profile — what tasks they should or should not get. ' +
    'Owner says things like "Mustahid কে delivery task দিবি না" → remove that skill. ' +
    'Changes take immediate effect on the next proposal.',
  input_schema: {
    type: 'object' as const,
    properties: {
      staffName:      { type: 'string', description: 'Staff member name (fuzzy match)' },
      addSkills:      { type: 'array', items: { type: 'string' }, description: 'Skills to add' },
      removeSkills:   { type: 'array', items: { type: 'string' }, description: 'Skills to remove' },
      dailyTargetTasks: { type: 'number', description: 'New daily task target count' },
      notes:          { type: 'string', description: 'Updated notes about the staff member' },
    },
    required: ['staffName'],
  },
  handler: async (input) => {
    try {
      const staffName = String(input.staffName).trim()
      const existing = await db.agentKvSetting.findUnique({ where: { key: 'staff_task_profiles' } })
      const profiles = (existing?.value as Record<string, { skills: string[]; dailyTargetTasks: number; notes: string }>) ?? {}

      let matchedKey: string | null = null
      for (const key of Object.keys(profiles)) {
        if (key.toLowerCase().includes(staffName.toLowerCase()) || staffName.toLowerCase().includes(key.toLowerCase())) {
          matchedKey = key
          break
        }
      }
      if (!matchedKey) matchedKey = staffName

      const current = profiles[matchedKey] ?? { skills: [], dailyTargetTasks: 6, notes: '' }

      const addSkills = (input.addSkills as string[]) ?? []
      const removeSkills = (input.removeSkills as string[]) ?? []
      const newSkills = [...new Set([...current.skills, ...addSkills].filter((s) => !removeSkills.includes(s)))]

      profiles[matchedKey] = {
        skills: newSkills,
        dailyTargetTasks: (input.dailyTargetTasks as number) ?? current.dailyTargetTasks,
        notes: (input.notes as string) ?? current.notes,
      }

      await db.agentKvSetting.upsert({
        where: { key: 'staff_task_profiles' },
        create: { key: 'staff_task_profiles', value: profiles },
        update: { value: profiles },
      })

      _resetProfileCache()

      return {
        success: true,
        data: { staffName: matchedKey, profile: profiles[matchedKey] },
        message: `${matchedKey}-এর প্রোফাইল আপডেট হয়েছে। পরবর্তী টাস্ক প্রস্তাবে এই পরিবর্তন কার্যকর হবে।`,
      }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  },
}

// ── approve_pending_staff_message ─────────────────────────────────────────────

const approve_pending_staff_message: AgentTool = {
  name: 'approve_pending_staff_message',
  description:
    'Owner approved a pending staff_announcement draft (message/notice to staff). ' +
    'Flips pending → approved so the worker sends via Telegram. ' +
    'Use when owner says approve/পাঠাও/হ্যাঁ for a staff message draft — NOT for task dispatch (use approve_pending_dispatch).',
  input_schema: {
    type: 'object' as const,
    properties: {
      pendingActionId: { type: 'string', description: 'Specific pending action id (optional — uses latest staff_announcement)' },
    },
  },
  handler: async (input) => {
    try {
      const businessId = bizFrom(input)
      const explicitId = input.pendingActionId as string | undefined
      const row = explicitId
        ? await db.agentPendingAction.findUnique({ where: { id: explicitId } })
        : await db.agentPendingAction.findFirst({
            where: { type: 'staff_announcement', status: 'pending', businessId },
            orderBy: { createdAt: 'desc' },
          })

      if (!row || row.type !== 'staff_announcement') {
        return { success: false, error: 'কোনো pending staff message draft পাওয়া যায়নি।' }
      }
      if (explicitId && row.businessId && row.businessId !== businessId) {
        return {
          success: false,
          error: `Pending message is for ${row.businessId}, not ${businessId}. Cross-business approval blocked.`,
        }
      }
      if (row.status !== 'pending') {
        return {
          success: true,
          data: {
            status: 'already_resolved',
            pendingActionId: row.id,
            currentStatus: row.status,
            message: `ইতিমধ্যে ${row.status} — নতুন draft লাগলে send_staff_announcement আবার চালান।`,
          },
        }
      }

      await db.agentPendingAction.update({
        where: { id: row.id },
        data: { status: 'approved', resolvedAt: new Date() },
      })

      return {
        success: true,
        data: {
          status: 'approved_queued',
          pendingActionId: row.id as string,
          message:
            'Approve হয়েছে — worker স্টাফকে পাঠাবে। নিশ্চিত হওয়ার আগে "পাঠানো হয়েছে" বলবেন না; Staff Monitor দেখুন।',
        },
      }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  },
}

// ── set_staff_leave ───────────────────────────────────────────────────────────

const set_staff_leave: AgentTool = {
  name: 'set_staff_leave',
  description:
    'Record leave/sick days — on leave: NOT absent, fined, coached, tasked, or in completion stats. ' +
    'Use for "Mustahid kal chhuti", "3 din sick". Check list_staff_leave before assigning tasks.',
  input_schema: {
    type: 'object' as const,
    properties: {
      staffName: { type: 'string' },
      startDate: { type: 'string', description: 'YYYY-MM-DD' },
      endDate: { type: 'string', description: 'YYYY-MM-DD (same as start for one day)' },
      type: { type: 'string', enum: ['leave', 'sick', 'half_day'] },
      reason: { type: 'string' },
    },
    required: ['staffName', 'startDate', 'endDate'],
  },
  handler: async (input) => {
    try {
      const businessId = bizFrom(input)
      const staff = await findStaffByName(input.staffName as string, businessId)
      if (!staff) {
        return { success: false, error: `"${input.staffName}" পাওয়া যায়নি।` }
      }
      const startDate = input.startDate as string
      const endDate = input.endDate as string
      await db.staffLeave.create({
        data: {
          staffId: staff.id,
          staffName: staff.name,
          businessId,
          startDate,
          endDate,
          type: (input.type as string) ?? 'leave',
          reason: (input.reason as string) ?? null,
          status: 'approved',
          approvedBy: 'owner',
        },
      })
      return {
        success: true,
        data: {
          status: 'saved',
          message: `${staff.name} এর ছুটি রেকর্ড হয়েছে (${startDate} – ${endDate})। ঐ দিনগুলোতে absent/fine/task হবে না।`,
        },
      }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  },
}

// ── list_staff_leave ──────────────────────────────────────────────────────────

const list_staff_leave: AgentTool = {
  name: 'list_staff_leave',
  description: 'List upcoming/active staff leave. Use when owner asks "ke chhuti te ache", or before planning tasks.',
  input_schema: { type: 'object' as const, properties: {} },
  handler: async (input) => {
    try {
      const businessId = bizFrom(input)
      const today = dhakaToday()
      const rows = await db.staffLeave.findMany({
        where: { status: 'approved', endDate: { gte: today }, businessId },
        orderBy: { startDate: 'asc' },
      })
      return {
        success: true,
        data: {
          count: rows.length,
          leave: rows.map((r: {
            staffName: string | null
            startDate: string
            endDate: string
            type: string
            reason: string | null
          }) => ({
            name: r.staffName,
            startDate: r.startDate,
            endDate: r.endDate,
            type: r.type,
            reason: r.reason,
          })),
        },
      }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  },
}

// ── explain_staff_task_bangla ─────────────────────────────────────────────────
// C2: staff task EXPLAINING — a NEW capability. The agent generates a clear,
// personalized Bangla "how to do this" breakdown using the SAME Gemini model the
// agent already uses for staff verification (gemini-2.5-flash, good Bangla, cheap
// — keeps this off Claude). Owner-approval gated: the explanation only reaches the
// staff member's office view (অফিস) AFTER the owner approves the draft. Dispatch /
// sending stays on the existing gated paths — this tool never sends anything.

const STAFF_TASK_EXPLAIN_TOOL_HINT: Record<string, string> = {
  video_reel: 'CapCut',
  ad_creative: 'Canva',
  product_content: 'Canva / FB',
  product_photo: 'ফোন ক্যামেরা',
  listing_update: 'Website admin',
  order_followup: 'ERP + ফোন/মেসেঞ্জার',
  page_management: 'FB Page admin',
  customer_reply: 'Messenger',
  stock_check: 'ERP inventory',
}

async function buildStaffTaskExplanation(opts: {
  staffName: string
  title: string
  type: string
  detail: string | null
  productRef: string | null
  extraContext?: string
  conversationId?: string | null
}): Promise<string> {
  const { geminiGenerateText } = await import('@/agent/lib/gemini-text')
  const toolHint = STAFF_TASK_EXPLAIN_TOOL_HINT[opts.type] ?? 'ERP'
  const prompt = [
    'তুমি ALMA টিমের একজন সহকারী ম্যানেজার। নিচের কাজটি একজন স্টাফকে খুব সহজ বাংলায় বুঝিয়ে দাও —',
    'যেন কম শিক্ষিত স্টাফও পড়ে নিজে নিজে করতে পারে।',
    '',
    `স্টাফের নাম: ${opts.staffName}`,
    `কাজ: ${opts.title}`,
    `ধরন: ${opts.type}`,
    opts.productRef ? `প্রোডাক্ট: ${opts.productRef}` : '',
    opts.detail ? `আগের নোট: ${opts.detail}` : '',
    opts.extraContext ? `বাড়তি নির্দেশ: ${opts.extraContext}` : '',
    '',
    'নিয়ম:',
    `- ৩–৪ লাইনের বেশি নয়। প্রতিটি লাইন ছোট ও পরিষ্কার ধাপ।`,
    `- কোন অ্যাপ/টুল দিয়ে করবে স্পষ্ট বলো (এই কাজে: ${toolHint})।`,
    '- জটিল শব্দ নয়, ইংরেজি কম। শেষে proof/Done-এর কথা মনে করিয়ে দাও।',
    '- কোনো হারাম পণ্য/ছবির ইঙ্গিত নয়। শুধু কাজের ধাপ লেখো, ভূমিকা বা অভিবাদন নয়।',
  ]
    .filter(Boolean)
    .join('\n')

  const text = await geminiGenerateText({
    prompt,
    costLabel: 'staff_task_explain',
    maxTokens: 400,
    temperature: 0.4,
    conversationId: opts.conversationId,
  })
  // Keep it to at most 4 non-empty lines so the office view (buildStaffFriendlyDetail)
  // renders it verbatim instead of falling back to a template.
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(0, 4)
    .join('\n')
}

const explain_staff_task_bangla: AgentTool = {
  name: 'explain_staff_task_bangla',
  description:
    'Write a clear, personalized Bangla "how to do it" explanation directly into ONE OR MORE staff tasks. ' +
    'Accepts a single `taskId` or a `taskIds` array — explain many at once. Uses Gemini (cheap, good Bangla), NOT Claude. ' +
    'The explanation is saved straight into each task\'s `detail`, so it rides WITH the task automatically: ' +
    'it shows in the staff member\'s অফিস (office) view and goes out on the SINGLE dispatch approval. ' +
    'It does NOT create a per-task approval card and NEVER sends a Telegram message — so there is no "16 cards" problem ' +
    'and no separate approve step. Use when the owner says "এই কাজগুলো বুঝিয়ে দে / staff ke explain kore de". ' +
    'After this, the owner only needs to approve the dispatch once and the explanations travel with the tasks.',
  input_schema: {
    type: 'object' as const,
    properties: {
      taskId: { type: 'string', description: 'A single staff task id to explain' },
      taskIds: {
        type: 'array',
        items: { type: 'string' },
        description: 'Multiple staff task ids to explain in one call (no per-task card — all ride with dispatch)',
      },
      extraContext: {
        type: 'string',
        description: 'Optional extra instruction from the owner about how the task(s) should be done',
      },
    },
  },
  handler: async (input) => {
    try {
      const businessId = bizFrom(input)
      const taskIds = [
        ...(Array.isArray(input.taskIds) ? (input.taskIds as unknown[]).map((x) => String(x)) : []),
        ...(input.taskId ? [String(input.taskId)] : []),
      ]
        .map((s) => s.trim())
        .filter(Boolean)
      const uniqueIds = [...new Set(taskIds)]
      if (!uniqueIds.length) return { success: false, error: 'taskId বা taskIds লাগবে।' }

      const extraContext = input.extraContext ? String(input.extraContext) : undefined
      const conversationId = input.conversationId ? String(input.conversationId) : null

      const explained: Array<{ taskId: string; staffName: string; title: string; detail: string }> = []
      const skipped: Array<{ taskId: string; reason: string }> = []

      for (const taskId of uniqueIds) {
        const task = await db.agentStaffTask.findUnique({
          where: { id: taskId },
          select: {
            id: true,
            title: true,
            detail: true,
            type: true,
            productRef: true,
            status: true,
            businessId: true,
            staff: { select: { id: true, name: true } },
          },
        })
        if (!task) {
          skipped.push({ taskId, reason: 'not_found' })
          continue
        }
        if (task.businessId && task.businessId !== businessId) {
          skipped.push({ taskId, reason: 'cross_business' })
          continue
        }

        const explanation = await buildStaffTaskExplanation({
          staffName: task.staff?.name ?? 'স্টাফ',
          title: task.title,
          type: task.type,
          detail: task.detail,
          productRef: task.productRef,
          extraContext,
          conversationId,
        })

        // Persist straight into `detail` so it rides with the task and survives the
        // dispatch-time regeneration (makeDispatchSafeDetail guarantees that). No card.
        const safeDetail = makeDispatchSafeDetail(
          { title: task.title, type: task.type, productRef: task.productRef },
          explanation,
        )
        if (!safeDetail) {
          skipped.push({ taskId, reason: 'empty_explanation' })
          continue
        }
        await db.agentStaffTask.update({ where: { id: task.id }, data: { detail: safeDetail } })
        explained.push({
          taskId: task.id,
          staffName: task.staff?.name ?? 'স্টাফ',
          title: task.title,
          detail: safeDetail,
        })
      }

      const summaryLines = [
        `🧠 ${explained.length}টি টাস্ক বুঝিয়ে দেওয়া হয়েছে — ব্যাখ্যা এখন task-এর detail-এ আছে।`,
        ...explained.slice(0, 8).map((e) => `• ${e.staffName}: ${e.title}`),
        explained.length > 8 ? `…আরও ${explained.length - 8}টি` : '',
        '',
        'আলাদা করে approve করার দরকার নেই — dispatch একবার approve করলেই explanation সহ task স্টাফের কাছে যাবে।',
      ].filter(Boolean)

      return {
        success: true,
        data: {
          explainedCount: explained.length,
          skippedCount: skipped.length,
          explained,
          skipped,
          ridesWithTask: true,
          summary: summaryLines.join('\n'),
          message: explained.length
            ? 'ব্যাখ্যা প্রতিটি task-এর detail-এ লেখা হয়েছে — dispatch approve করলেই একসাথে যাবে। আলাদা কোনো card নেই।'
            : 'কোনো task explain করা যায়নি (পাওয়া যায়নি বা ভিন্ন business)।',
        },
      }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  },
}

export const STAFF_TOOLS: AgentTool[] = [
  prepare_staff_task_proposal,
  get_all_staff,
  get_staff_tasks,
  propose_staff_tasks,
  merge_into_proposal,
  approve_pending_dispatch,
  approve_pending_staff_message,
  get_dispatch_status,
  get_lunch_status,
  set_staff_leave,
  list_staff_leave,
  get_current_proposal,
  correct_and_redispatch_staff_tasks,
  approve_and_dispatch_tasks,
  add_staff_task_now,
  send_dispatch_correction_notice,
  send_staff_announcement,
  update_staff_task_status,
  get_marketing_history,
  update_staff_task_profile,
  explain_staff_task_bangla,
]
