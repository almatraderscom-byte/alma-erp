/**
 * GET /api/assistant/actions — list the owner's pending agent actions.
 *
 * Powers the "Agent" tab in the ERP Approval Center: one place where every
 * agent-proposed action (voice calls, dispatch, finance confirms, …) waits for
 * the owner's Approve / Reject instead of being buried in chat or Telegram.
 *
 * Owner-only (NextAuth session) OR the internal bearer token. Read-only; the
 * actual approve/reject happen on /actions/[id]/approve and /actions/[id]/reject.
 */
import { type NextRequest } from 'next/server'
import { getToken } from 'next-auth/jwt'
import { timingSafeEqual } from 'crypto'
import { requireAgentEnabled } from '@/agent/lib/guards'
import { isSystemOwner } from '@/lib/roles'
import { prisma } from '@/lib/prisma'
import { isPendingActionExpired } from '@/agent/lib/pending-action'
import {
  IMAGE_WORKER_CAPABILITY_KV_KEY,
  imageModelAvailability,
  selectionForImageAction,
} from '@/agent/lib/image-action-contract'
import {
  IMAGE_WORKER_CAPABILITY_V2_KV_KEY,
  readImageWorkerCapabilityV2,
  renderSelectionForAction,
} from '@/agent/lib/image-config-contract'
import { readKv } from '@/lib/creative-studio/taste'

export const runtime = 'nodejs'

const readImageKv = (key: string) => readKv(key).catch(() => null)

function isMissingImageProjectionColumn(error: unknown): boolean {
  const code = (error as { code?: unknown })?.code
  if (code !== 'P2022') return false
  const detail = (() => {
    try { return JSON.stringify(error) } catch { return String(error) }
  })()
  return /image_model|image_quote|imageModel|imageQuote/i.test(detail)
}

function verifyInternalToken(provided: string): boolean {
  const expected = process.env.AGENT_INTERNAL_TOKEN ?? ''
  if (!expected || !provided) return false
  try {
    const a = Buffer.from(expected, 'utf8')
    const b = Buffer.from(provided, 'utf8')
    if (a.length !== b.length) return false
    return timingSafeEqual(a, b)
  } catch {
    return false
  }
}

