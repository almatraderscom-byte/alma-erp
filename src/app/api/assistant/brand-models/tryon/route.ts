import { type NextRequest } from 'next/server'
import { getToken } from 'next-auth/jwt'
import { requireAgentEnabled } from '@/agent/lib/guards'
import { isSystemOwner } from '@/lib/roles'
import { CHAT_TRYON_VARIANTS, queueTryOnBatch, type ChatTryOnVariant } from '@/lib/tryon/tryon-batch'
import type { TryOnPose, TryOnStyle } from '@/lib/tryon/model-library'

export const runtime = 'nodejs'
export const maxDuration = 60

export async function POST(req: NextRequest) {
  const disabled = requireAgentEnabled()
  if (disabled) return disabled

  const token = await getToken({ req, secret: process.env.NEXTAUTH_SECRET })
  if (!token?.sub) return Response.json({ error: 'unauthorized' }, { status: 401 })
  if (!isSystemOwner(token)) return Response.json({ error: 'forbidden' }, { status: 403 })

  let body: {
    productImagePath?: string
    modelId?: string
    variants?: string[]
    style?: TryOnStyle
    pose?: TryOnPose
    extra?: string
    conversationId?: string
  }
  try {
    body = await req.json()
  } catch {
    return Response.json({ error: 'invalid_json' }, { status: 400 })
  }

  const productImagePath = String(body.productImagePath ?? '').trim()
  if (!productImagePath) {
    return Response.json({ error: 'productImagePath_required' }, { status: 400 })
  }

  const variants = (body.variants?.length ? body.variants : ['single']).filter((v): v is ChatTryOnVariant =>
    CHAT_TRYON_VARIANTS.includes(v as ChatTryOnVariant),
  )
  if (!variants.length) {
    return Response.json({ error: 'invalid_variants' }, { status: 400 })
  }

  try {
    const result = await queueTryOnBatch({
      productImagePath,
      modelId: body.modelId,
      variants,
      style: body.style,
      pose: body.pose,
      extra: body.extra,
      conversationId: body.conversationId ?? null,
    })
    return Response.json({
      model: { id: result.model.id, name: result.model.name, role: result.model.role },
      items: result.items,
      message: `${result.items.length}টি try-on approval card তৈরি — Telegram/chat-এ approve করুন।`,
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (msg.startsWith('no_model')) {
      return Response.json(
        { error: 'no_model', message: 'আগে Model Library-তে মডেল ছবি save করুন (role সহ)।' },
        { status: 422 },
      )
    }
    return Response.json({ error: 'tryon_failed', message: msg }, { status: 500 })
  }
}
