/**
 * Guaranteed delivery of a finished background job (owner incident 2026-07-25).
 *
 * A worker job (SEO audit, image, video, workbench, long agent task) finishes on
 * the VPS and calls /api/assistant/internal/job-result. That route marks the
 * action `executed`, suppresses the generic "✅ কাজটি সফল" bubble for job types
 * whose report IS the deliverable, and fires ONE best-effort continuation turn
 * so the head presents the result itself.
 *
 * That was a single unguarded thread. If the continuation no-oped (owner's
 * auto-continue KV off), timed out (90 s inline cap), or the head's final text
 * got replaced by a progress placeholder, the finished work sat in
 * `agentPendingAction.result` forever and the chat showed nothing but "done" —
 * exactly what the owner saw for his deep SEO audit. The old watchdog could not
 * catch it either: it only scans `approved` + unresolved rows, and this row was
 * `executed`.
 *
 * This module closes that hole for EVERY job type:
 *   1. job-result stamps a delivery marker on the result (`markDeliveryPending`);
 *   2. a cron sweep (open-task-nudge, every 10 min) looks for executed jobs whose
 *      conversation never got a substantive assistant message afterwards;
 *   3. it retries the continuation up to MAX_CONTINUATION_RETRIES, then posts a
 *      server-built Bangla delivery message itself and pings Telegram.
 *
 * Silence is no longer a possible outcome.
 */
import { prisma } from '@/lib/prisma'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = prisma as any

/** Job types whose completion MUST reach the owner in the conversation. */
export const DELIVERABLE_JOB_TYPES = [
  'seo_audit',
  'long_agent_task',
  'workbench_run',
  'browser_action',
] as const

/** How long the head gets to present the result before the sweep steps in. */
const DELIVERY_GRACE_MIN = 4
/** How many continuation retries before the server writes the message itself. */
const MAX_CONTINUATION_RETRIES = 2
/** Give up entirely on rows older than this (avoid resurrecting ancient jobs). */
const DELIVERY_MAX_AGE_HOURS = 24
/** A shorter assistant message than this is an acknowledgement, not a delivery. */
const SUBSTANTIVE_MESSAGE_CHARS = 60

export interface JobDeliveryState {
  state: 'pending' | 'delivered'
  attempts: number
  since: string
  deliveredAt?: string
  via?: 'head' | 'server_fallback'
}

export function readDeliveryState(result: unknown): JobDeliveryState | null {
  const marker = (result as Record<string, unknown> | null)?.__delivery
  if (!marker || typeof marker !== 'object') return null
  const m = marker as Record<string, unknown>
  if (m.state !== 'pending' && m.state !== 'delivered') return null
  return {
    state: m.state,
    attempts: Number(m.attempts) || 0,
    since: typeof m.since === 'string' ? m.since : new Date().toISOString(),
    deliveredAt: typeof m.deliveredAt === 'string' ? m.deliveredAt : undefined,
    via: m.via === 'head' || m.via === 'server_fallback' ? m.via : undefined,
  }
}

async function writeDeliveryState(actionId: string, next: JobDeliveryState): Promise<void> {
  const row = await db.agentPendingAction.findUnique({ where: { id: actionId }, select: { result: true } })
  const result = (row?.result ?? {}) as Record<string, unknown>
  await db.agentPendingAction.update({
    where: { id: actionId },
    data: { result: { ...result, __delivery: next } },
  })
}

/**
 * Called by job-result the moment a deliverable job succeeds: the clock for
 * "the owner has not been told yet" starts here.
 */
export async function markDeliveryPending(actionId: string, jobType: string): Promise<void> {
  if (!isDeliverableJobType(jobType)) return
  try {
    await writeDeliveryState(actionId, { state: 'pending', attempts: 0, since: new Date().toISOString() })
  } catch (err) {
    console.warn('[job-delivery] could not mark pending:', err instanceof Error ? err.message : err)
  }
}

export async function markDelivered(actionId: string, via: JobDeliveryState['via']): Promise<void> {
  try {
    const row = await db.agentPendingAction.findUnique({ where: { id: actionId }, select: { result: true } })
    const prev = readDeliveryState(row?.result)
    await writeDeliveryState(actionId, {
      state: 'delivered',
      attempts: prev?.attempts ?? 0,
      since: prev?.since ?? new Date().toISOString(),
      deliveredAt: new Date().toISOString(),
      via,
    })
  } catch (err) {
    console.warn('[job-delivery] could not mark delivered:', err instanceof Error ? err.message : err)
  }
}

export function isDeliverableJobType(type: string): boolean {
  return (DELIVERABLE_JOB_TYPES as readonly string[]).includes(type)
}

