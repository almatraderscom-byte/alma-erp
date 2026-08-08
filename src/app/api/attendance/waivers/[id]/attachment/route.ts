import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireWalletContext } from '@/lib/core/safe-route-helpers'

export const dynamic = 'force-dynamic'

export async function GET(
  req: NextRequest,
  { params }: { params: { id: string } },
) {
  const url = new URL(req.url)
  const auth = await requireWalletContext(req, url.searchParams.get('business_id'))
  if (!auth.ok) return auth.response

  const row = await prisma.attendanceWaiverRequest.findFirst({
    where: {
      id: params.id,
      businessId: { in: auth.ctx.businessIds },
    },
    select: { userId: true, attachmentDataUrl: true },
  })
  if (!row) return NextResponse.json({ error: 'Appeal not found.' }, { status: 404 })
  if (!auth.ctx.isAdmin && row.userId !== auth.ctx.userId) {
    return NextResponse.json({ error: 'Forbidden.' }, { status: 403 })
  }
  if (!row.attachmentDataUrl) {
    return NextResponse.json({ error: 'No attachment was submitted.' }, { status: 404 })
  }

  const match = /^data:image\/(jpeg|png|webp);base64,(.+)$/i.exec(row.attachmentDataUrl)
  if (!match) return NextResponse.json({ error: 'Stored attachment is invalid.' }, { status: 422 })

  return new NextResponse(Buffer.from(match[2], 'base64'), {
    headers: {
      'Content-Type': `image/${match[1].toLowerCase()}`,
      'Content-Disposition': `inline; filename="penalty-appeal-${params.id}.${match[1].toLowerCase() === 'jpeg' ? 'jpg' : match[1].toLowerCase()}"`,
      'Cache-Control': 'private, no-store, max-age=0',
      'X-Content-Type-Options': 'nosniff',
    },
  })
}
