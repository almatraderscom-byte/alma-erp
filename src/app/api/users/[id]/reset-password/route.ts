import { NextRequest, NextResponse } from 'next/server'
import bcrypt from 'bcryptjs'
import { prisma } from '@/lib/prisma'
import { getJwt, requireRoles } from '@/lib/api-guards'

export async function POST(
  req: NextRequest,
  { params }: { params: { id: string } },
) {
  const denied = await requireRoles(req, ['SUPER_ADMIN', 'ADMIN'])
  if (denied) return denied
  const token = await getJwt(req)

  try {
    const { password } = (await req.json()) as { password?: string }
    const p = String(password || '')
    if (p.length < 8) return NextResponse.json({ error: 'Password too short' }, { status: 400 })

    const target = await prisma.user.findUnique({ where: { id: params.id }, select: { role: true } })
    if (!target) return NextResponse.json({ error: 'Not found' }, { status: 404 })
    if (target.role === 'SUPER_ADMIN' && token?.role !== 'SUPER_ADMIN') {
      return NextResponse.json({ error: 'Only Super Admin can reset a Super Admin password' }, { status: 403 })
    }

    const passwordHash = await bcrypt.hash(p, 12)
    await prisma.user.update({
      where: { id: params.id },
      data: { passwordHash },
    })
    return NextResponse.json({ ok: true })
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 })
  }
}
