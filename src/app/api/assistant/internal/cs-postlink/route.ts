import { type NextRequest } from 'next/server'
import { timingSafeEqual } from 'crypto'
import { requireAgentEnabled } from '@/agent/lib/guards'
import { linkPostProducts, parseFbPostId } from '@/agent/lib/cs/post-products'
import { CS_PAGES } from '@/agent/lib/cs/meta-messenger'

export const runtime = 'nodejs'

function verifyToken(provided: string): boolean {
  const expected = process.env.AGENT_INTERNAL_TOKEN ?? ''
  if (!expected || !provided) return false
  try {
    const a = Buffer.from(expected, 'utf8')
    const b = Buffer.from(provided, 'utf8')
    if (a.length !== b.length) return false
    return timingSafeEqual(a, b)
  } catch { return false }
}

export async function POST(req: NextRequest) {
  const disabled = requireAgentEnabled()
  if (disabled) return disabled

  const authHeader = req.headers.get('authorization') ?? ''
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : ''
  if (!verifyToken(token)) return Response.json({ error: 'unauthorized' }, { status: 401 })

  const body = await req.json() as {
    postRef?: string
    pageId?: string
    productCodes?: string[]
  }

  const defaultPage = body.pageId ?? Object.keys(CS_PAGES)[0]
  const parsed = parseFbPostId(String(body.postRef ?? ''), defaultPage)
  if (!parsed?.pageId) {
    return Response.json({ error: 'invalid_post_ref' }, { status: 400 })
  }

  const codes = Array.isArray(body.productCodes) ? body.productCodes.map(String) : []
  if (!codes.length) return Response.json({ error: 'productCodes required' }, { status: 400 })

  const result = await linkPostProducts({
    postId: parsed.postId,
    pageId: parsed.pageId || defaultPage,
    productCodes: codes,
  })

  return Response.json({ ok: true, ...result })
}
