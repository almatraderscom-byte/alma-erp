/**
 * POST /api/assistant/office/chat/agent  → owner-only agent-reply controls.
 *
 * The office group agent reply is a one-shot, owner-approved flow:
 *   { action: 'draft',   replyToId }      → draft ONE reply (DeepSeek) for a staff message
 *   { action: 'approve', id, body? }      → post the pending draft to everyone (optional edit)
 *   { action: 'dismiss', id }             → discard the pending draft
 *
 * Only the system owner may call this — staff can neither draft nor approve.
 */
import { type NextRequest } from 'next/server'
import { getToken } from 'next-auth/jwt'
import { requireAgentEnabled } from '@/agent/lib/guards'
import { isSystemOwner } from '@/lib/roles'
import { resolveAgentDraft } from '@/agent/lib/office-chat'
import { generateAgentReplyDraft } from '@/agent/lib/office-chat-agent'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const DEFAULT_BUSINESS = 'ALMA_LIFESTYLE'
const MAX_LEN = 2000

export async function POST(req: NextRequest) {
  const disabled = requireAgentEnabled()
  if (disabled) return disabled

  const token = await getToken({ req, secret: process.env.NEXTAUTH_SECRET })
  if (!token?.sub) return Response.json({ error: 'unauthorized' }, { status: 401 })
  if (!isSystemOwner(token)) return Response.json({ error: 'forbidden' }, { status: 403 })

  const businessId = req.nextUrl.searchParams.get('businessId')?.trim() || DEFAULT_BUSINESS

  let body: { action?: string; replyToId?: string; id?: string; body?: string }
  try {
    body = await req.json()
  } catch {
    return Response.json({ error: 'invalid_json' }, { status: 400 })
  }

  if (body.action === 'draft') {
    const replyToId = body.replyToId?.trim()
    if (!replyToId) return Response.json({ error: 'missing_replyToId' }, { status: 400 })
    const draft = await generateAgentReplyDraft({ businessId, replyToId })
    // null = nothing to draft / already replied / model unavailable — not an error.
    return Response.json({ ok: true, draft })
  }

  if (body.action === 'approve' || body.action === 'dismiss') {
    const id = body.id?.trim()
    if (!id) return Response.json({ error: 'missing_id' }, { status: 400 })
    const edited = body.body?.trim()
    if (edited && edited.length > MAX_LEN) return Response.json({ error: 'too_long' }, { status: 413 })
    const message = await resolveAgentDraft({
      id,
      businessId,
      action: body.action,
      editedBody: edited ?? null,
    })
    if (!message) return Response.json({ error: 'draft_not_found' }, { status: 404 })
    return Response.json({ ok: true, message })
  }

  return Response.json({ error: 'unknown_action' }, { status: 400 })
}
