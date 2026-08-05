/**
 * Automatic visual proof for a state-changing Mac UI act.
 *
 * The approved action route should call this instead of enqueueing the ui_*
 * command directly.  It captures the allowlisted APP WINDOW before the act,
 * executes the already-approved act, captures the same app window after it,
 * and stores two visibly-labelled images.  Captures are `ui_screenshot` (not
 * full-screen), so unrelated windows are never widened into the proof.
 *
 * A missing BEFORE capture fails closed: without it there is no honest pair and
 * the act has not happened yet.  A missing AFTER capture is reported as an
 * incomplete proof after the act; callers must not turn that into a confirmed
 * completion claim.
 */
import {
  awaitResult,
  enqueueCommand,
  getCommand,
  markUiProofDeferred,
  type CommandOutcome,
} from '@/agent/lib/mac-agent/bus'
import {
  shareAnnotatedScreenshot,
  type ScreenshotShareResult,
} from '@/agent/lib/mac-agent/screenshot-share'
import { verifyUiOutcome, type UiOutcomeCheck } from '@/agent/lib/mac-agent/ui-postcondition'
import { prisma } from '@/lib/prisma'

export const VISUAL_PROOF_UI_ACTIONS = new Set(['ui_click', 'ui_type', 'ui_key', 'ui_new_chat'])

export interface UiVisualProofImage {
  phase: 'before' | 'after'
  commandId: string
  imageUrl: string
  actionLabel: string
}

export interface UiActionVisualProofResult {
  actionCommandId: string | null
  actionOutcome: CommandOutcome | null
  verification: UiOutcomeCheck | null
  images: UiVisualProofImage[]
  /** True only when both real captures were stored. */
  proofComplete: boolean
  /** Stable reason for checkpoint/recovery logic. */
  proofError: string | null
  /** Durable AFTER capture already queued behind the action when sync time ends. */
  pendingAfterCommandId?: string | null
}

function actionLabel(input: {
  uiAction: string
  elementLabel?: string | null
  key?: string | null
}): string {
  const target = input.elementLabel?.trim() || input.key?.trim() || 'app window'
  switch (input.uiAction) {
    case 'ui_click': return `Click — ${target}`
    case 'ui_type': return `Type — ${target}`
    case 'ui_key': return `Key — ${target}`
    case 'ui_new_chat': return 'Open new chat'
    default: return `${input.uiAction} — ${target}`
  }
}

function sharedImage(
  phase: 'before' | 'after',
  commandId: string,
  label: string,
  shared: ScreenshotShareResult,
): UiVisualProofImage | null {
  return shared.ok ? { phase, commandId, imageUrl: shared.imageUrl, actionLabel: label } : null
}

async function collectCapture(
  commandId: string,
  phase: 'before' | 'after',
  label: string,
  waitMs: number,
  detail?: string | null,
): Promise<{ image: UiVisualProofImage | null; error: string | null }> {
  const result = await awaitResult(commandId, Math.max(1, waitMs))
  if (result.timedOut) return { image: null, error: `${phase}_capture_timeout` }
  if (result.status !== 'done') {
    return { image: null, error: `${phase}_capture_failed:${result.error ?? result.status}` }
  }
  const shared = await shareAnnotatedScreenshot(result.stdout, commandId, {
    phase,
    actionLabel: label,
    detail,
  })
  const image = sharedImage(phase, commandId, label, shared)
  return {
    image,
    error: image ? null : `${phase}_capture_share_failed`,
  }
}

