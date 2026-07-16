/**
 * Phase 46 — the social publish lifecycle with delivery truth + recovery.
 *
 * Rules encoded here:
 * - One approval = one IMMUTABLE content+asset+destination payload: the
 *   payload hash frozen at approval must match at publish time — any drift
 *   aborts the publish (tamper/staleness protection).
 * - No post is claimed delivered until it is fetched back from the API
 *   (verify step) — publish-call success alone is not delivery.
 * - Failures are classified into recovery playbooks (expired token,
 *   permission loss, rate limit, media processing, rejection) with an
 *   explicit owner-vs-retry split.
 * - Durable `social:<calendarId>` thread mirrors each lifecycle event
 *   (fail-open, same discipline as the other graphs).
 */
import { createHash } from 'crypto'
import { StateGraph, Annotation, START, END } from '@langchain/langgraph'
import { getGraphCheckpointer, checkpointConfigFor } from '@/agent/lib/graph/graph-checkpointer'
import { isWorkflowGraphEnabled } from '@/agent/lib/graph/seo-batch-graph'

export const SOCIAL_OPS_NS = 'social_ops'

export interface SocialPayload {
  platform: string
  pageRef: string
  caption: string
  imageRef: string | null
  format?: string
}

/**
 * The immutable identity of an approved post. Approval stores this hash;
 * publish recomputes and compares — one approval maps to exactly this
 * content+asset+destination, nothing else.
 */
export function socialPayloadHash(p: SocialPayload): string {
  return createHash('sha256')
    .update(JSON.stringify({
      platform: p.platform.toLowerCase(),
      pageRef: p.pageRef,
      caption: p.caption,
      imageRef: p.imageRef ?? null,
      format: p.format ?? 'default',
    }))
    .digest('hex')
    .slice(0, 40)
}

export type PublishFailureKind =
  | 'token_expired'
  | 'permission_lost'
  | 'rate_limit'
  | 'media_processing'
  | 'post_rejected'
  | 'payload_drift'
  | 'unsupported_format'
  | 'unknown'

export interface FailurePlaybook {
  kind: PublishFailureKind
  retryable: boolean
  /** What happens next, in plain words. */
  recovery: string
}

/** Map a raw publish error message to its recovery playbook. */
export function classifyPublishFailure(error: string): FailurePlaybook {
  const e = error.toLowerCase()
  if (/session has expired|access token.*(expired|invalid)|error validating access token|code.?:?\s*190/.test(e)) {
    return { kind: 'token_expired', retryable: false, recovery: 'Owner-কে নতুন page token issue করতে হবে — এর আগে এই পেজে কোনো পোস্ট যাবে না।' }
  }
  if (/permission|not authorized|#\s?(10|200|203|294|299)\b/.test(e)) {
    return { kind: 'permission_lost', retryable: false, recovery: 'Business Manager-এ asset permission ফিরিয়ে দিতে হবে (owner) — তারপর reschedule।' }
  }
  if (/rate limit|too many calls|#\s?(4|17|32|613)\b/.test(e)) {
    return { kind: 'rate_limit', retryable: true, recovery: 'কিছুক্ষণ পরে auto-retry — কারো কিছু করার দরকার নেই।' }
  }
  if (/media.*(process|not ready|failed)|container|image.*(fetch|download|invalid)|photo upload/.test(e)) {
    return { kind: 'media_processing', retryable: true, recovery: 'Media re-sign/re-upload করে retry — বারবার fail করলে ছবিটা বদলাতে হবে।' }
  }
  if (/rejected|policy|violat/.test(e)) {
    return { kind: 'post_rejected', retryable: false, recovery: 'Meta পোস্টটা reject করেছে — কনটেন্ট review করে নতুন করে approve লাগবে।' }
  }
  if (/payload (hash|drift)|tamper/.test(e)) {
    return { kind: 'payload_drift', retryable: false, recovery: 'Approve-করা কনটেন্ট আর এখনকার কনটেন্ট মেলে না — নতুন approval ছাড়া পাবলিশ হবে না।' }
  }
  if (/supported না|unsupported|format/.test(e)) {
    return { kind: 'unsupported_format', retryable: false, recovery: 'এই format এখনো API-তে supported না — single_image দিয়ে reschedule করুন।' }
  }
  return { kind: 'unknown', retryable: false, recovery: 'অজানা কারণ — error টা এজেন্টকে দেখতে বলুন, অন্ধ retry হবে না।' }
}

