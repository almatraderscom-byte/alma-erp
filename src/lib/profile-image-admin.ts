import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { getJwt, requireRoles } from '@/lib/api-guards'
import { userAvatarUrl } from '@/lib/user-display'
import {
  deleteProfileImages,
  processProfileImageUpload,
  uploadProfileImages,
} from '@/lib/profile-image'
import { storageReadiness } from '@/lib/supabase-storage'

function parseDataUrl(dataUrl: string) {
  const match = /^data:([^;]+);base64,(.+)$/i.exec(dataUrl.trim())
  if (!match) return null
  return { contentType: match[1].toLowerCase(), buffer: Buffer.from(match[2], 'base64') }
}

export async function handleProfileImageUpload(req: NextRequest, targetUserId: string, allowSelf = true) {
  const token = await getJwt(req)
  if (!token?.sub) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const isSelf = token.sub === targetUserId
  if (!isSelf) {
    const denied = await requireRoles(req, ['SUPER_ADMIN', 'ADMIN'])
    if (denied) return denied
  } else if (!allowSelf) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  if (!storageReadiness().configured) {
    return NextResponse.json({ error: 'Profile photo storage is not configured.' }, { status: 503 })
  }

  const body = (await req.json()) as { image_data_url?: string; thumb_data_url?: string }
  const parsed = parseDataUrl(String(body.image_data_url || ''))
  if (!parsed) return NextResponse.json({ error: 'image_data_url required' }, { status: 400 })
  if (!parsed.contentType.startsWith('image/')) {
    return NextResponse.json({ error: 'Invalid image payload' }, { status: 400 })
  }
  if (parsed.buffer.length > 8 * 1024 * 1024) {
    return NextResponse.json({ error: 'Image too large' }, { status: 400 })
  }

  const thumbParsed = body.thumb_data_url ? parseDataUrl(body.thumb_data_url) : null
  const processed = await processProfileImageUpload(parsed.buffer, parsed.contentType)
  const thumbBuffer = thumbParsed?.buffer && thumbParsed.buffer.length > 0 ? thumbParsed.buffer : processed.thumb

  await uploadProfileImages(targetUserId, processed.avatar, thumbBuffer)

  const updated = await prisma.user.update({
    where: { id: targetUserId },
    data: {
      profileImageUrl: userAvatarUrl(targetUserId),
      updatedAt: new Date(),
    },
    select: { id: true, profileImageUrl: true, updatedAt: true },
  })

  return NextResponse.json({
    ok: true,
    profileImageUrl: `${updated.profileImageUrl}?v=${updated.updatedAt.getTime()}`,
    updatedAt: updated.updatedAt.toISOString(),
  })
}

export async function handleProfileImageDelete(req: NextRequest, targetUserId: string, allowSelf = true) {
  const token = await getJwt(req)
  if (!token?.sub) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const isSelf = token.sub === targetUserId
  if (!isSelf) {
    const denied = await requireRoles(req, ['SUPER_ADMIN', 'ADMIN'])
    if (denied) return denied
  } else if (!allowSelf) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  if (storageReadiness().configured) {
    await deleteProfileImages(targetUserId)
  }

  await prisma.user.update({
    where: { id: targetUserId },
    data: { profileImageUrl: null },
  })

  return NextResponse.json({ ok: true })
}
