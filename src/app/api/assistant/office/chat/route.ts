/**
 * GET  /api/assistant/office/chat  → recent group-chat messages
 * POST /api/assistant/office/chat  → post a message ({ body, taskRef? })
 *
 * Shared room for owner + all staff of a business. The agent posts via its own
 * server path (isAgentReply); this route only handles owner/staff posts.
 */
import { type NextRequest } from 'next/server'
import { getToken } from 'next-auth/jwt'
import { requireAgentEnabled } from '@/agent/lib/guards'
import { isSystemOwner } from '@/lib/roles'
import { resolveSessionStaff } from '@/agent/lib/office-staff'
import { getGroupMessages, postGroupMessage, type ChatAttachment, type ChatAuthor } from '@/agent/lib/office-chat'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const DEFAULT_BUSINESS = 'ALMA_LIFESTYLE'
const MAX_LEN = 2000
const MAX_ATTACHMENTS = 6

/** Accept only image attachments with a usable URL, capped to MAX_ATTACHMENTS. */
function sanitizeAttachments(raw: unknown): ChatAttachment[] {
  if (!Array.isArray(raw)) return []
  const out: ChatAttachment[] = []
  for (const a of raw) {
    const url = a && typeof a === 'object' ? (a as { url?: unknown }).url : undefined
    if (typeof url === 'string' && /^https?:\/\//.test(url)) out.push({ type: 'image', url })
    if (out.length >= MAX_ATTACHMENTS) break
  }
  return out
}

type Identity =
  | { ok: true; authorType: ChatAuthor; authorStaffId: string | null; authorUserId: string | null; businessId: string }
  | { ok: false; error: string; code: number }

async function identify(req: NextRequest): Promise<Identity> {
  const token = await getToken({ req, secret: process.env.NEXTAUTH_SECRET })
  if (!token?.sub) return { ok: false, error: 'unauthorized', code: 401 }

  if (isSystemOwner(token)) {
    const businessId = req.nextUrl.searchParams.get('businessId')?.trim() || DEFAULT_BUSINESS
    return { ok: true, authorType: 'owner', authorStaffId: null, authorUserId: token.sub, businessId }
  }

  const staff = await resolveSessionStaff(token.sub)
  if (!staff) return { ok: false, error: 'forbidden', code: 403 }
  return { ok: true, authorType: 'staff', authorStaffId: staff.id, authorUserId: null, businessId: staff.businessId }
}

export async function GET(req: NextRequest) {
  const disabled = requireAgentEnabled()
  if (disabled) return disabled

  const id = await identify(req)
  if (!id.ok) return Response.json({ error: id.error }, { status: id.code })

  // The owner additionally sees pending agent drafts (to approve/dismiss).
  const feed = await getGroupMessages(id.businessId, { includePending: id.authorType === 'owner' })
  return Response.json(feed)
}

export async function POST(req: NextRequest) {
  const disabled = requireAgentEnabled()
  if (disabled) return disabled

  const id = await identify(req)
  if (!id.ok) return Response.json({ error: id.error }, { status: id.code })

  let body: { body?: string; taskRef?: string; attachments?: unknown }
  try {
    body = await req.json()
  } catch {
    return Response.json({ error: 'invalid_json' }, { status: 400 })
  }

  const text = body.body?.trim() ?? ''
  const attachments = sanitizeAttachments(body.attachments)
  // A message must carry text or at least one image.
  if (!text && attachments.length === 0) return Response.json({ error: 'empty_body' }, { status: 400 })
  if (text.length > MAX_LEN) return Response.json({ error: 'too_long' }, { status: 413 })

  const msg = await postGroupMessage({
    authorType: id.authorType,
    authorStaffId: id.authorStaffId,
    authorUserId: id.authorUserId,
    body: text,
    attachments,
    taskRef: body.taskRef?.trim() || null,
    businessId: id.businessId,
  })
  return Response.json({ ok: true, message: msg }, { status: 201 })
}
