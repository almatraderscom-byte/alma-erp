import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { getJwt } from '@/lib/api-guards'
import { businessAllowed } from '@/lib/business-access'
import { createSignedObjectUrl } from '@/lib/supabase-storage'

export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  try {
    const token = await getJwt(req)
    if (!token?.sub) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    const attachment = await prisma.expenseAttachment.findUnique({ where: { id: params.id } })
    if (!attachment || attachment.deletedAt) return NextResponse.json({ error: 'Receipt not found' }, { status: 404 })
    if (!businessAllowed(token.businessAccess as string, attachment.businessId)) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }

    const url = await createSignedObjectUrl(
      attachment.bucket,
      attachment.objectPath,
      new URL(req.url).searchParams.get('download') === '1',
    )
    return NextResponse.redirect(url, {
      headers: {
        'Cache-Control': 'private, no-store, must-revalidate',
      },
    })
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 })
  }
}