export async function runUiActionWithVisualProof(input: {
  deviceId: string
  uiAction: string
  params: Record<string, unknown>
  approvedBy: string
  /** Whole approval-route budget. Default leaves 15s under its 120s cap. */
  budgetMs?: number
}): Promise<UiActionVisualProofResult> {
  if (!VISUAL_PROOF_UI_ACTIONS.has(input.uiAction)) {
    throw new Error(`visual_proof_unsupported_action:${input.uiAction}`)
  }
  const bundleId = String(input.params.bundleId ?? '').trim()
  if (!bundleId) throw new Error('visual_proof_bundle_required')
  const label = actionLabel({
    uiAction: input.uiAction,
    elementLabel: typeof input.params.elementLabel === 'string' ? input.params.elementLabel : null,
    key: typeof input.params.key === 'string' ? input.params.key : null,
  })
  // The approval wrapper may run a 90s continuation under a 120s route cap.
  // This whole visual/action phase therefore owns at most 25s.
  const deadline = Date.now() + Math.min(Math.max(input.budgetMs ?? 25_000, 15_000), 25_000)
  const left = () => Math.max(1, deadline - Date.now())

  const { id: beforeId } = await enqueueCommand({
    deviceId: input.deviceId,
    action: 'ui_screenshot',
    params: { bundleId, proofPhase: 'before', proofActionLabel: label },
    policyLevel: 'green',
  })
  const before = await collectCapture(
    beforeId,
    'before',
    label,
    Math.min(6_000, left()),
    'Approved action has not run yet',
  )
  if (!before.image) {
    return {
      actionCommandId: null,
      actionOutcome: null,
      verification: null,
      images: [],
      proofComplete: false,
      proofError: before.error,
      pendingAfterCommandId: null,
    }
  }

  const { id: actionCommandId } = await enqueueCommand({
    deviceId: input.deviceId,
    action: input.uiAction as Parameters<typeof enqueueCommand>[0]['action'],
    params: input.params,
    policyLevel: 'amber',
    approvedBy: input.approvedBy,
  })
  // Queue AFTER immediately, before waiting. The daemon bus is serial, so this
  // capture cannot run until the approved act resolves. If this HTTP request
  // reaches its bounded deadline, the proof capture is still durable in DB and
  // will execute — route timeout cannot silently drop it.
  const { id: afterId } = await enqueueCommand({
    deviceId: input.deviceId,
    action: 'ui_screenshot',
    params: {
      bundleId,
      proofPhase: 'after',
      proofActionLabel: label,
      proofForCommandId: actionCommandId,
      proofPendingActionId: input.approvedBy,
      proofBeforeImageUrl: before.image.imageUrl,
      // The approval route owns normal results. It flips this only after its
      // bounded wait ends, preventing the result callback from double-delivering
      // proof or starting a second continuation on the synchronous path.
      proofDeferred: false,
    },
    policyLevel: 'green',
  })
  const actionWait = Math.min(12_000, Math.max(1, left() - 6_000))
  const actionOutcome = await awaitResult(actionCommandId, actionWait)
  const verification = actionOutcome.timedOut
    ? null
    : verifyUiOutcome({
        uiAction: input.uiAction,
        text: typeof input.params.text === 'string' ? input.params.text : null,
        elementLabel: typeof input.params.elementLabel === 'string' ? input.params.elementLabel : null,
        stdout: actionOutcome.stdout,
        status: actionOutcome.status,
      })

  // A still-running action occupies the daemon's serial queue; queueing a
  // screenshot behind it and timing out would manufacture no useful evidence.
  if (actionOutcome.timedOut) {
    await markUiProofDeferred(afterId)
    return {
      actionCommandId,
      actionOutcome,
      verification,
      images: [before.image],
      proofComplete: false,
      proofError: 'action_still_running_after_before_capture',
      pendingAfterCommandId: afterId,
    }
  }

  const afterDetail = verification
    ? `${verification.verdict.toUpperCase()} — ${verification.reasonBn || 'postcondition checked'}`
    : actionOutcome.status === 'done' ? 'Action returned, postcondition unavailable' : 'Action failed'
  const after = await collectCapture(afterId, 'after', label, Math.min(6_000, left()), afterDetail)
  let pendingAfterCommandId: string | null = null
  if (!after.image) {
    const transferred = await markUiProofDeferred(afterId)
    if (transferred) {
      pendingAfterCommandId = afterId
    } else {
      // The result won the terminal-status race just as our wait expired. It was
      // not handed to the callback, so collect it once more on the synchronous
      // owner and let the approval wrapper enqueue the single continuation.
      const lateAfter = await collectCapture(afterId, 'after', label, 1_000, afterDetail)
      if (lateAfter.image) {
        return {
          actionCommandId,
          actionOutcome,
          verification,
          images: [before.image, lateAfter.image],
          proofComplete: true,
          proofError: null,
          pendingAfterCommandId: null,
        }
      }
    }
  }
  return {
    actionCommandId,
    actionOutcome,
    verification,
    images: after.image ? [before.image, after.image] : [before.image],
    proofComplete: Boolean(after.image),
    proofError: after.error,
    // A terminal failed/cancelled screenshot is not pending. Only the atomic
    // ownership handoff above may put the approval wrapper into pending mode.
    pendingAfterCommandId,
  }
}

/** Chat-safe, compact proof block. The URLs are short authenticated links. */
export function visualProofMarkdown(result: UiActionVisualProofResult): string {
  if (!result.images.length) return ''
  return result.images.map((image) => {
    const phase = image.phase === 'before' ? 'আগে' : 'পরে'
    return `**${phase} — ${image.actionLabel}**\n\n![${phase} — ${image.actionLabel}](${image.imageUrl})`
  }).join('\n\n')
}

/**
 * Result-route reconciler for an AFTER capture that outlived the approval HTTP
 * request. It delivers the marked pair into chat exactly once. The raw command
 * remains the audit source; a storage failure leaves the marker retryable.
 */
