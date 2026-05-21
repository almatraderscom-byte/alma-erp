import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { getJwt } from '@/lib/api-guards'
import { businessAllowed, parseBusinessAccess } from '@/lib/business-access'
import { DEFAULT_BUSINESS_ID, resolveBusinessId } from '@/lib/businesses'
import { resolveMyDeskProfile } from '@/lib/profile-resolution'

export async function GET(req: NextRequest) {
  try {
    const token = await getJwt(req)
    if (!token?.sub) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    const requestedBusinessId = new URL(req.url).searchParams.get('business_id')
    const allowedBusinesses = parseBusinessAccess(token.businessAccess as string)
    const businessId = requestedBusinessId
      ? resolveBusinessId(requestedBusinessId)
      : allowedBusinesses.length === 1
        ? allowedBusinesses[0]
        : DEFAULT_BUSINESS_ID
    if (!businessAllowed(token.businessAccess as string, businessId)) {
      return NextResponse.json({ error: 'Business not permitted for this user.' }, { status: 403 })
    }

    const user = await resolveMyDeskProfile(token.sub, businessId)
    if (!user) return NextResponse.json({ error: 'Not found' }, { status: 404 })

    return NextResponse.json({ user })
  } catch (e) {
    const msg = (e as Error).message
    if (msg.includes('NEXTAUTH_SECRET')) {
      return NextResponse.json({ error: 'Auth not configured' }, { status: 500 })
    }
    throw e
  }
}

export async function PATCH(req: NextRequest) {
  try {
    const token = await getJwt(req)
    if (!token?.sub) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const body = (await req.json()) as Partial<{ name: string; phone: string | null }>
    const data: { name?: string; phone?: string | null } = {}
    if (body.name !== undefined) {
      const n = String(body.name || '').trim()
      if (!n) return NextResponse.json({ error: 'Name required' }, { status: 400 })
      data.name = n
    }
    if (body.phone !== undefined) {
      data.phone = body.phone?.trim() || null
    }
    if (!Object.keys(data).length) {
      return NextResponse.json({ error: 'Nothing to update' }, { status: 400 })
    }

    await prisma.user.update({
      where: { id: token.sub },
      data,
    })

    const user = await resolveMyDeskProfile(token.sub, null)
    return NextResponse.json({ ok: true, user })
  } catch (e) {
    const msg = (e as Error).message
    if (msg.includes('NEXTAUTH_SECRET')) {
      return NextResponse.json({ error: 'Auth not configured' }, { status: 500 })
    }
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