/**
 * True when this turn was started by the server to PRESENT a finished job.
 * Such a turn must answer at full length — see interaction-policy's
 * delivery override.
 */
export function isJobDeliveryDirective(instructions: string | null | undefined): boolean {
  if (!instructions) return false
  return /\[INTERNAL (?:SEO JOB RESULT|JOB DELIVERY RETRY)\]/i.test(instructions)
}

/** Plain text of an agentMessage content payload (blocks or legacy string). */
export function messageContentText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((block) => {
      const b = block as Record<string, unknown> | null
      return b && b.type === 'text' && typeof b.text === 'string' ? b.text : ''
    })
    .join('\n')
    .trim()
}

/**
 * A progress placeholder is NOT a delivery. The client-SEO contract deliberately
 * replaces the head's draft with "🔄 … worker-এ চলছে" / "⏳ Ordered SEO কাজ চলমান"
 * while a crawl runs; counting those as the report would re-create the exact
 * silence this module exists to prevent.
 */
export function isProgressPlaceholder(text: string): boolean {
  const t = text.trim()
  if (!t) return true
  return /^[⏳🔄]/u.test(t) || /কাজ\s*চলমান|worker-?এ\s*চলছে|crawl\s*চলছে/i.test(t)
}

/** Did the conversation actually receive the result after the job resolved? */
export async function conversationSawDelivery(conversationId: string, after: Date): Promise<boolean> {
  const rows = await db.agentMessage.findMany({
    where: { conversationId, role: 'assistant', createdAt: { gt: after } },
    orderBy: { createdAt: 'asc' },
    take: 20,
    select: { content: true },
  })
  return (rows as Array<{ content: unknown }>).some((r) => {
    const text = messageContentText(r.content)
    return text.length >= SUBSTANTIVE_MESSAGE_CHARS && !isProgressPlaceholder(text)
  })
}

const APP_BASE = () =>
  (process.env.APP_URL || process.env.NEXTAUTH_URL || process.env.NEXT_PUBLIC_APP_URL || 'https://alma-erp-six.vercel.app')
    .replace(/\/$/, '')

export const ownerFileLink = (path: string) =>
  `${APP_BASE()}/api/assistant/files?path=${encodeURIComponent(path)}&redirect=1`

const FILE_LABELS: Array<{ match: RegExp; label: string }> = [
  { match: /report\.html$/, label: 'লাইভ ড্যাশবোর্ড (HTML)' },
  { match: /report\.md$/, label: 'পুরো রিপোর্ট (md)' },
  { match: /issues\.csv$/, label: 'সব issue (Excel/CSV)' },
  { match: /audit\.json$/, label: 'raw findings (json)' },
]

/**
 * The server's own delivery message — used only when the head failed to present
 * the result. Deliberately plain and factual: real numbers from the stored
 * result, every artifact as a clickable link, no claim the agent cannot back.
 */
export function buildFallbackDeliveryMessage(action: {
  type: string
  summary: string | null
  result: unknown
}): string {
  const result = (action.result ?? {}) as Record<string, unknown>
  // Phase 5 stores a ready Bangla summary at delivery-build time; prefer it.
  const prepared = typeof result.deliverySummaryBn === 'string' ? result.deliverySummaryBn.trim() : ''
  const artifacts = Array.isArray(result.artifacts) ? (result.artifacts as string[]) : []
  const links = artifacts
    .map((path) => {
      const label = FILE_LABELS.find((f) => f.match.test(path))?.label ?? path.split('/').pop() ?? 'ফাইল'
      return `- [${label}](${ownerFileLink(path)})`
    })
    .join('\n')

  if (prepared) {
    return links ? `${prepared}\n\n**ফাইল:**\n${links}` : prepared
  }

  const head = `✅ Boss, "${(action.summary ?? action.type).replace(/\n[\s\S]*$/, '')}" কাজটা শেষ হয়েছে।`
  const facts: string[] = []
  if (typeof result.score === 'number') facts.push(`স্কোর: **${result.score}/100**`)
  if (typeof result.pagesCrawled === 'number') facts.push(`ক্রল হয়েছে: ${result.pagesCrawled} পেজ`)
  const counts = result.counts as Record<string, unknown> | undefined
  if (counts && typeof counts === 'object') {
    const sev = ['critical', 'high', 'medium', 'low']
      .map((k) => (typeof counts[k] === 'number' ? `${k} ${counts[k]}` : ''))
      .filter(Boolean)
      .join(', ')
    if (sev) facts.push(`সমস্যা: ${sev}`)
  }
  const body = facts.length ? `\n\n${facts.map((f) => `- ${f}`).join('\n')}` : ''
  const tail = links ? `\n\n**ফাইল:**\n${links}` : ''
  return `${head}${body}${tail}\n\n_(রিপোর্টটা আমি নিজে সময়মতো তুলে ধরতে পারিনি — তাই সিস্টেম থেকেই পাঠালাম।)_`
}

