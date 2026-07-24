// CS14 — Model Avatar management: store up to 10 angle photos per saved model
// and queue the worker build (free identity sheet + optional paid Grok
// canonical portrait). Generation-time use is automatic via resolvePersonRef.
import { type NextRequest } from 'next/server'
import { getToken } from 'next-auth/jwt'
import { requireAgentEnabled } from '@/agent/lib/guards'
import { isSystemOwner } from '@/lib/roles'
import { agentStorageSignedUrls } from '@/agent/lib/storage'
import { prisma } from '@/lib/prisma'
import { resolveModel } from '@/lib/tryon/model-library'
import {
  MAX_AVATAR_IMAGES,
  clearAvatar,
  readAvatar,
  sanitizeAvatarImagePaths,
  writeAvatar,
} from '@/lib/tryon/model-avatar'
import { CS_XAI_ENABLED_KEY } from '@/lib/creative-studio/provider-registry'
import { readKv } from '@/lib/creative-studio/taste'

export const runtime = 'nodejs'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = prisma as any

async function requireOwner(req: NextRequest) {
  const disabled = requireAgentEnabled()
  if (disabled) return disabled
  const token = await getToken({ req, secret: process.env.NEXTAUTH_SECRET })
  if (!token?.sub) return Response.json({ error: 'unauthorized' }, { status: 401 })
  if (!isSystemOwner(token)) return Response.json({ error: 'forbidden' }, { status: 403 })
  return null
}

export async function GET(req: NextRequest) {
  const denied = await requireOwner(req)
  if (denied) return denied
  const id = String(req.nextUrl.searchParams.get('id') ?? '').trim().toLowerCase()
  if (!id) return Response.json({ error: 'id_required' }, { status: 400 })
  const avatar = await readAvatar(id)
  if (!avatar) return Response.json({ avatar: null })
  let signed: Record<string, string> = {}
  try {
    signed = await agentStorageSignedUrls(
      [...avatar.imagePaths, avatar.sheetPath, avatar.canonicalPath].filter(Boolean) as string[],
      3600,
    )
  } catch { /* thumbs optional */ }
  return Response.json({
    avatar: {
      ...avatar,
      imageUrls: avatar.imagePaths.map((p) => signed[p] ?? null),
      sheetUrl: avatar.sheetPath ? signed[avatar.sheetPath] ?? null : null,
      canonicalUrl: avatar.canonicalPath ? signed[avatar.canonicalPath] ?? null : null,
    },
  })
}

export async function POST(req: NextRequest) {
  const denied = await requireOwner(req)
  if (denied) return denied

  let body: { action?: string; id?: string; imagePaths?: unknown; canonical?: boolean }
  try {
    body = await req.json()
  } catch {
    return Response.json({ error: 'invalid_json' }, { status: 400 })
  }
  const action = String(body.action ?? '')
  const id = String(body.id ?? '').trim().toLowerCase()
  if (!id) return Response.json({ error: 'id_required' }, { status: 400 })
  const model = await resolveModel(id)
  if (!model) return Response.json({ error: 'model_not_found' }, { status: 404 })

  if (action === 'set_images') {
    const imagePaths = sanitizeAvatarImagePaths(body.imagePaths)
    if (imagePaths.length === 0) return Response.json({ error: 'images_required' }, { status: 400 })
    const prev = await readAvatar(id)
    // New angle set invalidates a previously built sheet/canonical — the owner
    // rebuilds explicitly (the old artifacts stay until then, truthfully stale).
    await writeAvatar(id, { ...(prev ?? {}), imagePaths, building: prev?.building })
    return Response.json({ ok: true, count: imagePaths.length, max: MAX_AVATAR_IMAGES })
  }

  if (action === 'clear') {
    await clearAvatar(id)
    return Response.json({ ok: true })
  }

  if (action === 'build') {
    const avatar = await readAvatar(id)
    if (!avatar || avatar.imagePaths.length === 0) {
      return Response.json({ error: 'no_avatar_images', message: 'আগে অ্যাভাটারের জন্য ছবি যোগ করুন।' }, { status: 422 })
    }
    const wantCanonical = body.canonical !== false
    if (wantCanonical) {
      if (!process.env.XAI_API_KEY?.trim()) return Response.json({ error: 'xai_not_configured' }, { status: 422 })
      if ((await readKv(CS_XAI_ENABLED_KEY)) !== '1') return Response.json({ error: 'xai_engine_disabled' }, { status: 422 })
    }
    const row = await db.agentPendingAction.create({
      data: {
        conversationId: null,
        type: 'image_gen',
        payload: {
          provider: 'avatar_build',
          modelId: id,
          modelName: model.name,
          imagePaths: avatar.imagePaths,
          canonical: wantCanonical,
          creativeStudio: true,
          skipTelegramCard: true,
        },
        summary: `🧬 Avatar build — ${model.name}`,
        costEstimate: wantCanonical ? 0.07 : 0,
        status: 'approved',
      },
    })
    await writeAvatar(id, { ...avatar, building: true })
    return Response.json({ ok: true, pendingActionId: row.id })
  }

  return Response.json({ error: 'invalid_action' }, { status: 400 })
}