export interface SocialPublishDeps {
  /** The actual publisher (growth/publish.ts). */
  publish: (payload: SocialPayload) => Promise<{ ok: boolean; postId?: string; permalinkUrl?: string; error?: string }>
  /** Fetch-back verifier — delivery truth. */
  verify: (payload: SocialPayload, postId: string) => Promise<{ ok: boolean; permalink?: string; error?: string }>
}

export interface SocialPublishResult {
  status: 'delivered_verified' | 'published_unverified' | 'failed'
  postId?: string
  permalink?: string
  error?: string
  playbook?: FailurePlaybook
}

/**
 * Run one approved calendar entry through the lifecycle:
 * hash check → publish → fetch-back verify. Never claims delivered without
 * the verify step succeeding.
 */
export async function runSocialPublish(
  payload: SocialPayload,
  approvedHash: string,
  deps: SocialPublishDeps,
): Promise<SocialPublishResult> {
  const currentHash = socialPayloadHash(payload)
  if (currentHash !== approvedHash) {
    const error = `payload hash drift: approved=${approvedHash} current=${currentHash}`
    return { status: 'failed', error, playbook: classifyPublishFailure(error) }
  }

  const pub = await deps.publish(payload)
  if (!pub.ok || !pub.postId) {
    const error = pub.error ?? 'publish failed without detail'
    return { status: 'failed', error, playbook: classifyPublishFailure(error) }
  }

  const verified = await deps.verify(payload, pub.postId)
  if (!verified.ok) {
    // Honest state: the publish call succeeded but delivery is NOT proven.
    return {
      status: 'published_unverified',
      postId: pub.postId,
      error: verified.error,
      playbook: classifyPublishFailure(verified.error ?? 'verify failed'),
    }
  }

  return { status: 'delivered_verified', postId: pub.postId, permalink: verified.permalink ?? pub.permalinkUrl }
}

// ---------------------------------------------------------------------------
// Durable thread mirror (fail-open)
// ---------------------------------------------------------------------------

export interface SocialOpsEvent {
  step: 'approved' | 'publish_attempt' | 'delivered_verified' | 'failed'
  payloadHash: string
  detail?: string
  eventNo?: number
}

const SocialOpsState = Annotation.Root({
  event: Annotation<SocialOpsEvent | null>({ reducer: (_a, b) => b, default: () => null }),
  eventCount: Annotation<number>({ reducer: (a, b) => a + b, default: () => 0 }),
})

function buildGraph(checkpointer: NonNullable<ReturnType<typeof getGraphCheckpointer>>) {
  return new StateGraph(SocialOpsState)
    .addNode('apply_event', (s) => ({
      eventCount: 1,
      event: s.event ? { ...s.event, eventNo: s.eventCount + 1 } : null,
    }))
    .addEdge(START, 'apply_event')
    .addEdge('apply_event', END)
    .compile({ checkpointer })
}

/** Mirror one lifecycle event onto social:<calendarId>. Fail-open. */
export async function mirrorSocialOpsEvent(calendarId: string, event: SocialOpsEvent): Promise<void> {
  try {
    if (!isWorkflowGraphEnabled()) return
    const checkpointer = getGraphCheckpointer()
    if (!checkpointer) return
    await buildGraph(checkpointer).invoke(
      { event },
      checkpointConfigFor({ conversationId: `social:${calendarId}`, turnId: null, namespace: SOCIAL_OPS_NS }),
    )
  } catch (err) {
    console.warn('[social-ops-graph] mirror failed open:', err instanceof Error ? err.message : err)
  }
}
