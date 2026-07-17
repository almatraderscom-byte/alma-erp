import { type NextRequest } from 'next/server'
import { getToken } from 'next-auth/jwt'
import { timingSafeEqual } from 'crypto'
import { requireAgentEnabled } from '@/agent/lib/guards'
import { isSystemOwner } from '@/lib/roles'
import { prisma } from '@/lib/prisma'
import { enqueueAgentContinuation } from '@/agent/lib/approval-continuation'
import { finalizeTurnIfRunning } from '@/agent/lib/turn-status'
import { createPagePost, verifyPost, resolvePageId } from '@/agent/lib/meta'
import { resolveFbPostImageRef } from '@/agent/lib/fb-image-resolve'
import { pauseCampaign, updateCampaignBudget } from '@/agent/lib/meta-ads'
import { setOwnerCallLockUntil } from '@/lib/owner-call-lock'
import { recordApproval } from '@/agent/lib/trust-engine'
import { isPendingActionExpired } from '@/agent/lib/pending-action'
import { placeOutboundCall } from '@/agent/lib/voice-call'

export const runtime = 'nodejs'
// Delegation approval runs the worker sub-agent synchronously (an OpenRouter
// agentic loop of up to 4 iterations), which can take 30-60s. The old 30s cap
// caused Vercel 504s → the owner saw an "HTTP error" toast after approving.
export const maxDuration = 120

