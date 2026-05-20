import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { getJwt } from '@/lib/api-guards'
import { fetchProfileImageBuffer } from '@/lib/profile-image'
import { handleProfileImageDelete, handleProfileImageUpload } from '@/lib/profile-image-admin'

export const runtime = 'nodejs'
export const maxDuration = 60

export async function GET(
  req: NextRequest,
  { params }: { params: { id: string } },
) {
  try {
    const token = await getJwt(req)
    if (!token?.sub) return new NextResponse('Unauthorized', { status: 401 })

    const userId = decodeURIComponent(params.id || '')
    if (!userId) return new NextResponse('Not found', { status: 404 })

    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { profileImageUrl: true },
    })
    if (!user?.profileImageUrl) return new NextResponse(null, { status: 404 })
    if (/^https?:\/\//i.test(user.profileImageUrl)) {
      return NextResponse.redirect(user.profileImageUrl, { status: 302 })
    }

    const variant = new URL(req.url).searchParams.get('size') === 'thumb' ? 'thumb' : 'avatar'
    const image = await fetchProfileImageBuffer(userId, variant)
    if (!image) return new NextResponse(null, { status: 404 })

    const v = new URL(req.url).searchParams.get('v')
    const cacheSeconds = v ? 60 * 60 * 24 * 7 : 60 * 60
    return new NextResponse(image.buffer, {
      status: 200,
      headers: {
        'Content-Type': image.contentType,
        'Cache-Control': `private, max-age=${cacheSeconds}, must-revalidate`,
        Vary: 'Cookie',
      },
    })
  } catch {
    return new NextResponse('Error', { status: 500 })
  }
}

export async function POST(
  req: NextRequest,
  { params }: { params: { id: string } },
) {
  try {
    const userId = decodeURIComponent(params.id || '')
    if (!userId) return NextResponse.json({ error: 'Not found' }, { status: 404 })
    return await handleProfileImageUpload(req, userId)
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 })
  }
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: { id: string } },
) {
  try {
    const userId = decodeURIComponent(params.id || '')
    if (!userId) return NextResponse.json({ error: 'Not found' }, { status: 404 })
    return await handleProfileImageDelete(req, userId)
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 })
  }
}
