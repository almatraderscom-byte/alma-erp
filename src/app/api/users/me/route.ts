import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { getJwt } from '@/lib/api-guards'

const ME_SELECT = {
  id: true,
  email: true,
  name: true,
  phone: true,
  role: true,
  active: true,
  businessAccess: true,
  employeeIdGas: true,
  joiningDate: true,
  salaryHint: true,
  profileImageUrl: true,
  createdAt: true,
} as const

export async function GET(req: NextRequest) {
  try {
    const token = await getJwt(req)
    if (!token?.sub) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const user = await prisma.user.findUnique({
      where: { id: token.sub },
      select: ME_SELECT,
    })
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

    const user = await prisma.user.findUnique({
      where: { id: token.sub },
      select: ME_SELECT,
    })
    return NextResponse.json({ ok: true, user })
  } catch (e) {
    const msg = (e as Error).message
    if (msg.includes('NEXTAUTH_SECRET')) {
      return NextResponse.json({ error: 'Auth not configured' }, { status: 500 })
    }
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
