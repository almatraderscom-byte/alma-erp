import { type NextRequest } from 'next/server'
import { getToken } from 'next-auth/jwt'
import { timingSafeEqual } from 'crypto'
import { requireAgentEnabled } from '@/agent/lib/guards'
import { isSystemOwner } from '@/lib/roles'
import { prisma } from '@/lib/prisma'
import { createPagePost, verifyPost, resolvePageId } from '@/agent/lib/meta'

export const runtime = 'nodejs'
export const maxDuration = 30

function verifyInternalToken(provided: string): boolean {
  const expected = process.env.AGENT_INTERNAL_TOKEN ?? ''
  if (!expected || !provided) return false
  try {
    const a = Buffer.from(expected, 'utf8')
    const b = Buffer.from(provided, 'utf8')
    if (a.length !== b.length) return false
    return timingSafeEqual(a, b)
  } catch { return false }
}

export async function POST(
  req: NextRequest,
  { params }: { params: { id: string } },
) {
  const disabled = requireAgentEnabled()
  if (disabled) return disabled

  const authHeader = req.headers.get('authorization') ?? ''
  const bearerToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : ''
  if (!verifyInternalToken(bearerToken)) {
    const token = await getToken({ req, secret: process.env.NEXTAUTH_SECRET })
    if (!token?.sub) return Response.json({ error: 'unauthorized' }, { status: 401 })
    if (!isSystemOwner(token)) return Response.json({ error: 'forbidden' }, { status: 403 })
  }

  const actionId = params.id
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = prisma as any

  const action = await db.agentPendingAction.findUnique({ where: { id: actionId } })
  if (!action) return Response.json({ error: 'not_found' }, { status: 404 })
  if (action.status !== 'pending') {
    return Response.json({ error: 'already_resolved', status: action.status }, { status: 409 })
  }

  // Check expiry (30 min)
  const ageMs = Date.now() - new Date(action.createdAt).getTime()
  if (ageMs > 30 * 60 * 1000) {
    await db.agentPendingAction.update({
      where: { id: actionId },
      data: { status: 'expired', resolvedAt: new Date() },
    })
    return Response.json({ error: 'expired' }, { status: 410 })
  }

  const payload = action.payload as Record<string, unknown>

  // ── Execute by type ────────────────────────────────────────────────────────

  if (action.type === 'fb_post') {
    try {
      const claimed = await db.agentPendingAction.updateMany({
        where: { id: actionId, status: 'pending' },
        data: { status: 'approved', resolvedAt: new Date() },
      })
      if (claimed.count === 0) {
        const current = await db.agentPendingAction.findUnique({ where: { id: actionId } })
        const existingResult = current?.result as { postId?: string } | null
        if (current?.status === 'executed' && existingResult?.postId) {
          return Response.json({ success: true, postId: existingResult.postId, idempotent: true })
        }
        return Response.json({ error: 'already_resolved', status: current?.status }, { status: 409 })
      }

      const pageId = String(payload.pageId ?? resolvePageId(String(payload.page ?? 'lifestyle')))
      const message = String(payload.message ?? '')
      const imageUrl = payload.imageUrl ? String(payload.imageUrl) : undefined

      const { postId } = await createPagePost({ pageId, message, imageUrl })

      // Self-verify
      const verified = await verifyPost(pageId, postId)

      const result = { postId, pageId, verified }
      await db.agentPendingAction.update({
        where: { id: actionId },
        data: { status: 'executed', result },
      })

      // Append result to conversation if present
      if (payload.conversationId) {
        const note = verified
          ? `✅ Facebook post published successfully.\nPost ID: ${postId}`
          : `⚠️ Post created (ID: ${postId}) but self-verification failed — check the page.`
        await db.agentMessage.create({
          data: {
            conversationId: String(payload.conversationId),
            role: 'assistant',
            content: [{ type: 'text', text: note }],
            tokensIn: 0,
            tokensOut: 0,
            costUsd: 0,
          },
        })
        await prisma.agentConversation.update({
          where: { id: String(payload.conversationId) },
          data: { updatedAt: new Date() },
        })
      }

      return Response.json({ success: true, ...result })
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err)
      await db.agentPendingAction.update({
        where: { id: actionId },
        data: { status: 'failed', result: { error: errMsg } },
      })
      return Response.json({ error: errMsg }, { status: 502 })
    }
  }

  if (action.type === 'image_gen') {
    // Mark as approved — the VPS worker polls /api/assistant/internal/pending-jobs
    // and picks this up via BullMQ (worker-side queue). No BullMQ dependency in Next.js.
    await db.agentPendingAction.update({
      where: { id: actionId },
      data: { status: 'approved', resolvedAt: new Date() },
    })

    return Response.json({
      success: true,
      queued: true,
      message: 'Image generation approved. The VPS worker will process it shortly — result will appear in the conversation.',
    })
  }

  // ── Phase 6 action types ───────────────────────────────────────────────────

  if (action.type === 'dispatch_staff_tasks') {
    // Mark proposed tasks as 'approved'; worker picks up and dispatches via Telegram
    const { date, taskIds } = payload as { date: string; taskIds: string[] }
    await db.agentStaffTask.updateMany({
      where: { id: { in: taskIds ?? [] }, status: 'proposed' },
      data:  { status: 'approved' },
    })
    await db.agentPendingAction.update({
      where: { id: actionId },
      data:  { status: 'approved', resolvedAt: new Date() },
    })
    return Response.json({ success: true, queued: true, date, taskCount: (taskIds ?? []).length,
      message: 'Tasks approved. Worker will dispatch to staff via Telegram.' })
  }

  if (action.type === 'add_staff_task_now') {
    const { staffId, title, type, detail, date } = payload as {
      staffId: string; title: string; type: string; detail?: string; date: string
    }
    const task = await db.agentStaffTask.create({
      data: { staffId, title, detail: detail ?? null, type, status: 'approved', proposedFor: new Date(date), source: 'owner' },
      select: { id: true, title: true },
    })
    await db.agentPendingAction.update({
      where: { id: actionId },
      data:  { status: 'executed', resolvedAt: new Date(), result: { taskId: task.id } },
    })
    return Response.json({ success: true, taskId: task.id, queued: true,
      message: `Task "${title}" added and queued for dispatch to staff.` })
  }

  if (action.type === 'update_setting') {
    const { key, value } = payload as { key: string; value: string }
    await db.agentKvSetting.upsert({
      where:  { key },
      update: { value },
      create: { key, value },
    })
    await db.agentPendingAction.update({
      where: { id: actionId },
      data:  { status: 'executed', resolvedAt: new Date() },
    })
    return Response.json({ success: true, key, value })
  }

  if (action.type === 'add_subscription') {
    const { name, amount, currency, billingCycle, nextRenewalAt, category, notes } = payload as {
      name: string; amount: number; currency?: string; billingCycle?: string
      nextRenewalAt: string; category?: string; notes?: string
    }
    const sub = await db.agentSubscription.create({
      data: {
        name: String(name),
        amount: Number(amount),
        currency: currency ?? 'USD',
        billingCycle: billingCycle === 'yearly' ? 'yearly' : 'monthly',
        nextRenewalAt: new Date(nextRenewalAt),
        category: category ?? null,
        notes: notes ?? null,
        active: true,
      },
    })
    await db.agentPendingAction.update({
      where: { id: actionId },
      data: { status: 'executed', resolvedAt: new Date(), result: { subscriptionId: sub.id } },
    })
    return Response.json({ success: true, subscriptionId: sub.id, name: sub.name })
  }

  if (action.type === 'salah_override') {
    const { waqt, date, skip, overrideTime, delayUntil, reason } = payload as {
      waqt: string; date: string; skip: boolean;
      overrideTime?: string; delayUntil?: string; reason?: string;
    }
    await db.agentSalahOverride.create({
      data: {
        date:         date ? new Date(date) : null,
        waqt,
        skip:         skip ?? false,
        overrideTime: overrideTime ? new Date(overrideTime) : null,
        delayUntil:   delayUntil   ? new Date(delayUntil)   : null,
        reason:       reason ?? null,
      },
    })
    await db.agentPendingAction.update({
      where: { id: actionId },
      data:  { status: 'executed', resolvedAt: new Date() },
    })
    return Response.json({ success: true, waqt, date, skip })
  }

  if (action.type === 'log_expense') {
    const { amount, currency, category, note, occurredAt } = payload as {
      amount: number; currency: string; category?: string; note: string; occurredAt: string
    }
    const expense = await db.agentFinanceExpense.create({
      data: { amount, currency, category: category ?? null, note, occurredAt: new Date(occurredAt) },
      select: { id: true, amount: true, currency: true },
    })
    await db.agentPendingAction.update({
      where: { id: actionId },
      data:  { status: 'executed', resolvedAt: new Date(), result: { expenseId: expense.id } },
    })
    return Response.json({ success: true, expenseId: expense.id })
  }

  if (action.type === 'log_ledger_entry') {
    const { personName, direction, amount, currency, note, occurredAt } = payload as {
      personName: string; direction: string; amount: number; currency: string;
      note?: string; occurredAt: string
    }
    const entry = await db.agentFinanceLedger.create({
      data: { personName, direction, amount, currency, note: note ?? null, occurredAt: new Date(occurredAt) },
      select: { id: true, personName: true, direction: true, amount: true },
    })
    await db.agentPendingAction.update({
      where: { id: actionId },
      data:  { status: 'executed', resolvedAt: new Date(), result: { ledgerId: entry.id } },
    })
    return Response.json({ success: true, ledgerId: entry.id })
  }

  return Response.json({ error: 'unknown_action_type', type: action.type }, { status: 400 })
}