async function postFallbackMessage(conversationId: string, text: string): Promise<void> {
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
  await db.agentConversation.update({ where: { id: conversationId }, data: { updatedAt: new Date() } })
}

function conversationIdOf(action: { conversationId: string | null; payload: unknown }): string | null {
  if (action.conversationId) return action.conversationId
  const p = (action.payload ?? {}) as Record<string, unknown>
  return typeof p.conversationId === 'string' && p.conversationId.trim() ? p.conversationId.trim() : null
}

export interface JobDeliverySweepResult {
  scanned: number
  alreadyDelivered: number
  retried: number
  forced: number
}

/**
 * Cron tick: no finished job may stay unpresented. Rides the same 10-minute cron
 * as the open-task nudge and the stuck-job watchdog.
 */
export async function runJobDeliverySweep(): Promise<JobDeliverySweepResult> {
  const graceCutoff = new Date(Date.now() - DELIVERY_GRACE_MIN * 60 * 1000)
  const ageFloor = new Date(Date.now() - DELIVERY_MAX_AGE_HOURS * 3600 * 1000)
  const rows = await db.agentPendingAction.findMany({
    where: {
      status: 'executed',
      type: { in: [...DELIVERABLE_JOB_TYPES] },
      resolvedAt: { lt: graceCutoff, gt: ageFloor },
    },
    orderBy: { resolvedAt: 'asc' },
    take: 20,
    select: { id: true, type: true, summary: true, result: true, payload: true, conversationId: true, resolvedAt: true },
  })

  const out: JobDeliverySweepResult = { scanned: 0, alreadyDelivered: 0, retried: 0, forced: 0 }
  type Row = {
    id: string
    type: string
    summary: string | null
    result: unknown
    payload: unknown
    conversationId: string | null
    resolvedAt: Date | null
  }

  for (const row of rows as Row[]) {
    const state = readDeliveryState(row.result)
    if (state?.state === 'delivered') continue
    out.scanned++
    const conversationId = conversationIdOf(row)
    const resolvedAt = row.resolvedAt ?? new Date()
    if (!conversationId) {
      await markDelivered(row.id, 'server_fallback') // nowhere to deliver; stop scanning it
      continue
    }

    if (await conversationSawDelivery(conversationId, resolvedAt)) {
      out.alreadyDelivered++
      await markDelivered(row.id, 'head')
      continue
    }

    const attempts = state?.attempts ?? 0
    if (attempts < MAX_CONTINUATION_RETRIES) {
      await writeDeliveryState(row.id, {
        state: 'pending',
        attempts: attempts + 1,
        since: state?.since ?? resolvedAt.toISOString(),
      })
      out.retried++
      try {
        const { enqueueAgentContinuation } = await import('@/agent/lib/approval-continuation')
        await enqueueAgentContinuation({
          conversationId,
          force: true,
          message:
            `[INTERNAL JOB DELIVERY RETRY] The ${row.type} job ${row.id} finished but Boss was never shown the result. ` +
            'Read the stored result NOW (for an SEO audit: check_website_seo_audit with read:"report" then read:"links") ' +
            'and present it IN THIS REPLY — score/outcome, the concrete findings, what to do next, and the download links. ' +
            'Do not re-run the job, do not ask Boss whether he wants the report, and do not reply with a progress line.',
        })
      } catch (err) {
        console.warn('[job-delivery] retry enqueue failed:', err instanceof Error ? err.message : err)
      }
      continue
    }

    // The head had its chances — the server delivers.
    try {
      await postFallbackMessage(conversationId, buildFallbackDeliveryMessage(row))
      out.forced++
      await markDelivered(row.id, 'server_fallback')
      const { sendOwnerText } = await import('@/agent/lib/telegram-owner-notify')
      await sendOwnerText(
        `📄 Boss, "${(row.summary ?? row.type).split('\n')[0]}" কাজের রিপোর্ট চ্যাটে দিয়ে দিলাম (এজেন্ট নিজে দিতে পারেনি)।`,
      ).catch(() => {})
    } catch (err) {
      console.error('[job-delivery] fallback delivery failed:', err instanceof Error ? err.message : err)
    }
  }

  return out
}

/** Exported for tests/diagnostics. */
export const __deliveryTuning = {
  DELIVERY_GRACE_MIN,
  MAX_CONTINUATION_RETRIES,
  SUBSTANTIVE_MESSAGE_CHARS,
}
