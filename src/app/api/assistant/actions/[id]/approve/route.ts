import { type NextRequest } from 'next/server'
import { getToken } from 'next-auth/jwt'
import { timingSafeEqual } from 'crypto'
import { requireAgentEnabled } from '@/agent/lib/guards'
import { isSystemOwner } from '@/lib/roles'
import { prisma } from '@/lib/prisma'
import { createPagePost, verifyPost, resolvePageId } from '@/agent/lib/meta'
import { resolveFbPostImageRef } from '@/agent/lib/fb-image-resolve'
import { pauseCampaign, updateCampaignBudget } from '@/agent/lib/meta-ads'

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

function resolveConversationId(action: { conversationId?: string | null; payload: unknown }) {
  const payload = action.payload as Record<string, unknown>
  const id = action.conversationId ?? payload.conversationId
  return typeof id === 'string' && id.trim() ? id.trim() : null
}

async function appendConversationNote(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any,
  action: { conversationId?: string | null; payload: unknown },
  text: string,
) {
  const conversationId = resolveConversationId(action)
  if (!conversationId) return
  await db.agentMessage.create({
    data: {
      conversationId,
      role: 'assistant',
      content: [{ type: 'text', text }],
      tokensIn: 0,
      tokensOut: 0,
      costUsd: 0,
    },
  })
  await prisma.agentConversation.update({
    where: { id: conversationId },
    data: { updatedAt: new Date() },
  })
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
      const conversationId = String(payload.conversationId ?? action.conversationId ?? '')
      const textOnly = payload.textOnly === true
      const wantsImage = payload.wantsImage === true

      const { imageRef, hadRecentPostableImage } = await resolveFbPostImageRef(db, {
        conversationId: conversationId || null,
        imageUrl: payload.imageUrl,
        imageArtifactOrFileId: payload.imageArtifactOrFileId,
        textOnly,
      })

      const requireImage = wantsImage || (hadRecentPostableImage && !textOnly)

      const { postId, postedAsPhoto } = await createPagePost({
        pageId,
        message,
        imageUrl: imageRef,
        requireImage,
      })

      const verified = await verifyPost(pageId, postId)

      if (imageRef && verified.ok && !verified.hasMedia) {
        throw new Error(
          'Facebook-এ পোস্ট হয়েছে কিন্তু ছবি attach হয়নি। আবার চেষ্টা করুন — generate_image path সঠিক কিনা দেখুন।',
        )
      }

      const result = {
        postId,
        pageId,
        verified: verified.ok,
        hasMedia: verified.hasMedia,
        postedAsPhoto,
        imagePath: imageRef ?? null,
      }
      await db.agentPendingAction.update({
        where: { id: actionId },
        data: { status: 'executed', result },
      })

      // Append result to conversation if present
      if (payload.conversationId) {
        const note = verified.ok
          ? postedAsPhoto && verified.hasMedia
            ? `✅ Facebook photo post published successfully.\nPost ID: ${postId}`
            : `✅ Facebook post published (text only).\nPost ID: ${postId}`
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
    const { date, taskIds } = payload as { date: string; taskIds: string[] }

    // Already dispatched (sent/done) — idempotent
    const alreadySent = await db.agentStaffTask.count({
      where: {
        OR: [
          { id: { in: taskIds ?? [] }, status: { in: ['sent', 'done'] } },
          ...(date ? [{ proposedFor: new Date(date), status: { in: ['sent', 'done'] } }] : []),
        ],
      },
    })
    if (alreadySent > 0) {
      const sameDateActions = await db.agentPendingAction.findMany({
        where: { type: 'dispatch_staff_tasks', status: { in: ['pending', 'approved'] } },
        select: { id: true, payload: true },
      })
      for (const a of sameDateActions) {
        const p = a.payload as { date?: string }
        if (!date || p.date === date) {
          await db.agentPendingAction.update({
            where: { id: a.id },
            data: { status: 'executed', resolvedAt: new Date(), result: { skipped: 'already_dispatched' } },
          })
        }
      }
      return Response.json({
        success: true, alreadyDispatched: true,
        message: 'ইতোমধ্যে পাঠানো হয়েছে ✅ — আবার পাঠানোর দরকার নেই।',
      })
    }

    await db.agentStaffTask.updateMany({
      where: { id: { in: taskIds ?? [] }, status: 'proposed' },
      data:  { status: 'approved' },
    })

    // Supersede other pending cards for the same date before approving this one
    const otherPending = await db.agentPendingAction.findMany({
      where: {
        id: { not: actionId },
        type: 'dispatch_staff_tasks',
        status: 'pending',
      },
      select: { id: true, payload: true },
    })
    for (const other of otherPending) {
      const p = other.payload as { date?: string }
      if (!date || p.date === date) {
        await db.agentPendingAction.update({
          where: { id: other.id },
          data: { status: 'executed', resolvedAt: new Date(), result: { supersededBy: actionId } },
        })
      }
    }

    await db.agentPendingAction.update({
      where: { id: actionId },
      data:  { status: 'approved', resolvedAt: new Date() },
    })

    await appendConversationNote(
      db,
      action,
      `✅ মালিক ${date}-এর স্টাফ টাস্ক অনুমোদন করেছেন। Worker Telegram-এ পাঠাবে — আবার অনুমোদন চাইবেন না।`,
    )
    return Response.json({ success: true, queued: true, date, taskCount: (taskIds ?? []).length,
      message: 'Tasks approved. Worker will dispatch to staff via Telegram.' })
  }

  if (action.type === 'send_customer_message') {
    try {
      const claimed = await db.agentPendingAction.updateMany({
        where: { id: actionId, status: 'pending' },
        data: { status: 'approved', resolvedAt: new Date() },
      })
      if (claimed.count === 0) {
        return Response.json({ error: 'already_resolved' }, { status: 409 })
      }

      const { pageId, psid, message, customerName } = payload as {
        pageId: string; psid: string; message: string; customerName?: string
      }

      const { sendMessengerText } = await import('@/agent/lib/cs/meta-messenger')
      const msgId = await sendMessengerText(pageId, psid, message)

      const result = { messageId: msgId, pageId, psid, customerName }
      await db.agentPendingAction.update({
        where: { id: actionId },
        data: { status: 'executed', result },
      })

      await appendConversationNote(
        db,
        action,
        `✅ কাস্টমার ${customerName ?? psid}-কে মেসেজ পাঠানো হয়েছে।`,
      )

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

  if (action.type === 'add_staff_task_now') {
    const { staffId, staffName, title, type, detail, date } = payload as {
      staffId: string; staffName?: string; title: string; type: string; detail?: string; date: string
    }
    const task = await db.agentStaffTask.create({
      data: { staffId, title, detail: detail ?? null, type, status: 'approved', proposedFor: new Date(date), source: 'owner' },
      select: { id: true, title: true },
    })
    await db.agentPendingAction.update({
      where: { id: actionId },
      data: {
        status: 'approved',
        resolvedAt: new Date(),
        payload: { ...payload, taskId: task.id },
      },
    })
    await appendConversationNote(
      db,
      action,
      `✅ মালিক "${title}" টাস্ক অনুমোদন করেছেন (${staffName ?? 'staff'})। Worker এখন Telegram-এ পাঠাবে — আবার অনুমোদন চাইবেন না।`,
    )
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

  if (action.type === 'set_reminder_tier3') {
    const { title, body, dueAt, recurrenceRrule, tier, voice } = payload as {
      title: string; body?: string; dueAt: string; recurrenceRrule?: string; tier?: number; voice?: boolean
    }
    const reminder = await db.agentReminder.create({
      data: {
        title: String(title),
        body: body ? String(body) : null,
        dueAt: new Date(dueAt),
        recurrenceRrule: recurrenceRrule ? String(recurrenceRrule) : null,
        tier: tier ?? 3,
        voice: voice !== false,
        status: 'pending',
        sourceConversationId: action.conversationId,
      },
    })
    await db.agentPendingAction.update({
      where: { id: actionId },
      data: { status: 'executed', resolvedAt: new Date(), result: { reminderId: reminder.id } },
    })
    return Response.json({ success: true, reminderId: reminder.id, message: 'Tier-3 reminder saved.' })
  }

  if (action.type === 'urgent_notify') {
    await db.agentPendingAction.update({
      where: { id: actionId },
      data: { status: 'approved', resolvedAt: new Date() },
    })
    return Response.json({
      success: true,
      queued: true,
      message: 'Urgent alert approved. Worker will dispatch notify shortly.',
    })
  }

  if (action.type === 'outbound_call') {
    await db.agentPendingAction.update({
      where: { id: actionId },
      data: { status: 'approved', resolvedAt: new Date() },
    })
    return Response.json({
      success: true,
      queued: true,
      message: 'Outbound call approved. Worker will place the call shortly.',
    })
  }

  if (action.type === 'pause_campaign') {
    const { campaignId } = payload as { campaignId: string }
    const result = await pauseCampaign(String(campaignId))
    if (!result.success) {
      await db.agentPendingAction.update({
        where: { id: actionId },
        data: { status: 'failed', result: { error: result.error } },
      })
      return Response.json({ error: result.error }, { status: 502 })
    }
    await db.agentPendingAction.update({
      where: { id: actionId },
      data: { status: 'executed', resolvedAt: new Date(), result: { campaignId, paused: true } },
    })
    return Response.json({ success: true, campaignId, message: 'Campaign paused.' })
  }

  if (action.type === 'update_campaign_budget') {
    const { campaignId, dailyBudget } = payload as { campaignId: string; dailyBudget: number }
    const result = await updateCampaignBudget(String(campaignId), Number(dailyBudget))
    if (!result.success) {
      await db.agentPendingAction.update({
        where: { id: actionId },
        data: { status: 'failed', result: { error: result.error } },
      })
      return Response.json({ error: result.error }, { status: 502 })
    }
    await db.agentPendingAction.update({
      where: { id: actionId },
      data: { status: 'executed', resolvedAt: new Date(), result: { campaignId, dailyBudget } },
    })
    return Response.json({ success: true, campaignId, dailyBudget, message: 'Budget updated.' })
  }

  if (action.type === 'log_ledger_entries_batch') {
    const { entries } = payload as {
      entries: Array<{
        personName: string; direction: string; amount: number; currency: string;
        note?: string | null; occurredAt: string
      }>
    }
    const created: string[] = []
    for (const e of entries ?? []) {
      const row = await db.agentFinanceLedger.create({
        data: {
          personName: e.personName,
          direction: e.direction,
          amount: e.amount,
          currency: e.currency ?? 'BDT',
          note: e.note ?? null,
          occurredAt: new Date(e.occurredAt),
        },
        select: { id: true },
      })
      created.push(row.id as string)
    }
    await db.agentPendingAction.update({
      where: { id: actionId },
      data: { status: 'executed', resolvedAt: new Date(), result: { ledgerIds: created, count: created.length } },
    })
    return Response.json({ success: true, count: created.length, ledgerIds: created })
  }

  if (action.type === 'log_expenses_batch') {
    const { entries } = payload as {
      entries: Array<{
        amount: number; currency: string; category?: string | null;
        note: string; occurredAt: string
      }>
    }
    const created: string[] = []
    for (const e of entries ?? []) {
      const row = await db.agentFinanceExpense.create({
        data: {
          amount: e.amount,
          currency: e.currency ?? 'BDT',
          category: e.category ?? null,
          note: e.note,
          occurredAt: new Date(e.occurredAt),
        },
        select: { id: true },
      })
      created.push(row.id as string)
    }
    await db.agentPendingAction.update({
      where: { id: actionId },
      data: { status: 'executed', resolvedAt: new Date(), result: { expenseIds: created, count: created.length } },
    })
    return Response.json({ success: true, count: created.length, expenseIds: created })
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