export async function GET(req: NextRequest) {
  const disabled = requireAgentEnabled()
  if (disabled) return disabled

  const authHeader = req.headers.get('authorization') ?? ''
  const bearerToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : ''
  if (!verifyInternalToken(bearerToken)) {
    const token = await getToken({ req, secret: process.env.NEXTAUTH_SECRET })
    if (!token?.sub) return Response.json({ error: 'unauthorized' }, { status: 401 })
    // Native Robot polls this owner-only queue app-wide. Authenticated staff
    // must see an empty queue, not a 403 that the native session layer
    // interprets as an expired login.
    if (!isSystemOwner(token)) {
      return Response.json({ count: 0, actions: [], nextCursor: null })
    }
  }

  const { searchParams } = new URL(req.url)
  const status = (searchParams.get('status') ?? 'pending').toLowerCase()
  const limit = Math.min(Math.max(Number(searchParams.get('limit')) || 50, 1), 100)
  const cursor = searchParams.get('cursor')?.trim() || undefined

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = prisma as any
  const where = status === 'all' ? {} : { status }
  const baseQuery = {
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      // Fetch one extra row so the native clients can follow a truthful cursor
      // instead of silently dropping approval #101 and onward.
      take: limit + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
  }
  type ActionListRow = Record<string, unknown> & {
    id: string
    status: string
    type: string
    createdAt: Date | string
  }
  let rows: ActionListRow[]
  let imageProjectionAvailable = true
  try {
    rows = await db.agentPendingAction.findMany({
      ...baseQuery,
      select: {
        id: true,
        type: true,
        status: true,
        summary: true,
        costEstimate: true,
        conversationId: true,
        result: true,
        payload: true,
        imageModel: true,
        imageQuote: true,
        imageConfig: true,
        imageConfigRevision: true,
        createdAt: true,
      },
    })
  } catch (error) {
    if (!isMissingImageProjectionColumn(error)) throw error
    imageProjectionAvailable = false
    // Rolling deploy safety: old clients must not see an empty approval queue
    // merely because code reached an instance before the additive migration.
    // The model picker is omitted on that one legacy read; all cards remain.
    console.error('[assistant/actions] image contract projection unavailable; using legacy select (deploy migration first):', error)
    rows = await db.agentPendingAction.findMany({
      ...baseQuery,
      select: {
        id: true,
        type: true,
        status: true,
        summary: true,
        costEstimate: true,
        conversationId: true,
        result: true,
        payload: true,
        createdAt: true,
      },
    })
  }

  // Flag transient cards that have aged past their TTL. Lifecycle-bound cards
  // like dispatch never expire — isPendingActionExpired handles that.
  const pageRows = rows.slice(0, limit)
  const [workerCapabilities, genericLaneKill, xaiEnabled] = await Promise.all([
    readImageKv(IMAGE_WORKER_CAPABILITY_KV_KEY),
    readImageKv('cs_engine_kill:gemini'),
    readImageKv('cs_xai_enabled'),
  ])
  const availability = imageModelAvailability({
    workerCapabilities,
    genericLaneKilled: genericLaneKill === '1',
    xaiConfigured: xaiEnabled === '1',
  })
  const { receipt: actionsReceiptV2, reason: actionsReceiptV2Reason } = readImageWorkerCapabilityV2(
    await readKv(IMAGE_WORKER_CAPABILITY_V2_KV_KEY), Date.now())
  const actions = pageRows.map((row: {
    id: string
    status: string
    type: string
    createdAt: Date | string
    payload?: unknown
    imageModel?: string | null
    imageQuote?: unknown
    imageConfig?: unknown
    imageConfigRevision?: number | null
  } & Record<string, unknown>) => {
    const { payload, imageModel, imageQuote, imageConfig, imageConfigRevision, ...r } = row
    const renderSelection = r.type === 'image_gen' && imageProjectionAvailable
      ? renderSelectionForAction({
          type: r.type,
          imageModel,
          imageConfig,
          imageConfigRevision,
          availability,
          receipt: actionsReceiptV2,
          receiptUnavailableReason: actionsReceiptV2Reason || undefined,
        })
      : null
    return {
      ...r,
      expired: r.status === 'pending' && isPendingActionExpired(r.createdAt, r.type),
      ...(r.type === 'image_gen' && imageProjectionAvailable
        ? { imageModelSelection: selectionForImageAction({
            type: r.type,
            payload,
            imageModel,
            imageQuote,
            availability,
          }) }
        : {}),
      ...(renderSelection ? { imageRenderSelection: renderSelection } : {}),
    }
  })

  // Proactively retire expired-but-still-pending cards. Without this they sit in
  // the queue forever as status='pending' — and the UI greys out both buttons on
  // an expired card, so the owner had no way to clear them ("remove hoy na").
  // Transition them to the terminal 'expired' status (same as the approve/reject
  // routes do on a 410) and drop them from the pending view so they disappear.
  const expiredIds = actions.filter((a: { expired: boolean }) => a.expired).map((a: { id: string }) => a.id)
  if (expiredIds.length) {
    await db.agentPendingAction
      .updateMany({
        where: { id: { in: expiredIds }, status: 'pending' },
        data: { status: 'expired', resolvedAt: new Date() },
      })
      .catch((err: unknown) => {
        console.warn('[assistant/actions] expired sweep failed:', err instanceof Error ? err.message : err)
      })
  }

  const visible = status === 'pending' ? actions.filter((a: { expired: boolean }) => !a.expired) : actions
  return Response.json({
    count: visible.length,
    actions: visible,
    nextCursor: rows.length > limit ? pageRows.at(-1)?.id ?? null : null,
  })
}