export async function deliverDeferredUiAfterProof(input: {
  commandId: string
  rawStdout: string
  params: Record<string, unknown>
}): Promise<boolean> {
  if (input.params.proofPhase !== 'after') return false
  const pendingActionId = String(input.params.proofPendingActionId ?? '').trim()
  const actionLabel = String(input.params.proofActionLabel ?? 'Mac action').trim()
  if (!pendingActionId) return false
  const key = `mac_ui_proof_delivered:${input.commandId}`
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = prisma as any
  const existing = await db.agentKvSetting.findUnique({ where: { key }, select: { value: true } }).catch(() => null)
  if (existing?.value === 'done_resumed') return true
  const action = await db.agentPendingAction.findUnique({
    where: { id: pendingActionId },
    select: { conversationId: true, result: true },
  }).catch(() => null)
  const conversationId = action?.conversationId as string | null
  if (!conversationId) return false
  const sourceActionCommandId = String(input.params.proofForCommandId ?? '').trim()
  const sourceAction = sourceActionCommandId ? await getCommand(sourceActionCommandId) : null
  const actionSucceeded = sourceAction?.status === 'done'
  const resumeWithOutcome = async () => {
    if (actionSucceeded) {
      const { enqueueApprovedActionContinuation } = await import('@/agent/lib/approval-continuation')
      await enqueueApprovedActionContinuation(pendingActionId)
      return
    }
    const { enqueueAgentContinuation } = await import('@/agent/lib/approval-continuation')
    const detail = (sourceAction?.error || sourceAction?.stderr || sourceAction?.status || 'action_result_missing').slice(0, 500)
    await enqueueAgentContinuation({
      conversationId,
      ignoreAwaitingOwner: true,
      message: '[সিস্টেম নোট — approved Mac action ব্যর্থ হয়েছে] AFTER screenshot এসেছে, কিন্তু আসল action সফল হয়নি। ' +
        `Failure: ${detail}। কাজটি complete দাবি কোরো না; Boss-কে ব্যর্থতার কারণ জানিয়ে নিরাপদ পরের পদক্ষেপ নাও।`,
    })
  }
  // `done` was written by the pre-fix implementation after delivering proof
  // but before deferred workflows knew how to resume. Upgrade that durable
  // state exactly once instead of re-posting the screenshot pair.
  if (existing?.value === 'done') {
    await resumeWithOutcome()
    await db.agentKvSetting.upsert({
      where: { key }, create: { key, value: 'done_resumed' }, update: { value: 'done_resumed' },
    })
    return true
  }

  const shared = await shareAnnotatedScreenshot(input.rawStdout, input.commandId, {
    phase: 'after',
    actionLabel,
    detail: 'Action finished — deferred visual proof',
  })
  if (!shared.ok) return false
  const beforeUrl = typeof input.params.proofBeforeImageUrl === 'string'
    ? input.params.proofBeforeImageUrl
    : null
  const pair = [
    beforeUrl ? `**আগে — ${actionLabel}**\n\n![আগে — ${actionLabel}](${beforeUrl})` : '',
    `**পরে — ${actionLabel}**\n\n![পরে — ${actionLabel}](${shared.imageUrl})`,
  ].filter(Boolean).join('\n\n')
  const { appendAssistantNote } = await import('@/agent/lib/conversation-note')
  await appendAssistantNote(
    conversationId,
    actionSucceeded
      ? `✅ Mac action-এর deferred AFTER proof এসে গেছে — marked pair এখন complete।\n\n${pair}`
      : `⚠️ Mac action-এর deferred AFTER proof এসেছে, কিন্তু আসল action সফল হয়নি (${sourceAction?.error ?? sourceAction?.status ?? 'unknown'})। কাজটি complete নয়।\n\n${pair}`,
  )
  await db.agentPendingAction.update({
    where: { id: pendingActionId },
    data: {
      result: {
        ...((action.result && typeof action.result === 'object') ? action.result : {}),
        visualProofComplete: true,
        beforeImageUrl: beforeUrl,
        afterImageUrl: shared.imageUrl,
        afterCommandId: input.commandId,
        sourceActionCommandId: sourceActionCommandId || null,
        sourceActionStatus: sourceAction?.status ?? 'missing',
        sourceActionSucceeded: actionSucceeded,
      },
    },
  }).catch(() => {})
  // The approval route deliberately did not resume while AFTER proof was still
  // queued. Now that the marked pair is durable, continue the same workflow.
  // This call is before the idempotency marker so a transient enqueue failure
  // makes the daemon retry instead of silently stopping the agent.
  await resumeWithOutcome()
  await db.agentKvSetting.upsert({
    where: { key }, create: { key, value: 'done_resumed' }, update: { value: 'done_resumed' },
  })
  return true
}