function verifyInternalToken(provided: string): boolean {
  const expected = process.env.AGENT_INTERNAL_TOKEN ?? ''
  if (!expected || !provided) return false
  try {
    const a = Buffer.from(expected, 'utf8')
    const b = Buffer.from(provided, 'utf8')
    if (a.length !== b.length) return false
    return timingSafeEqual(a, b)
  } catch (err) {
    console.warn('[approve] token compare failed:', err instanceof Error ? err.message : err)
    return false
  }
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

async function runApprove(
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

  // Check expiry (lifecycle-bound cards like dispatch_staff_tasks never expire —
  // they re-read the live DB on approve and are retired by supersede, not a clock).
  if (isPendingActionExpired(action.createdAt, action.type)) {
    await db.agentPendingAction.update({
      where: { id: actionId },
      data: { status: 'expired', resolvedAt: new Date() },
    })
    return Response.json({ error: 'expired' }, { status: 410 })
  }

  // Phase 1 approval span: ties the owner's decision to the conversation trace,
  // so approvals/revisions join the turn → route → tool timeline (fail-open).
  void import('@/agent/lib/tool-telemetry').then((m) =>
    m.logToolEvent({
      toolName: '__approval__',
      phase: 'approval',
      success: true,
      conversationId: (action.conversationId as string | null) ?? null,
      businessId: (action.businessId as string) ?? 'ALMA_LIFESTYLE',
      detail: { actionId, actionType: action.type, decision: 'approved' },
    }),
  ).catch(() => {})

  // Record trust approval (non-blocking)
  const trustDomain = action.type.startsWith('staff_') ? 'staff' :
    action.type.startsWith('content_') || action.type === 'fb_post' || action.type === 'instagram_post' || action.type === 'ad_creative_gate' || action.type === 'ads_creative_brief' ? 'content' :
    action.type.startsWith('website_') ? 'content' :
    action.type.startsWith('log_') || action.type === 'delete_finance_entry' || action.type === 'edit_finance_entry' ? 'finance' :
    'general'
  const trustBiz = (action.businessId as string) ?? 'ALMA_LIFESTYLE'
  void recordApproval(trustDomain, action.type as string, trustBiz).catch((err) => {
    console.warn('[approve] recordApproval failed:', err instanceof Error ? err.message : err)
  })

  void import('@/agent/lib/duty-approval-block')
    .then((m) => m.resolveDutyBlocksForLinkedAction(actionId))
    .catch((err) => {
      console.warn('[approve] resolveDutyBlocks failed:', err instanceof Error ? err.message : err)
    })

  const payload = action.payload as Record<string, unknown>

  // ── Phase 34: universal bridge guard — BEFORE any effect ─────────────────
  // 1. Approval covers exactly the DISPLAYED effect: an approve request that
  //    carries modified effect fields is refused (revise → new card instead).
  // 2. Card → run → expected state version binding: if the card was staged
  //    against a run version and the run has moved on, approving produces
  //    ZERO effects and a clear message (stale card can't fire an old plan).
  {
    const { guardBridgeDecision, bridgeVerdictMessageBn, resumeDecisionThread } =
      await import('@/agent/lib/graph/action-bridge')
    let approveBody: Record<string, unknown> = {}
    try { approveBody = await req.clone().json() } catch { /* no body is the normal case */ }
    const hasRevisedFields = Boolean(
      approveBody && typeof approveBody === 'object'
      && (approveBody.revisedPayload || approveBody.amount || approveBody.audience || approveBody.content),
    )
    const stagedVersion = typeof payload.expectedStateVersion === 'number' ? payload.expectedStateVersion : null
    const runId = typeof payload.workflowRunId === 'string' ? payload.workflowRunId : null
    let liveVersion: number | null = null
    if (runId && stagedVersion !== null) {
      try {
        const run = await db.workflowRun.findUnique({ where: { id: runId }, select: { stateVersion: true } })
        liveVersion = run?.stateVersion ?? null
      } catch { /* unknown run → guard skips version check */ }
    }
    const verdict = guardBridgeDecision({
      card: { id: actionId, status: action.status as string },
      resume: { decision: 'approve', cardId: actionId, expectedStateVersion: liveVersion },
      stagedStateVersion: stagedVersion,
      liveStateVersion: liveVersion,
      hasRevisedFields,
    })
    if (verdict !== 'ok') {
      const status = verdict === 'stale_version' ? 409 : verdict === 'revision_requires_new_card' ? 409 : 409
      return Response.json({ error: verdict, message: bridgeVerdictMessageBn(verdict) }, { status })
    }
    // A bridge-staged thread consumes its interrupt exactly once (double
    // click / reconnect safety). Transport only — execution stays below.
    const bridgeThread = (payload as { bridgeThread?: { threadId?: string } }).bridgeThread
    if (bridgeThread?.threadId) {
      const r = await resumeDecisionThread({ decision: 'approve', cardId: actionId, expectedStateVersion: liveVersion })
      if (r.alreadyConsumed) {
        return Response.json({ error: 'already_resolved', message: bridgeVerdictMessageBn('already_resolved') }, { status: 409 })
      }
    }
  }

  // ── Execute by type ────────────────────────────────────────────────────────

  // Delegation approval (test mode): owner approved the transfer → run the worker
  // now and post its summary back into the conversation.
  if (action.type === 'delegation') {
    await db.agentPendingAction.update({
      where: { id: actionId },
      data: { status: 'approved', resolvedAt: new Date() },
    })
    const role = String(payload.role ?? '')
    const task = String(payload.task ?? '')
    const businessId = (payload.businessId as string) ?? (action.businessId as string) ?? 'ALMA_LIFESTYLE'
    const conversationId = resolveConversationId(action) ?? undefined
    try {
      const { runSubAgent } = await import('@/agent/lib/models/subagent')
      const result = await runSubAgent({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        role: role as any,
        task,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        businessId: businessId as any,
        conversationId,
      })
      const note = result.success
        ? `🤝 ${result.roleLabel} (${result.modelLabel}) সম্পন্ন করেছে:\n\n${result.summary}`
        : `⚠️ ${role} worker কাজটি করতে পারেনি: ${result.error ?? 'unknown'}`
      await appendConversationNote(db, action, note)
      await db.agentPendingAction.update({
        where: { id: actionId },
        data: { status: 'executed', result: { summary: result.summary, model: result.modelId, success: result.success } },
      })
      return Response.json({ success: true, summary: result.summary, model: result.modelId })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      await appendConversationNote(db, action, `⚠️ Worker চালাতে সমস্যা: ${msg}`)
      return Response.json({ error: 'delegation_failed', message: msg }, { status: 500 })
    }
  }

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

      const contentType = postedAsPhoto && verified.hasMedia ? 'fb_photo' : 'fb_text'
      void import('@/lib/content-intelligence').then(({ trackPublishedContent }) =>
        trackPublishedContent({
          productRef: typeof payload.productRef === 'string' ? payload.productRef : null,
          message,
          contentType,
          page: String(payload.page ?? 'lifestyle'),
        }),
      ).catch((err) => {
        console.warn('[approve] trackPublishedContent failed:', err instanceof Error ? err.message : err)
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

  if (action.type === 'instagram_post') {
    try {
      const claimed = await db.agentPendingAction.updateMany({
        where: { id: actionId, status: 'pending' },
        data: { status: 'approved', resolvedAt: new Date() },
      })
      if (claimed.count === 0) {
        const current = await db.agentPendingAction.findUnique({ where: { id: actionId } })
        const existingResult = current?.result as { mediaId?: string } | null
        if (current?.status === 'executed' && existingResult?.mediaId) {
          return Response.json({ success: true, mediaId: existingResult.mediaId, idempotent: true })
        }
        return Response.json({ error: 'already_resolved', status: current?.status }, { status: 409 })
      }

      const pageId = String(payload.pageId ?? resolvePageId(String(payload.page ?? 'lifestyle')))
      const caption = String(payload.caption ?? '')
      const conversationId = String(payload.conversationId ?? action.conversationId ?? '')

      // Re-resolve the image the same way fb_post does — the staged ref is
      // preferred, with the conversation fallback as a safety net.
      const { imageRef } = await resolveFbPostImageRef(db, {
        conversationId: conversationId || null,
        imageUrl: payload.imageUrl,
        imageArtifactOrFileId: payload.imageArtifactOrFileId,
        textOnly: false,
      })
      if (!imageRef) {
        throw new Error('Instagram পোস্টের ছবি খুঁজে পাওয়া যায়নি — publish বাতিল।')
      }

      const { publishInstagramImage } = await import('@/agent/lib/meta-instagram')
      const result = await publishInstagramImage({ pageId, caption, mediaRef: imageRef })
      if (!result.success) {
        await db.agentPendingAction.update({
          where: { id: actionId },
          data: { status: 'failed', result: { error: result.error } },
        })
        return Response.json({ error: result.error }, { status: 502 })
      }

      const resultData = {
        mediaId: result.mediaId,
        permalink: result.permalink ?? null,
        igUsername: result.igUsername ?? null,
        pageId,
        imagePath: imageRef,
      }
      await db.agentPendingAction.update({
        where: { id: actionId },
        data: { status: 'executed', result: resultData },
      })

      void import('@/lib/content-intelligence').then(({ trackPublishedContent }) =>
        trackPublishedContent({
          productRef: typeof payload.productRef === 'string' ? payload.productRef : null,
          message: caption,
          contentType: 'ig_photo',
          page: String(payload.page ?? 'lifestyle'),
        }),
      ).catch((err) => {
        console.warn('[approve] trackPublishedContent (ig) failed:', err instanceof Error ? err.message : err)
      })

      await appendConversationNote(
        db,
        action,
        `✅ Instagram-এ পোস্ট লাইভ হয়েছে${result.igUsername ? ` (@${result.igUsername})` : ''}।${result.permalink ? `\nLink: ${result.permalink}` : ''}`,
      )

      return Response.json({ success: true, ...resultData })
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err)
      await db.agentPendingAction.update({
        where: { id: actionId },
        data: { status: 'failed', result: { error: errMsg } },
      })
      return Response.json({ error: errMsg }, { status: 502 })
    }
  }

  // Growth Autopilot: approving a scheduled post does NOT publish now — it flips
  // the calendar entry to 'approved' so the growth-publish cron publishes it at
  // the scheduled time. This keeps the owner-approval gate while allowing
  // publish-later scheduling.
  if (action.type === 'schedule_content') {
    try {
      const claimed = await db.agentPendingAction.updateMany({
        where: { id: actionId, status: 'pending' },
        data: { status: 'approved', resolvedAt: new Date() },
      })
      if (claimed.count === 0) {
        const current = await db.agentPendingAction.findUnique({ where: { id: actionId } })
        return Response.json({ error: 'already_resolved', status: current?.status }, { status: 409 })
      }
      const calendarId = String(payload.calendarId ?? '')
      if (!calendarId) throw new Error('calendarId missing from schedule_content payload')
      await db.agentContentCalendar.update({
        where: { id: calendarId },
        data: { status: 'approved', approvedAt: new Date() },
      })
      await db.agentPendingAction.update({
        where: { id: actionId },
        data: { status: 'executed', result: { calendarId, scheduled: true } },
      })
      await appendConversationNote(
        db,
        action,
        '✅ পোস্টটি শিডিউল অনুমোদিত — নির্ধারিত সময়ে নিজে থেকে পাবলিশ হবে।',
      )
      return Response.json({ success: true, calendarId, scheduled: true })
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err)
      await db.agentPendingAction.update({
        where: { id: actionId },
        data: { status: 'failed', result: { error: errMsg } },
      })
      return Response.json({ error: errMsg }, { status: 502 })
    }
  }

  // Growth Autopilot: approve a whole campaign batch — flip every calendar row
  // in the batch to 'approved' so the cron publishes each at its scheduled time.
  if (action.type === 'schedule_content_batch') {
    try {
      const claimed = await db.agentPendingAction.updateMany({
        where: { id: actionId, status: 'pending' },
        data: { status: 'approved', resolvedAt: new Date() },
      })
      if (claimed.count === 0) {
        const current = await db.agentPendingAction.findUnique({ where: { id: actionId } })
        return Response.json({ error: 'already_resolved', status: current?.status }, { status: 409 })
      }
      const calendarIds = Array.isArray(payload.calendarIds) ? (payload.calendarIds as string[]) : []
      if (calendarIds.length === 0) throw new Error('calendarIds missing from schedule_content_batch payload')
      const upd = await db.agentContentCalendar.updateMany({
        where: { id: { in: calendarIds }, status: 'draft' },
        data: { status: 'approved', approvedAt: new Date() },
      })
      await db.agentPendingAction.update({
        where: { id: actionId },
        data: { status: 'executed', result: { calendarIds, approved: upd.count } },
      })
      await appendConversationNote(
        db,
        action,
        `✅ ক্যাম্পেইন অনুমোদিত — ${upd.count}টি পোস্ট নির্ধারিত সময়ে নিজে থেকে পাবলিশ হবে।`,
      )
      return Response.json({ success: true, approved: upd.count })
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err)
      await db.agentPendingAction.update({
        where: { id: actionId },
        data: { status: 'failed', result: { error: errMsg } },
      })
      return Response.json({ error: errMsg }, { status: 502 })
    }
  }

  // Growth Autopilot: approve a batch of on-page SEO copy fixes — apply
  // shortDescription/description to every product in the batch, live.
  if (action.type === 'seo_fix_batch') {
    try {
      const claimed = await db.agentPendingAction.updateMany({
        where: { id: actionId, status: 'pending' },
        data: { status: 'approved', resolvedAt: new Date() },
      })
      if (claimed.count === 0) {
        const current = await db.agentPendingAction.findUnique({ where: { id: actionId } })
        return Response.json({ error: 'already_resolved', status: current?.status }, { status: 409 })
      }
      const items = Array.isArray(payload.items)
        ? (payload.items as Array<{
            productId: string
            slug: string
            fields: { shortDescription?: string; description?: string; title?: string }
            imageAlts?: Array<{ url: string; alt: string }>
          }>)
        : []
      if (items.length === 0) throw new Error('items missing from seo_fix_batch payload')
      const { updateWebsiteProductFields, updateWebsiteProductImageAlts } = await import('@/lib/website/write.service')
      const applied: string[] = []
      const failed: Array<{ slug: string; error: string }> = []
      for (const it of items) {
        const hasFields = it.fields && Object.keys(it.fields).length > 0
        let ok = true
        let errMsg = ''
        if (hasFields) {
          const result = await updateWebsiteProductFields(String(it.productId), it.fields ?? {})
          if (!result.ok) { ok = false; errMsg = result.error }
        }
        if (ok && it.imageAlts && it.imageAlts.length > 0) {
          const altResult = await updateWebsiteProductImageAlts(String(it.productId), it.imageAlts)
          if (!altResult.ok) { ok = false; errMsg = altResult.error }
        }
        if (ok) applied.push(it.slug)
        else failed.push({ slug: it.slug, error: errMsg })
      }
      await db.agentPendingAction.update({
        where: { id: actionId },
        data: {
          status: failed.length === 0 ? 'executed' : 'partial',
          result: { applied, failed },
        },
      })
      const note =
        `✅ SEO ফিক্স অনুমোদিত — ${applied.length}টি product আপডেট হয়েছে` +
        (failed.length ? `, ${failed.length}টি ব্যর্থ (${failed.map((f) => f.slug).join(', ')})` : '') +
        `। ISR/cache — live page দেখতে কিছুক্ষণ লাগতে পারে।`
      await appendConversationNote(db, action, note)
      return Response.json({ success: failed.length === 0, applied, failed })
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err)
      await db.agentPendingAction.update({
        where: { id: actionId },
        data: { status: 'failed', result: { error: errMsg } },
      })
      return Response.json({ error: errMsg }, { status: 502 })
    }
  }

  // Growth Feature 6: owner approved an Email/SMS marketing campaign — send it
  // now, sequentially, via the providers the ERP already uses (sms.net.bd /
  // Resend). Recipients were resolved and capped at draft time; nothing was
  // sent before this approval.
  if (action.type === 'marketing_campaign') {
    try {
      const claimed = await db.agentPendingAction.updateMany({
        where: { id: actionId, status: 'pending' },
        data: { status: 'approved', resolvedAt: new Date() },
      })
      if (claimed.count === 0) {
        const current = await db.agentPendingAction.findUnique({ where: { id: actionId } })
        return Response.json({ error: 'already_resolved', status: current?.status }, { status: 409 })
      }
      const channel = String(payload.channel ?? '')
      const message = String(payload.message ?? '')
      const subject = String(payload.subject ?? '')
      const recipients = Array.isArray(payload.recipients)
        ? (payload.recipients as Array<{ to: string; name?: string | null }>)
        : []
      if (!message || recipients.length === 0) throw new Error('campaign payload missing message/recipients')

      const sent: string[] = []
      const failed: Array<{ to: string; error: string }> = []
      if (channel === 'sms') {
        const { sendSmsViaProvider } = await import('@/lib/sms/provider')
        for (const r of recipients) {
          const res = await sendSmsViaProvider({ to: r.to, message })
          if (res.ok) sent.push(r.to)
          else failed.push({ to: r.to, error: res.errorMessage ?? res.errorCode ?? 'send failed' })
        }
      } else if (channel === 'email') {
        const { sendEmail } = await import('@/lib/resend')
        for (const r of recipients) {
          const res = await sendEmail({ to: r.to, subject, text: message })
          if (res.ok) sent.push(r.to)
          else failed.push({ to: r.to, error: String((res as { error?: unknown }).error ?? 'send failed') })
        }
      } else {
        throw new Error(`unknown campaign channel: ${channel}`)
      }

      await db.agentPendingAction.update({
        where: { id: actionId },
        data: {
          status: failed.length === 0 ? 'executed' : sent.length > 0 ? 'partial' : 'failed',
          result: { sent, failed },
        },
      })
      await appendConversationNote(
        db,
        action,
        `✅ ক্যাম্পেইন অনুমোদিত — ${sent.length}/${recipients.length} জনকে ${channel.toUpperCase()} পাঠানো হয়েছে` +
          (failed.length ? `, ${failed.length}টি ব্যর্থ` : '') +
          '।',
      )
      return Response.json({ success: failed.length === 0, sentCount: sent.length, failed })
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err)
      await db.agentPendingAction.update({
        where: { id: actionId },
        data: { status: 'failed', result: { error: errMsg } },
      })
      return Response.json({ error: errMsg }, { status: 502 })
    }
  }

  // Growth Feature 7: owner approved a PUBLIC Google Business Profile action —
  // post the review reply / local post now via the shared Google OAuth.
  if (action.type === 'gbp_reply' || action.type === 'gbp_post') {
    try {
      const claimed = await db.agentPendingAction.updateMany({
        where: { id: actionId, status: 'pending' },
        data: { status: 'approved', resolvedAt: new Date() },
      })
      if (claimed.count === 0) {
        const current = await db.agentPendingAction.findUnique({ where: { id: actionId } })
        return Response.json({ error: 'already_resolved', status: current?.status }, { status: 409 })
      }
      const { replyToGbpReview, createGbpPost } = await import('@/agent/lib/gbp')
      const r =
        action.type === 'gbp_reply'
          ? await replyToGbpReview(String(payload.reviewId ?? ''), String(payload.reply ?? ''))
          : await createGbpPost({ summary: String(payload.summary ?? ''), ctaUrl: payload.ctaUrl ? String(payload.ctaUrl) : undefined })
      if (!r.ok) {
        await db.agentPendingAction.update({
          where: { id: actionId },
          data: { status: 'failed', result: { error: r.error, kind: r.kind } },
        })
        return Response.json({ error: r.error }, { status: 502 })
      }
      await db.agentPendingAction.update({
        where: { id: actionId },
        data: { status: 'executed', result: { posted: true } },
      })
      await appendConversationNote(
        db,
        action,
        action.type === 'gbp_reply'
          ? '✅ রিভিউর জবাব Google-এ পোস্ট হয়েছে (public)।'
          : '✅ Business Profile পোস্ট Google-এ পাবলিশ হয়েছে (public)।',
      )
      return Response.json({ success: true })
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err)
      await db.agentPendingAction.update({
        where: { id: actionId },
        data: { status: 'failed', result: { error: errMsg } },
      })
      return Response.json({ error: errMsg }, { status: 502 })
    }
  }

  if (action.type === 'content_gate1') {
    try {
      const claimed = await db.agentPendingAction.updateMany({
        where: { id: actionId, status: 'pending' },
        data: { status: 'approved', resolvedAt: new Date() },
      })
      if (claimed.count === 0) {
        return Response.json({ error: 'already_resolved' }, { status: 409 })
      }
      const { advanceToProRenders } = await import('@/lib/content-engine/pipeline')
      const result = await advanceToProRenders(actionId)
      await appendConversationNote(
        db,
        action,
        '✅ কন্টেন্ট Gate 1 অনুমোদিত — PRO রেন্ডার কিউ হয়েছে। Gate 2 আসবে রেন্ডার শেষে।',
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

  if (action.type === 'ad_creative_gate') {
    try {
      const { approveAdCreativeGate } = await import('@/lib/content-engine/ad-creative-gate')
      const { creatives } = await approveAdCreativeGate(actionId)
      await appendConversationNote(
        db,
        action,
        `✅ Ad creative batch approved — ${creatives.length}টি ক্রিয়েটিভ ready (Ads/download). কিছু auto-post হয়নি।`,
      )
      return Response.json({
        success: true,
        creativeCount: creatives.length,
        creatives: creatives.map((c) => ({
          id: c.id,
          angle: c.angle,
          aspect: c.aspect,
          imagePath: c.imagePath,
          hookBn: c.hookBn,
        })),
        message: 'Ad creatives approved. Ready for Meta Ads — nothing was auto-posted.',
      })
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err)
      return Response.json({ error: errMsg }, { status: 400 })
    }
  }

  if (action.type === 'content_gate2') {
    try {
      const claimed = await db.agentPendingAction.updateMany({
        where: { id: actionId, status: 'pending' },
        data: { status: 'approved', resolvedAt: new Date() },
      })
      if (claimed.count === 0) {
        return Response.json({ error: 'already_resolved' }, { status: 409 })
      }
      const { publishContentGate2 } = await import('@/lib/content-engine/pipeline')
      const { postId } = await publishContentGate2(actionId)
      await appendConversationNote(db, action, `✅ Facebook-এ পোস্ট প্রকাশিত। Post ID: ${postId}`)
      return Response.json({ success: true, postId, message: 'Content published to Facebook.' })
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

  if (action.type === 'video_gen') {
    await db.agentPendingAction.update({
      where: { id: actionId },
      data: { status: 'approved', resolvedAt: new Date() },
    })

    return Response.json({
      success: true,
      queued: true,
      message: 'Video reel generation approved. The VPS worker will process it shortly — reel approval card will follow.',
    })
  }

  if (action.type === 'marketing_plan') {
    const claimed = await db.agentPendingAction.updateMany({
      where: { id: actionId, status: 'pending' },
      data: { status: 'approved', resolvedAt: new Date() },
    })
    if (claimed.count === 0) {
      return Response.json({ error: 'already_resolved' }, { status: 409 })
    }
    const planPayload = payload as {
      items?: Array<Record<string, unknown>>
      conversationId?: string | null
    }
    const items = Array.isArray(planPayload.items) ? planPayload.items : []
    const { orchestrateMarketingPlanItems } = await import('@/agent/lib/marketing/plan-orchestrate')
    const orch = await orchestrateMarketingPlanItems(
      items as unknown as import('@/agent/lib/marketing/planner').MarketingPlanItem[],
      action.conversationId ?? planPayload.conversationId ?? null,
    )
    await db.agentPendingAction.update({
      where: { id: actionId },
      data: {
        status: 'executed',
        result: orch,
      },
    })
    await appendConversationNote(
      db,
      action,
      `✅ Marketing plan approved — ${orch.creativeBriefs} ad brief(s), ${orch.organicTasks} organic task(s). ` +
        `${orch.cardsDelivered}টি confirm card পাঠানো হয়েছে (Agent chat + Telegram) — প্রতিটি আলাদা approve লাগবে।`,
    )
    return Response.json({
      success: true,
      message: 'Marketing plan orchestrated — child approval cards created.',
      ...orch,
    })
  }

  if (action.type === 'video_reel_gate') {
    const claimed = await db.agentPendingAction.updateMany({
      where: { id: actionId, status: 'pending' },
      data: { status: 'approved', resolvedAt: new Date() },
    })
    if (claimed.count === 0) {
      return Response.json({ error: 'already_resolved' }, { status: 409 })
    }
    const reelPayload = payload as { storagePath?: string; productCode?: string }
    await appendConversationNote(
      db,
      action,
      `✅ Product reel approved — ready for Reels/Stories post (${reelPayload.productCode ?? 'reel'}). Path: ${reelPayload.storagePath ?? ''}`,
    )
    return Response.json({
      success: true,
      message: 'Reel approved for use. Posting still requires separate owner action.',
      storagePath: reelPayload.storagePath,
    })
  }

  // ── Phase 6 action types ───────────────────────────────────────────────────

  if (action.type === 'dispatch_staff_tasks') {
    const { date } = payload as { date: string }
    const actionDate = date || new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Dhaka' })

    const { refreshAndApproveDispatch, hasProposedTasksForDate } = await import('@/agent/lib/staff-dispatch-sync')

    const proposedCount = await hasProposedTasksForDate(actionDate)
    if (proposedCount === 0) {
      const alreadySent = await db.agentStaffTask.count({
        where: {
          proposedFor: new Date(actionDate),
          status: { in: ['sent', 'done'] },
        },
      })
      if (alreadySent > 0) {
        const sameDateActions = await db.agentPendingAction.findMany({
          where: { type: 'dispatch_staff_tasks', status: { in: ['pending', 'approved'] } },
          select: { id: true, payload: true },
        })
        for (const a of sameDateActions) {
          const p = a.payload as { date?: string }
          if (!actionDate || p.date === actionDate) {
            await db.agentPendingAction.update({
              where: { id: a.id },
              data: { status: 'executed', resolvedAt: new Date(), result: { skipped: 'already_dispatched' } },
            })
          }
        }
        return Response.json({
          success: true, alreadyDispatched: true,
          message: 'ইতোমধ্যে পাঠানো হয়েছে ✅ — নতুন টাস্ক যোগ করতে merge_into_proposal ব্যবহার করুন।',
        })
      }
      return Response.json({ error: 'no_proposed_tasks', message: 'কোনো proposed টাস্ক নেই।' }, { status: 400 })
    }

    const refreshed = await refreshAndApproveDispatch(actionDate, actionId)
    if (!refreshed.ok) {
      return Response.json({ error: 'no_proposed_tasks', message: 'কোনো proposed টাস্ক নেই।' }, { status: 400 })
    }

    await appendConversationNote(
      db,
      action,
      `✅ মালিক ${actionDate}-এর স্টাফ টাস্ক অনুমোদন করেছেন (${refreshed.taskCount}টি, DB sync)। Worker Telegram-এ পাঠাবে।`,
    )
    return Response.json({
      success: true,
      queued: true,
      date: actionDate,
      taskCount: refreshed.taskCount,
      taskIds: refreshed.taskIds,
      message: 'Tasks approved from current DB proposal. Worker will dispatch to staff via Telegram.',
    })
  }

  if (action.type === 'oxylabs_spend') {
    await db.agentPendingAction.update({
      where: { id: actionId },
      data: { status: 'approved', resolvedAt: new Date() },
    })
    const credits = Number((payload as { estimatedCredits?: number }).estimatedCredits ?? action.costEstimate ?? 1)
    await appendConversationNote(
      db,
      action,
      `✅ Oxylabs research অনুমোদিত (${credits} ক্রেডিট) — এখন spendApprovalId="${actionId}" দিয়ে research tool চালান।`,
    )
    return Response.json({
      success: true,
      spendApprovalId: actionId,
      estimatedCredits: credits,
      message: 'Oxylabs research approved. Agent may now call the research tool with spendApprovalId.',
    })
  }

  if (action.type === 'staff_announcement') {
    const claimed = await db.agentPendingAction.updateMany({
      where: { id: actionId, status: 'pending' },
      data: { status: 'approved', resolvedAt: new Date() },
    })
    if (claimed.count === 0) {
      const current = await db.agentPendingAction.findUnique({
        where: { id: actionId },
        select: { status: true },
      })
      return Response.json({ error: 'already_resolved', status: current?.status }, { status: 409 })
    }

    const staffNames = ((payload as { staffChatIds?: Array<{ name?: string }> }).staffChatIds ?? [])
      .map((s) => s.name)
      .filter(Boolean)
      .join(', ')

    await appendConversationNote(
      db,
      action,
      `✅ মালিক স্টাফ মেসেজ ড্রাফ্ট অনুমোদন করেছেন${staffNames ? ` (${staffNames})` : ''}। Worker Telegram-এ পাঠাবে।`,
    )
    return Response.json({
      success: true,
      queued: true,
      message: 'Staff message approved. Worker will send to staff via Telegram.',
    })
  }

  // Staff auto-message (checkin greeting / morale / nudge). The VPS worker creates
  // this card and Telegram's ✅ button has its own worker-side handler — but the
  // app/web Approvals tab lands HERE, which used to fall through to
  // unknown_action_type (the owner saw "অনুমোদন ব্যর্থ হয়েছে"). Mirror the Telegram
  // path: claim the row, then hand the actual SEND to the worker's /staff-send
  // (logged send + ack buttons live worker-side); if the worker is unreachable,
  // fall back to a direct Telegram send so the approval never dead-ends.
  if (action.type === 'staff_auto_message') {
    const claimed = await db.agentPendingAction.updateMany({
      where: { id: actionId, status: { in: ['pending', 'waiting_list'] } },
      data: { status: 'approved', resolvedAt: new Date() },
    })
    if (claimed.count === 0) {
      const current = await db.agentPendingAction.findUnique({
        where: { id: actionId },
        select: { status: true },
      })
      return Response.json({ error: 'already_resolved', status: current?.status }, { status: 409 })
    }

    const p = payload as { chatId?: string; content?: string; staffName?: string; type?: string }
    let sent = false
    let sendError = ''

    const workerUrl = process.env.AGENT_WORKER_DIAGNOSTIC_URL?.replace(/\/$/, '')
    const internalToken = process.env.AGENT_INTERNAL_TOKEN
    if (workerUrl && internalToken) {
      try {
        const res = await fetch(`${workerUrl}/staff-send`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${internalToken}`,
          },
          body: JSON.stringify({ actionId, payload }),
          signal: AbortSignal.timeout(15_000),
        })
        sent = res.ok
        if (!res.ok) sendError = `worker_staff_send_${res.status}`
      } catch (err) {
        sendError = err instanceof Error ? err.message : String(err)
      }
    }

    if (!sent && p.chatId && p.content && process.env.ASSISTANT_BOT_TOKEN) {
      try {
        const tg = await fetch(`https://api.telegram.org/bot${process.env.ASSISTANT_BOT_TOKEN}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chat_id: p.chatId, text: p.content }),
          signal: AbortSignal.timeout(10_000),
        })
        sent = tg.ok
        if (!tg.ok) sendError = `telegram_${tg.status}`
      } catch (err) {
        sendError = err instanceof Error ? err.message : String(err)
      }
    }

    await db.agentPendingAction.update({
      where: { id: actionId },
      data: sent
        ? { status: 'executed', result: { sent: true, staffName: p.staffName ?? null } }
        : { status: 'failed', result: { error: sendError || 'send_failed' } },
    })
    if (!sent) {
      return Response.json({ error: sendError || 'send_failed' }, { status: 502 })
    }
    return Response.json({
      success: true,
      message: `স্টাফ মেসেজ পাঠানো হয়েছে${p.staffName ? ` (${p.staffName})` : ''}।`,
    })
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

  if (action.type === 'reply_to_comment') {
    try {
      const claimed = await db.agentPendingAction.updateMany({
        where: { id: actionId, status: 'pending' },
        data: { status: 'approved', resolvedAt: new Date() },
      })
      if (claimed.count === 0) {
        return Response.json({ error: 'already_resolved' }, { status: 409 })
      }

      const { pageId, commentId, message, customerName } = payload as {
        pageId: string; commentId: string; message: string; customerName?: string | null
      }

      const { replyToComment } = await import('@/agent/lib/meta')
      const { replyId } = await replyToComment({ pageId, commentId, message })

      const result = { replyId, pageId, commentId, customerName: customerName ?? null }
      await db.agentPendingAction.update({
        where: { id: actionId },
        data: { status: 'executed', result },
      })

      await appendConversationNote(
        db,
        action,
        `✅ ${customerName ?? 'কাস্টমার'}-এর কমেন্টে পাবলিক রিপ্লাই পোস্ট হয়েছে।`,
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

  if (action.type === 'memory_cleanup') {
    // Weekly memory revision: the owner approved removing the listed stale
    // memories. Deletion happens ONLY here — never silently. pinned:false guard
    // repeated defensively (pinned rows are standing instructions).
    const { memoryIds } = payload as { memoryIds?: string[] }
    const ids = Array.isArray(memoryIds) ? memoryIds.filter((x) => typeof x === 'string') : []
    const deleted = ids.length
      ? await db.agentMemory.deleteMany({ where: { id: { in: ids }, pinned: false } })
      : { count: 0 }
    await db.agentPendingAction.update({
      where: { id: actionId },
      data: { status: 'executed', resolvedAt: new Date(), result: { deleted: deleted.count } },
    })
    await appendConversationNote(
      db,
      action,
      `🧹 মেমরি রিভিশন সম্পন্ন — মালিকের অনুমোদনে ${deleted.count}টি পুরোনো স্মৃতি মুছে ফেলা হয়েছে।`,
    )
    return Response.json({ success: true, deleted: deleted.count })
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
    if (delayUntil) {
      await setOwnerCallLockUntil(new Date(delayUntil))
    }
    await db.agentPendingAction.update({
      where: { id: actionId },
      data:  { status: 'executed', resolvedAt: new Date() },
    })
    return Response.json({ success: true, waqt, date, skip })
  }

  if (action.type === 'log_expense') {
    // LG-3 pilot: a card staged by the action graph carries a graphThread
    // bridge — resume the paused thread with the owner's decision (interrupt
    // is TRANSPORT; the auth/status/expiry guards above stay the
    // authorization). Any resume failure falls open to the legacy path below.
    const graphThread = (payload as { graphThread?: { threadId?: string } }).graphThread
    if (graphThread?.threadId) {
      const { resumeExpenseActionGraph } = await import('@/agent/lib/graph/action-turn-graph')
      const r = await resumeExpenseActionGraph({ pendingActionId: actionId, threadId: graphThread.threadId })
      if (r.resumed && r.executed) {
        return Response.json({ success: true, expenseId: r.expenseId, via: 'graph_resume' })
      }
      if (r.resumed && !r.executed) {
        // The thread resumed but the claim found the row already resolved —
        // report honestly instead of double-logging via the legacy path.
        return Response.json({ error: 'already_resolved', detail: r.error ?? undefined }, { status: 409 })
      }
      // resumed=false → checkpointer/thread problem → legacy path executes.
    }
    // Legacy inline path — shares the claim-guarded executor with the graph
    // node, so a partial graph resume can never lead to a double expense row.
    const { claimAndExecuteLogExpense } = await import('@/agent/lib/graph/action-turn-graph')
    const r = await claimAndExecuteLogExpense(actionId)
    if (!r.executed) {
      return Response.json({ error: 'already_resolved', detail: r.reason ?? undefined }, { status: 409 })
    }
    return Response.json({ success: true, expenseId: r.expenseId })
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

  // Two-way Bangla phone call via ElevenLabs Conversational AI. Placed inline on
  // approval (synchronous API call ~ a few seconds) so the owner gets the
  // conversation_id immediately; the transcript + summary land later via webhook.
  if (action.type === 'agent_voice_call') {
    const p = payload as {
      phone?: string
      toNumber?: string
      recipientName?: string
      purpose?: string
      firstMessage?: string
    }
    const result = await placeOutboundCall({
      toNumber: String(p.toNumber ?? p.phone ?? ''),
      recipientName: p.recipientName,
      purpose: String(p.purpose ?? ''),
      firstMessage: String(p.firstMessage ?? ''),
      conversationId: resolveConversationId(action),
    })
    if (!result.ok) {
      await db.agentPendingAction.update({
        where: { id: actionId },
        data: { status: 'failed', resolvedAt: new Date(), result: { error: result.error } },
      })
      return Response.json({ error: result.error }, { status: 502 })
    }
    await db.agentPendingAction.update({
      where: { id: actionId },
      data: {
        status: 'executed',
        resolvedAt: new Date(),
        result: { callRecordId: result.callRecordId, elevenConvId: result.elevenConvId, callSid: result.callSid },
      },
    })
    return Response.json({
      success: true,
      message: 'কল দেওয়া হয়েছে — রিং হচ্ছে। কথা শেষ হলে সারাংশ পাবেন।',
      callRecordId: result.callRecordId,
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

  if (action.type === 'delete_finance_entry') {
    const { type, id, personName } = payload as {
      type: 'expense' | 'ledger'; id: string; personName?: string
    }
    if (type === 'expense') {
      const row = await db.agentFinanceExpense.findUnique({ where: { id } })
      if (!row || row.deleted) return Response.json({ error: 'expense_not_found' }, { status: 404 })
      await db.agentFinanceExpense.update({ where: { id }, data: { deleted: true } })
      await db.agentPendingAction.update({
        where: { id: actionId },
        data: { status: 'executed', resolvedAt: new Date(), result: { deleted: true, type, id } },
      })
      return Response.json({ success: true, message: 'খরচ মুছে ফেলা হয়েছে (soft-delete)।' })
    }

    const row = await db.agentFinanceLedger.findUnique({ where: { id } })
    if (!row || row.deleted) return Response.json({ error: 'ledger_not_found' }, { status: 404 })
    await db.agentFinanceLedger.update({ where: { id }, data: { deleted: true } })
    const { getPersonBalance } = await import('@/agent/lib/finance-shared')
    const balance = await getPersonBalance(personName || row.personName)
    await db.agentPendingAction.update({
      where: { id: actionId },
      data: {
        status: 'executed',
        resolvedAt: new Date(),
        result: { deleted: true, type, id, updatedBalance: balance },
      },
    })
    const balStr = Object.entries(balance.balances)
      .map(([c, v]) => `${c}: ${v}`)
      .join(', ')
    return Response.json({
      success: true,
      message: `${row.personName}-এর ব্যালেন্স আপডেট: ${balStr || '০'}`,
      updatedBalance: balance,
    })
  }

  if (action.type === 'edit_finance_entry') {
    const { type, id, field, newValue, personName } = payload as {
      type: 'expense' | 'ledger'; id: string; field: string; newValue: unknown; personName?: string
    }
    const data: Record<string, unknown> = { [field]: newValue }
    if (field === 'amount') data.amount = Math.round(Number(newValue))

    if (type === 'expense') {
      await db.agentFinanceExpense.update({ where: { id }, data })
      await db.agentPendingAction.update({
        where: { id: actionId },
        data: { status: 'executed', resolvedAt: new Date(), result: { type, id, field } },
      })
      return Response.json({ success: true, message: 'খরচ আপডেট হয়েছে।' })
    }

    const row = await db.agentFinanceLedger.update({ where: { id }, data })
    const { getPersonBalance } = await import('@/agent/lib/finance-shared')
    const balance = await getPersonBalance(personName || row.personName)
    await db.agentPendingAction.update({
      where: { id: actionId },
      data: {
        status: 'executed',
        resolvedAt: new Date(),
        result: { type, id, field, updatedBalance: balance },
      },
    })
    const balStr = Object.entries(balance.balances)
      .map(([c, v]) => `${c}: ${v}`)
      .join(', ')
    return Response.json({
      success: true,
      message: `${row.personName}-এর ব্যালেন্স আপডেট: ${balStr || '০'}`,
      updatedBalance: balance,
    })
  }

  if (action.type === 'duplicate_campaign') {
    const { campaignId } = payload as { campaignId: string }
    try {
      const claimed = await db.agentPendingAction.updateMany({
        where: { id: actionId, status: 'pending' },
        data: { status: 'approved', resolvedAt: new Date() },
      })
      if (claimed.count === 0) {
        return Response.json({ error: 'already_resolved' }, { status: 409 })
      }
      const { duplicateTopAdSet } = await import('@/agent/lib/meta-ads')
      const result = await duplicateTopAdSet(String(campaignId))
      if (!result.success) {
        await db.agentPendingAction.update({
          where: { id: actionId },
          data: { status: 'failed', result: { error: result.error } },
        })
        return Response.json({ error: result.error }, { status: 502 })
      }
      await db.agentPendingAction.update({
        where: { id: actionId },
        data: {
          status: 'executed',
          resolvedAt: new Date(),
          result: { newAdSetId: result.newAdSetId, campaignId },
        },
      })
      await appendConversationNote(
        db,
        action,
        `✅ Ad set duplicated (PAUSED). New ad set ID: ${result.newAdSetId}. Advantage+ learning safe — activate manually when ready.`,
      )
      return Response.json({ success: true, newAdSetId: result.newAdSetId, campaignId })
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err)
      await db.agentPendingAction.update({
        where: { id: actionId },
        data: { status: 'failed', result: { error: errMsg } },
      })
      return Response.json({ error: errMsg }, { status: 502 })
    }
  }

  if (action.type === 'launch_campaign') {
    const {
      name, dailyBudget, message, headline, imageUrl, page, ageMin, ageMax, audienceId, excludeAudienceId,
    } = payload as {
      name: string; dailyBudget: number; message: string;
      headline?: string; imageUrl?: string; page?: string; ageMin?: number; ageMax?: number;
      audienceId?: string; excludeAudienceId?: string
    }
    try {
      const claimed = await db.agentPendingAction.updateMany({
        where: { id: actionId, status: 'pending' },
        data: { status: 'approved', resolvedAt: new Date() },
      })
      if (claimed.count === 0) {
        return Response.json({ error: 'already_resolved' }, { status: 409 })
      }
      const { launchCampaign } = await import('@/agent/lib/meta-ads')
      const result = await launchCampaign({
        name: String(name),
        dailyBudgetBdt: Number(dailyBudget),
        message: String(message),
        headline: headline ? String(headline) : undefined,
        imageUrl: imageUrl ? String(imageUrl) : undefined,
        page: page ? String(page) : undefined,
        ageMin: ageMin != null ? Number(ageMin) : undefined,
        ageMax: ageMax != null ? Number(ageMax) : undefined,
        audienceId: audienceId ? String(audienceId) : undefined,
        excludeAudienceId: excludeAudienceId ? String(excludeAudienceId) : undefined,
      })
      if (!result.success) {
        await db.agentPendingAction.update({
          where: { id: actionId },
          data: { status: 'failed', result: { error: result.error, campaignId: result.campaignId, adSetId: result.adSetId, adId: result.adId } },
        })
        return Response.json({ error: result.error }, { status: 502 })
      }
      await db.agentPendingAction.update({
        where: { id: actionId },
        data: {
          status: 'executed',
          resolvedAt: new Date(),
          result: { campaignId: result.campaignId, adSetId: result.adSetId, adId: result.adId },
        },
      })
      await appendConversationNote(
        db,
        action,
        `✅ নতুন ক্যাম্পেইন তৈরি হয়েছে (সব PAUSED — কোনো টাকা খরচ হয়নি)।\nCampaign ID: ${result.campaignId}\nAd Set ID: ${result.adSetId}\nAd ID: ${result.adId}\nAds Manager-এ গিয়ে রিভিউ করে ACTIVE করলেই চালু হবে।`,
      )
      return Response.json({ success: true, campaignId: result.campaignId, adSetId: result.adSetId, adId: result.adId })
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err)
      await db.agentPendingAction.update({
        where: { id: actionId },
        data: { status: 'failed', result: { error: errMsg } },
      })
      return Response.json({ error: errMsg }, { status: 502 })
    }
  }

  // Phase MA3 — Meta Ads MCP write tools (create/update/catalog + activate).
  // The staging tool (meta-ads-write-tools.ts) already enforced kill switch +
  // connection + write tier + budget cap BEFORE this card existed. On Approve we
  // execute the exact remote call; Meta creates entities PAUSED, so only
  // meta_ads:ads_activate_entity actually starts spend.
  if (action.type.startsWith('meta_ads:')) {
    const { remoteName, args } = payload as { remoteName: string; args?: Record<string, unknown> }
    const claimed = await db.agentPendingAction.updateMany({
      where: { id: actionId, status: 'pending' },
      data: { status: 'approved', resolvedAt: new Date() },
    })
    if (claimed.count === 0) return Response.json({ error: 'already_resolved' }, { status: 409 })

    const activating = remoteName === 'ads_activate_entity'
    try {
      const { metaMcpCallTool } = await import('@/agent/lib/meta-mcp/client')
      const { logToolEvent } = await import('@/agent/lib/tool-telemetry')
      const result = await metaMcpCallTool(String(remoteName), (args ?? {}) as Record<string, unknown>)
      const text = (result.content ?? [])
        .filter((c) => c.type === 'text' && typeof c.text === 'string')
        .map((c) => c.text as string)
        .join('\n')

      if (result.isError) {
        await db.agentPendingAction.update({
          where: { id: actionId },
          data: { status: 'failed', result: { error: text.slice(0, 500) } },
        })
        void logToolEvent({
          toolName: `meta_ads:${remoteName}`,
          success: false,
          phase: 'approval',
          conversationId: action.conversationId,
          detail: { error: text.slice(0, 200) },
        })
        await appendConversationNote(db, action, `⚠️ Meta লেখা-কাজ ব্যর্থ: ${text.slice(0, 200)}`)
        return Response.json({ error: text.slice(0, 300) || 'meta_mcp_write_failed' }, { status: 502 })
      }

      let parsed: unknown = result.structuredContent
      if (parsed === undefined) {
        try {
          parsed = text ? JSON.parse(text) : null
        } catch {
          parsed = text
        }
      }
      await db.agentPendingAction.update({
        where: { id: actionId },
        data: { status: 'executed', resolvedAt: new Date(), result: { remoteName, data: parsed } },
      })
      // "Cost-log": Meta MCP calls are free, so the audit trail is this telemetry
      // row + the executed pending-action record (plan §6 "cost-log every write").
      void logToolEvent({
        toolName: `meta_ads:${remoteName}`,
        success: true,
        phase: 'approval',
        conversationId: action.conversationId,
        detail: { activating },
      })
      await appendConversationNote(
        db,
        action,
        activating
          ? '🔴 Meta অ্যাড ACTIVE করা হয়েছে — খরচ শুরু হলো।'
          : '✅ Meta-তে PAUSED অবস্থায় তৈরি/আপডেট হয়েছে — activate না করা পর্যন্ত খরচ শুরু হবে না।',
      )
      return Response.json({ success: true, remoteName, activating })
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err)
      await db.agentPendingAction.update({
        where: { id: actionId },
        data: { status: 'failed', result: { error: errMsg.slice(0, 500) } },
      })
      await appendConversationNote(db, action, `⚠️ Meta লেখা-কাজ ব্যর্থ: ${errMsg.slice(0, 200)}`)
      return Response.json({ error: errMsg }, { status: 502 })
    }
  }

  if (action.type === 'create_retargeting_audience') {
    const { name, page, retentionDays } = payload as {
      name: string; page?: string; retentionDays?: number
    }
    try {
      const claimed = await db.agentPendingAction.updateMany({
        where: { id: actionId, status: 'pending' },
        data: { status: 'approved', resolvedAt: new Date() },
      })
      if (claimed.count === 0) {
        return Response.json({ error: 'already_resolved' }, { status: 409 })
      }
      const { createEngagementCustomAudience } = await import('@/agent/lib/meta-audiences')
      const result = await createEngagementCustomAudience({
        name: String(name),
        page: page ? String(page) : undefined,
        retentionDays: retentionDays != null ? Number(retentionDays) : undefined,
      })
      if (!result.success) {
        await db.agentPendingAction.update({
          where: { id: actionId },
          data: { status: 'failed', result: { error: result.error } },
        })
        return Response.json({ error: result.error }, { status: 502 })
      }
      await db.agentPendingAction.update({
        where: { id: actionId },
        data: { status: 'executed', resolvedAt: new Date(), result: { audienceId: result.audienceId } },
      })
      await appendConversationNote(
        db,
        action,
        `✅ রিটার্গেটিং audience তৈরি হয়েছে — "${name}" (Audience ID: ${result.audienceId})। Meta কিছুক্ষণ পর population ভরবে। এখন launch_campaign-এ audienceId দিয়ে retargeting ad (PAUSED) চালানো যাবে।`,
      )
      return Response.json({ success: true, audienceId: result.audienceId })
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err)
      await db.agentPendingAction.update({
        where: { id: actionId },
        data: { status: 'failed', result: { error: errMsg } },
      })
      return Response.json({ error: errMsg }, { status: 502 })
    }
  }

  if (action.type === 'create_lookalike_audience') {
    const { name, sourceAudienceId, ratio, country } = payload as {
      name: string; sourceAudienceId: string; ratio?: number; country?: string
    }
    try {
      const claimed = await db.agentPendingAction.updateMany({
        where: { id: actionId, status: 'pending' },
        data: { status: 'approved', resolvedAt: new Date() },
      })
      if (claimed.count === 0) {
        return Response.json({ error: 'already_resolved' }, { status: 409 })
      }
      const { createLookalikeAudience } = await import('@/agent/lib/meta-audiences')
      const result = await createLookalikeAudience({
        name: String(name),
        sourceAudienceId: String(sourceAudienceId),
        ratio: ratio != null ? Number(ratio) : undefined,
        country: country ? String(country) : undefined,
      })
      if (!result.success) {
        await db.agentPendingAction.update({
          where: { id: actionId },
          data: { status: 'failed', result: { error: result.error } },
        })
        return Response.json({ error: result.error }, { status: 502 })
      }
      await db.agentPendingAction.update({
        where: { id: actionId },
        data: { status: 'executed', resolvedAt: new Date(), result: { audienceId: result.audienceId } },
      })
      await appendConversationNote(
        db,
        action,
        `✅ Lookalike audience তৈরি হয়েছে — "${name}" (Audience ID: ${result.audienceId})। Meta কিছুক্ষণ পর similar মানুষ খুঁজে population ভরবে। এখন launch_campaign-এ এই audienceId দিয়ে prospecting ad (PAUSED) চালানো যাবে।`,
      )
      return Response.json({ success: true, audienceId: result.audienceId })
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err)
      await db.agentPendingAction.update({
        where: { id: actionId },
        data: { status: 'failed', result: { error: errMsg } },
      })
      return Response.json({ error: errMsg }, { status: 502 })
    }
  }

  if (action.type === 'ads_creative_brief') {
    const claimed = await db.agentPendingAction.updateMany({
      where: { id: actionId, status: 'pending' },
      data: { status: 'approved', resolvedAt: new Date() },
    })
    if (claimed.count === 0) {
      return Response.json({ error: 'already_resolved' }, { status: 409 })
    }
    const { angleHint, campaignName, productCode } = payload as {
      angleHint?: string
      campaignName?: string
      productCode?: string | null
    }
    await appendConversationNote(
      db,
      action,
      `✅ Creative brief approved — make_ad_creatives চালান${productCode ? ` (${productCode})` : ''}. Angle: ${angleHint ?? 'নতুন hook'}. Campaign: ${campaignName ?? ''}`,
    )
    return Response.json({
      success: true,
      message: 'Creative brief approved. Agent should call make_ad_creatives with the angleHint.',
      angleHint,
      productCode,
    })
  }

  if (action.type === 'website_publish') {
    const { productId } = payload as { productId: string }
    const { publishWebsiteProduct } = await import('@/lib/website/write.service')
    const result = await publishWebsiteProduct(String(productId))
    if (!result.ok) {
      await db.agentPendingAction.update({
        where: { id: actionId },
        data: { status: 'failed', result: { error: result.error } },
      })
      return Response.json({ error: result.error }, { status: 502 })
    }
    await db.agentPendingAction.update({
      where: { id: actionId },
      data: { status: 'executed', resolvedAt: new Date(), result },
    })
    await appendConversationNote(db, action, `✅ Website publish: ${result.slug} এখন live। ISR/cache — পেজে দেখতে কিছুক্ষণ লাগতে পারে।`)
    return Response.json({ success: true, ...result })
  }

  if (action.type === 'website_unpublish') {
    const { productId } = payload as { productId: string }
    const { unpublishWebsiteProduct } = await import('@/lib/website/write.service')
    const result = await unpublishWebsiteProduct(String(productId))
    if (!result.ok) {
      await db.agentPendingAction.update({
        where: { id: actionId },
        data: { status: 'failed', result: { error: result.error } },
      })
      return Response.json({ error: result.error }, { status: 502 })
    }
    await db.agentPendingAction.update({
      where: { id: actionId },
      data: { status: 'executed', resolvedAt: new Date(), result },
    })
    await appendConversationNote(db, action, `✅ Website unpublish: ${result.slug} storefront থেকে সরানো হয়েছে।`)
    return Response.json({ success: true, ...result })
  }

  if (action.type === 'website_set_featured') {
    const { productId, featured } = payload as { productId: string; featured: boolean }
    const { setWebsiteProductFeatured } = await import('@/lib/website/write.service')
    const result = await setWebsiteProductFeatured(String(productId), featured === true)
    if (!result.ok) {
      await db.agentPendingAction.update({
        where: { id: actionId },
        data: { status: 'failed', result: { error: result.error } },
      })
      return Response.json({ error: result.error }, { status: 502 })
    }
    await db.agentPendingAction.update({
      where: { id: actionId },
      data: { status: 'executed', resolvedAt: new Date(), result: { ...result, featured } },
    })
    await appendConversationNote(db, action, `✅ Website featured ${featured ? 'ON' : 'OFF'}: ${result.slug}।`)
    return Response.json({ success: true, ...result, featured })
  }

  if (action.type === 'website_update_product') {
    const { productId, fields } = payload as {
      productId: string
      fields: { priceBdt?: number; description?: string; shortDescription?: string; categoryId?: string }
    }
    const { updateWebsiteProductFields } = await import('@/lib/website/write.service')
    const result = await updateWebsiteProductFields(String(productId), fields ?? {})
    if (!result.ok) {
      await db.agentPendingAction.update({
        where: { id: actionId },
        data: { status: 'failed', result: { error: result.error } },
      })
      return Response.json({ error: result.error }, { status: 502 })
    }
    await db.agentPendingAction.update({
      where: { id: actionId },
      data: { status: 'executed', resolvedAt: new Date(), result: { ...result, fields } },
    })
    await appendConversationNote(db, action, `✅ Website update: ${result.slug} আপডেট হয়েছে। ISR/cache — live page দেখতে কিছুক্ষণ লাগতে পারে।`)
    return Response.json({ success: true, ...result })
  }

  if (action.type === 'auto_fix') {
    const claimed = await db.agentPendingAction.updateMany({
      where: { id: actionId, status: 'pending' },
      data: { status: 'approved', resolvedAt: new Date() },
    })
    if (claimed.count === 0) {
      return Response.json({ error: 'already_resolved' }, { status: 409 })
    }
    const workerUrl = process.env.AGENT_WORKER_DIAGNOSTIC_URL?.replace(/\/$/, '')
    const internalToken = process.env.AGENT_INTERNAL_TOKEN
    if (workerUrl && internalToken) {
      try {
        await fetch(`${workerUrl}/auto-fix-run`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${internalToken}`,
          },
          body: JSON.stringify({ actionId, issue: payload }),
          signal: AbortSignal.timeout(10_000),
        })
      } catch (err) {
        console.warn('[approve] auto-fix worker dispatch failed:', err instanceof Error ? err.message : err)
      }
    }
    await appendConversationNote(db, action, '✅ Auto-Fix অনুমোদিত — Cursor agent শুরু হচ্ছে।')
    return Response.json({
      success: true,
      message: 'Auto-fix approved and dispatched to worker.',
    })
  }

  if (action.type === 'todo_cancel') {
    const { todoId, title } = payload as { todoId: string; title?: string }
    const existing = await db.agentTodo.findUnique({ where: { id: String(todoId) } })
    if (!existing) {
      await db.agentPendingAction.update({
        where: { id: actionId },
        data: { status: 'executed', resolvedAt: new Date(), result: { skipped: 'todo_not_found' } },
      })
      return Response.json({ success: true, message: 'টুডু আগেই নেই — কিছু করার দরকার ছিল না।' })
    }
    // Soft-cancel — never hard-delete (recoverable).
    await db.agentTodo.update({ where: { id: String(todoId) }, data: { status: 'cancelled' } })
    await db.agentPendingAction.update({
      where: { id: actionId },
      data: { status: 'executed', resolvedAt: new Date(), result: { todoId, cancelled: true } },
    })
    await appendConversationNote(
      db,
      action,
      `🗑️ "${title ?? existing.title}" তালিকা থেকে সরানো হয়েছে (soft — রেকর্ডে আছে, ফেরানো যাবে)।`,
    )
    return Response.json({ success: true, todoId, cancelled: true, message: 'টুডু তালিকা থেকে সরানো হয়েছে।' })
  }

  if (action.type === 'staff_task_explanation') {
    const { taskId, staffName, explanation } = payload as {
      taskId: string; staffName?: string; explanation: string
    }
    const claimed = await db.agentPendingAction.updateMany({
      where: { id: actionId, status: 'pending' },
      data: { status: 'approved', resolvedAt: new Date() },
    })
    if (claimed.count === 0) {
      return Response.json({ error: 'already_resolved' }, { status: 409 })
    }
    const existing = await db.agentStaffTask.findUnique({ where: { id: String(taskId) } })
    if (!existing) {
      await db.agentPendingAction.update({
        where: { id: actionId },
        data: { status: 'executed', resolvedAt: new Date(), result: { skipped: 'task_not_found' } },
      })
      return Response.json({ success: true, message: 'টাস্কটি আর নেই — কিছু করার দরকার ছিল না।' })
    }
    // The explanation lives in the task's `detail` — which is exactly what the
    // staff member sees in অফিস (portal/office). No Telegram send here.
    await db.agentStaffTask.update({
      where: { id: String(taskId) },
      data: { detail: String(explanation) },
    })
    await db.agentPendingAction.update({
      where: { id: actionId },
      data: { status: 'executed', resolvedAt: new Date(), result: { taskId, explained: true } },
    })
    await appendConversationNote(
      db,
      action,
      `🧠 "${existing.title}" — ${staffName ?? 'স্টাফ'}-কে কাজটি বুঝিয়ে দেওয়া হয়েছে। এখন তার অফিস ভিউতে দেখাবে।`,
    )
    return Response.json({
      success: true,
      taskId,
      explained: true,
      message: 'Explanation saved — it now shows in the staff member’s office view.',
    })
  }

  // Staff idle nudge: owner saw the camera alert and tapped Approve → forward the
  // frame + a name-free gentle reminder to staff. No identity is ever attached —
  // the reminder blames no one. Recipients are resolved in this order:
  //   1. payload.test === true  → OWNER only (safe full-loop proof, never bothers staff)
  //   2. KV `idle_nudge_chat_id` set → that single chat (optional: a group, if one ever exists)
  //   3. otherwise → broadcast to every active staffer's individual Telegram DM
  // There is NO Telegram group in this business; the default path is per-staff DMs.
  if (action.type === 'staff_idle_nudge') {
    const claimed = await db.agentPendingAction.updateMany({
      where: { id: actionId, status: 'pending' },
      data: { status: 'approved', resolvedAt: new Date() },
    })
    if (claimed.count === 0) {
      return Response.json({ error: 'already_resolved' }, { status: 409 })
    }

    const p = payload as { photoUrl?: string; message?: string; deviceId?: string; test?: boolean }
    const message = String(
      p.message ??
        'অফিসে কাজের সময় একটু মনোযোগ দিন — আজ অনেক কাজ বাকি। ধন্যবাদ 🙏',
    )

    const { sendTelegramPhoto, sendTelegramText } = await import('@/agent/lib/telegram-owner-notify')

    // Resolve a single fresh snapshot once (the Imou signed URL expires ~1hr); reused
    // across all recipients so we don't hammer the camera per-DM.
    let freshUrl: string | null = null
    async function resolveFreshUrl(): Promise<string | null> {
      if (freshUrl !== null) return freshUrl
      if (!p.deviceId) return null
      try {
        const { captureImouSnapshot } = await import('@/agent/lib/imou-camera')
        const fresh = await captureImouSnapshot(String(p.deviceId))
        freshUrl = fresh.url
      } catch (err) {
        console.warn('[approve] idle nudge fresh snapshot failed:', err instanceof Error ? err.message : err)
        freshUrl = ''
      }
      return freshUrl || null
    }

    // Send the photo+message to one chat, with fresh-snapshot then text-only fallback.
    async function sendToChat(chatId: string): Promise<{ ok: boolean; error?: string }> {
      let send = await sendTelegramPhoto(chatId, String(p.photoUrl ?? ''), message)
      if (!send.ok) {
        const fresh = await resolveFreshUrl()
        if (fresh) send = await sendTelegramPhoto(chatId, fresh, message)
      }
      if (!send.ok) send = await sendTelegramText(chatId, message)
      return send
    }

    // 1. Test mode → owner only.
    if (p.test === true) {
      const ownerChatId = (process.env.TELEGRAM_OWNER_CHAT_ID ?? '').trim()
      if (!ownerChatId) {
        await db.agentPendingAction.update({
          where: { id: actionId },
          data: { status: 'failed', result: { error: 'no_owner_chat_id' } },
        })
        return Response.json({ error: 'TELEGRAM_OWNER_CHAT_ID not set' }, { status: 502 })
      }
      const send = await sendToChat(ownerChatId)
      if (!send.ok) {
        await db.agentPendingAction.update({
          where: { id: actionId },
          data: { status: 'failed', result: { error: send.error } },
        })
        return Response.json({ error: send.error ?? 'send_failed' }, { status: 502 })
      }
      await db.agentPendingAction.update({
        where: { id: actionId },
        data: { status: 'executed', resolvedAt: new Date(), result: { test: true, sentTo: ownerChatId } },
      })
      await appendConversationNote(db, action, '✅ টেস্ট: রিমাইন্ডারটি আপনার (Owner) Telegram-এই পাঠানো হয়েছে — স্টাফদের বিরক্ত করা হয়নি।')
      return Response.json({ success: true, test: true, message: 'Test reminder sent to owner only.' })
    }

    // 2. Optional single-chat override (e.g. a group, if one is ever configured).
    const kv = await db.agentKvSetting
      .findUnique({ where: { key: 'idle_nudge_chat_id' }, select: { value: true } })
      .catch(() => null)
    const overrideChatId = (kv?.value ?? process.env.TELEGRAM_STAFF_GROUP_CHAT_ID ?? '').trim()

    if (overrideChatId) {
      const send = await sendToChat(overrideChatId)
      if (!send.ok) {
        await db.agentPendingAction.update({
          where: { id: actionId },
          data: { status: 'failed', result: { error: send.error } },
        })
        return Response.json({ error: send.error ?? 'send_failed' }, { status: 502 })
      }
      await db.agentPendingAction.update({
        where: { id: actionId },
        data: { status: 'executed', resolvedAt: new Date(), result: { sentTo: overrideChatId } },
      })
      await appendConversationNote(db, action, '✅ স্টাফদের (নাম ছাড়া) রিমাইন্ডার পাঠানো হয়েছে।')
      return Response.json({ success: true, message: 'Reminder sent.' })
    }

    // 3. Default → broadcast to each active staffer's individual Telegram DM.
    const staff = await db.agentStaff.findMany({
      where: { active: true, businessId: 'ALMA_LIFESTYLE', telegramChatId: { not: null } },
      select: { name: true, telegramChatId: true },
    })

    if (staff.length === 0) {
      await db.agentPendingAction.update({
        where: { id: actionId },
        data: { status: 'executed', resolvedAt: new Date(), result: { skipped: 'no_staff_chat_ids' } },
      })
      return Response.json({
        success: true,
        skipped: true,
        message:
          'কোনো অ্যাক্টিভ স্টাফের Telegram chat ID পাওয়া যায়নি — তাই রিমাইন্ডার পাঠানো যায়নি।',
      })
    }

    let sentCount = 0
    const failures: string[] = []
    for (const s of staff) {
      const chatId = (s.telegramChatId ?? '').trim()
      if (!chatId) continue
      const send = await sendToChat(chatId)
      if (send.ok) sentCount++
      else failures.push(`${s.name}: ${send.error ?? 'send_failed'}`)
    }

    if (sentCount === 0) {
      await db.agentPendingAction.update({
        where: { id: actionId },
        data: { status: 'failed', result: { error: 'all_sends_failed', failures } },
      })
      return Response.json({ error: 'all_sends_failed', failures }, { status: 502 })
    }

    await db.agentPendingAction.update({
      where: { id: actionId },
      data: {
        status: 'executed',
        resolvedAt: new Date(),
        result: { sentCount, total: staff.length, failures: failures.length ? failures : undefined },
      },
    })
    await appendConversationNote(
      db,
      action,
      `✅ ${sentCount} জন স্টাফকে (নাম ছাড়া) রিমাইন্ডার পাঠানো হয়েছে।`,
    )
    return Response.json({
      success: true,
      message: `Reminder sent to ${sentCount}/${staff.length} staff.`,
      sentCount,
    })
  }

  // ── Office-absence flow ───────────────────────────────────────────────────
  // Card 1 ✅ হ্যাঁ: owner confirms he sent someone out → offer snooze durations.
  if (action.type === 'office_absence_confirm') {
    const claimed = await db.agentPendingAction.updateMany({
      where: { id: actionId, status: 'pending' },
      data: { status: 'approved', resolvedAt: new Date() },
    })
    if (claimed.count === 0) return Response.json({ error: 'already_resolved' }, { status: 409 })

    const p = payload as { photoUrl?: string; deviceId?: string }
    const { sendAbsenceSnoozeOptions } = await import('@/agent/lib/office-absence')
    const res = await sendAbsenceSnoozeOptions({
      photoUrl: String(p.photoUrl ?? ''),
      deviceId: String(p.deviceId ?? ''),
    })
    await db.agentPendingAction.update({
      where: { id: actionId },
      data: { status: res.ok ? 'executed' : 'failed', result: res.ok ? { askedDuration: true } : { error: res.error } },
    })
    if (!res.ok) return Response.json({ error: res.error ?? 'send_failed' }, { status: 502 })
    return Response.json({ success: true, message: 'Snooze duration options sent.' })
  }

  // A snooze-duration button → authorise 1 absent for N hours.
  if (action.type === 'office_absence_snooze') {
    const claimed = await db.agentPendingAction.updateMany({
      where: { id: actionId, status: 'pending' },
      data: { status: 'approved', resolvedAt: new Date() },
    })
    if (claimed.count === 0) return Response.json({ error: 'already_resolved' }, { status: 409 })

    const p = payload as { hours?: number; authorizedAbsent?: number; groupId?: string }
    const hours = Number(p.hours) > 0 ? Number(p.hours) : 2
    const { applyAbsenceSnooze, cancelAbsenceSiblings } = await import('@/agent/lib/office-absence')
    const { until } = await applyAbsenceSnooze(hours, Number(p.authorizedAbsent) || 1)
    await cancelAbsenceSiblings(String(p.groupId ?? ''), actionId)

    const untilLabel = new Intl.DateTimeFormat('bn-BD', {
      timeZone: 'Asia/Dhaka', hour: 'numeric', minute: '2-digit', hour12: true,
    }).format(until)
    await db.agentPendingAction.update({
      where: { id: actionId },
      data: { status: 'executed', result: { snoozeHours: hours, until: until.toISOString() } },
    })
    const { sendOwnerText } = await import('@/agent/lib/telegram-owner-notify')
    await sendOwnerText(`✅ ঠিক আছে Boss — ${untilLabel} পর্যন্ত ১ জন কম থাকলেও সব ঠিক ধরে নেব। সময় শেষে আবার চেক করব।`)
    return Response.json({ success: true, snoozeHours: hours, until: until.toISOString() })
  }

  // A staff-name button → owner named the absent staffer. DON'T message the staffer
  // yet; first show the owner a final preview (image + exact text) with a ✅ পাঠান /
  // ❌ বাতিল pair. The staffer only hears about it after that explicit approval.
  if (action.type === 'office_absence_nudge') {
    const claimed = await db.agentPendingAction.updateMany({
      where: { id: actionId, status: 'pending' },
      data: { status: 'approved', resolvedAt: new Date() },
    })
    if (claimed.count === 0) return Response.json({ error: 'already_resolved' }, { status: 409 })

    const p = payload as { staffId?: string; staffName?: string; photoUrl?: string; deviceId?: string; groupId?: string }
    const { sendAbsenceNudgePreview, cancelAbsenceSiblings } = await import('@/agent/lib/office-absence')
    const res = await sendAbsenceNudgePreview({
      staffId: String(p.staffId ?? ''),
      staffName: String(p.staffName ?? ''),
      photoUrl: String(p.photoUrl ?? ''),
      deviceId: String(p.deviceId ?? ''),
    })
    await cancelAbsenceSiblings(String(p.groupId ?? ''), actionId)
    await db.agentPendingAction.update({
      where: { id: actionId },
      data: { status: res.ok ? 'executed' : 'failed', result: res.ok ? { previewedStaff: p.staffName } : { error: res.error } },
    })
    if (!res.ok) return Response.json({ error: res.error ?? 'send_failed' }, { status: 502 })
    return Response.json({ success: true, message: 'Nudge preview sent for final approval.' })
  }

  // ✅ পাঠান on the preview → NOW actually send the camera frame + nudge to the staffer.
  if (action.type === 'office_absence_nudge_send') {
    const claimed = await db.agentPendingAction.updateMany({
      where: { id: actionId, status: 'pending' },
      data: { status: 'approved', resolvedAt: new Date() },
    })
    if (claimed.count === 0) return Response.json({ error: 'already_resolved' }, { status: 409 })

    const p = payload as { staffId?: string; staffName?: string; photoUrl?: string; deviceId?: string }
    const { sendAbsenceNudgeToStaff } = await import('@/agent/lib/office-absence')
    const res = await sendAbsenceNudgeToStaff({
      staffId: String(p.staffId ?? ''),
      staffName: String(p.staffName ?? ''),
      photoUrl: String(p.photoUrl ?? ''),
      deviceId: String(p.deviceId ?? ''),
    })
    await db.agentPendingAction.update({
      where: { id: actionId },
      data: { status: res.ok ? 'executed' : 'failed', result: res.ok ? { nudgedStaff: p.staffName } : { error: res.error } },
    })
    const { sendOwnerText } = await import('@/agent/lib/telegram-owner-notify')
    if (res.ok) {
      await sendOwnerText(`📨 ${p.staffName ?? 'স্টাফ'}-কে ছবিসহ মেসেজ পাঠিয়ে দিয়েছি — অফিসে ফিরে কাজ শেষ করতে বলা হয়েছে।`)
      return Response.json({ success: true, nudged: p.staffName })
    }
    await sendOwnerText(`⚠️ ${p.staffName ?? 'স্টাফ'}-কে মেসেজ পাঠানো গেল না (${res.error ?? 'unknown'})।`)
    return Response.json({ error: res.error ?? 'send_failed' }, { status: 502 })
  }

  return Response.json({ error: 'unknown_action_type', type: action.type }, { status: 400 })
}

/**
 * Public route handler. Runs the approval (runApprove) UNCHANGED, then — only on a
 * successful approval — resumes the agent so it continues its task on its own
 * instead of going silent until Boss messages again (owner request, issue #3).
 *
 * Why a wrapper: the approval body has many per-action-type branches (incl. sensitive
 * finance), each returning its own response — there is no single tail to hook. The
 * wrapper keeps that logic 100% untouched and bolts the continuation on the outside.
 * It is fully isolated: a failure here never affects the approval response, and it
 * no-ops gracefully when the worker queue (Redis) isn't configured or the owner has
 * flipped the kill switch off. The continuation runs through the SAME headless turn
 * path the VPS worker / Telegram already use, so it works whether Boss approved from
 * the app OR Telegram.
 */
export async function POST(
  req: NextRequest,
  ctx: { params: { id: string } },
) {
  // Live progress from the FIRST second (owner ask 2026-07-13, Claude-Code
  // parity): before the action executes, drop a "করছি বস" line + open a running
  // turn — the app's 12s poll surfaces both, so the owner watches the work
  // instead of a minute of silence followed by a surprise "done" message.
  // Phase 4 execution guard: approving a card whose canonical WorkflowRun the
  // owner already cancelled/finished must NOT execute (stale card). Fail-open
  // on lookup errors — blocks only on a positive terminal finding.
  try {
    const { workflowBlocksApproval } = await import('@/agent/lib/workflow-run')
    const guard = await workflowBlocksApproval(ctx.params.id)
    if (guard.blocked) {
      return Response.json({ error: 'workflow_outdated', message: guard.reason }, { status: 409 })
    }
  } catch { /* fail-open */ }

  const progress = await beginApprovalProgress(ctx.params.id)
  const res = await runApprove(req, ctx)
  // Phase 4 sync: transition the linked WorkflowRun to the card's REAL status
  // (executed→done+proof, approved→waiting_worker …). Awaited but tiny; a sync
  // failure never affects the approval response.
  try {
    const { syncWorkflowWithPendingAction } = await import('@/agent/lib/workflow-run')
    await syncWorkflowWithPendingAction(ctx.params.id, 'approval')
  } catch (err) {
    console.warn('[approve] workflow sync failed (approval unaffected):', err instanceof Error ? err.message : err)
  }
  try {
    if (res.status >= 200 && res.status < 300) {
      await enqueueApprovalContinuation(ctx.params.id, progress?.turnId ?? null)
    } else if (progress?.turnId) {
      await finalizeTurnIfRunning(progress.turnId, 'error')
    }
  } catch (err) {
    // The approval already succeeded and was returned to the caller; a continuation
    // hiccup must never surface as an approval failure.
    console.warn('[approve] continuation enqueue failed (approval unaffected):', err instanceof Error ? err.message : err)
    if (progress?.turnId) await finalizeTurnIfRunning(progress.turnId, 'done')
  }
  return res
}

/**
 * Pre-execution progress presence: an instant assistant line + a running turn row
 * on the action's conversation. The turn is REUSED by the follow-up continuation
 * (sync actions) or by /internal/job-result (async image/video renders, which find
 * it via payload.progressTurnId) and finalized there — the ghost-heal in
 * turn-status.ts is the crash backstop. Best-effort: an approval must never fail
 * because the progress note couldn't be written.
 */
async function beginApprovalProgress(actionId: string): Promise<{ turnId: string } | null> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const db = prisma as any
    const action = await db.agentPendingAction.findUnique({
      where: { id: actionId },
      select: { conversationId: true, status: true, type: true, payload: true, summary: true },
    })
    if (!action || action.status !== 'pending') return null
    const conversationId = resolveConversationId(action)
    if (!conversationId) return null

    const isRender = action.type === 'image_gen' || action.type === 'video_gen'
    // Contextual, not canned (owner ask 2026-07-13 round 2): acknowledge the
    // SPECIFIC job like a person would, then keep the thread visibly working.
    const summaryLine = String(action.summary ?? '').split('\n')[0].slice(0, 80).trim()
    await appendConversationNote(
      db,
      action,
      isRender
        ? '🎨 ঠিক আছে বস — ছবিটা বানানো শুরু করলাম (সাধারণত ৩০–৯০ সেকেন্ড)। রেডি হলেই এখানে preview দেখাব।'
        : `⏳ অনুমোদন পেলাম বস${summaryLine ? ` — "${summaryLine}"` : ''} — এখনই করছি, শেষ করে ফলাফল জানাচ্ছি…`,
    )
    const { createTurn } = await import('@/agent/lib/turn-status')
    const turnId = await createTurn(conversationId)
    if (!turnId) return null

    if (isRender) {
      // The render finishes in /internal/job-result — hand it the turn to close.
      await db.agentPendingAction.update({
        where: { id: actionId },
        data: { payload: { ...(action.payload as Record<string, unknown>), progressTurnId: turnId } },
      })
    }
    return { turnId }
  } catch (err) {
    console.warn('[approve] progress presence failed (approval unaffected):', err instanceof Error ? err.message : err)
    return null
  }
}

/**
 * Enqueue one continuation turn for the conversation the just-approved action belongs
 * to. Delegates to the shared enqueueAgentContinuation (createTurn → buildTurnJobData →
 * enqueueTurnJob) the VPS worker drains, running the turn through the chat route (which
 * persists the reply for the app poll AND notifies Telegram), so both surfaces resume.
 * No infinite loop: a continuation only ever fires from a human approval, and the turn
 * is told not to redo the action.
 */
async function enqueueApprovalContinuation(actionId: string, reuseTurnId: string | null = null): Promise<void> {
  // Whatever early-return path we take below, a progress turn opened at approve
  // time must not stay 'running' forever — except for renders, whose turn is
  // closed by /internal/job-result once the artifact lands.
  const settleProgress = async (actionType?: string) => {
    if (reuseTurnId && actionType !== 'image_gen' && actionType !== 'video_gen') {
      await finalizeTurnIfRunning(reuseTurnId, 'done')
    }
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = prisma as any
  const action = await db.agentPendingAction.findUnique({
    where: { id: actionId },
    select: { conversationId: true, status: true, summary: true, type: true },
  })
  const conversationId: string | null = action?.conversationId ?? null
  if (!conversationId) { await settleProgress(action?.type); return }
  // Only continue once the action genuinely resolved (guards against a 2xx that
  // wasn't an approval, e.g. an idempotent no-op).
  if (action.status !== 'approved' && action.status !== 'executed') { await settleProgress(action.type); return }

  // Async generation jobs (image/video) are NOT finished at approval time — the VPS
  // worker produces the artifact 30–60s later and reports via /internal/job-result,
  // which owns the continuation so the head resumes WITH the generated media already
  // in the conversation. Firing here would run the head before the image exists, so it
  // couldn't chain to the next step (e.g. an Instagram post) and the flow would stall.
  if (action.type === 'image_gen' || action.type === 'video_gen') return

  const summary = (action.summary ?? '').toString().slice(0, 200)
  const message =
    '[সিস্টেম নোট — Boss approve করেছেন] একটা pending কাজ Boss approve করেছেন এবং সেটা সম্পন্ন হয়েছে' +
    (summary ? `: "${summary}"` : '') +
    '। এখন থেমে যেও না — তোমার চলমান কাজের পরের ধাপে নিজে থেকে এগোও, অথবা সব শেষ হলে সংক্ষেপে Boss-কে জানাও। ' +
    'যে কাজটা এইমাত্র approve হয়ে সম্পন্ন হয়েছে সেটা আর নতুন করে কোরো না।'

  await enqueueAgentContinuation({ conversationId, message, turnId: reuseTurnId })
}
