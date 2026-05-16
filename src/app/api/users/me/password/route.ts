import { NextRequest, NextResponse } from 'next/server'
import bcrypt from 'bcryptjs'
import { prisma } from '@/lib/prisma'
import { getJwt } from '@/lib/api-guards'

export async function POST(req: NextRequest) {
  try {
    const token = await getJwt(req)
    if (!token?.sub) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const { currentPassword, newPassword } = (await req.json()) as {
      currentPassword?: string
      newPassword?: string
    }
    const cur = String(currentPassword || '')
    const neu = String(newPassword || '')
    if (cur.length < 1 || neu.length < 8) {
      return NextResponse.json({ error: 'Current password and new password (8+ chars) required' }, { status: 400 })
    }

    const user = await prisma.user.findUnique({
      where: { id: token.sub },
      select: { passwordHash: true },
    })
    if (!user) return NextResponse.json({ error: 'Not found' }, { status: 404 })

    const ok = await bcrypt.compare(cur, user.passwordHash)
    if (!ok) return NextResponse.json({ error: 'Current password incorrect' }, { status: 400 })

    const passwordHash = await bcrypt.hash(neu, 12)
    await prisma.user.update({
      where: { id: token.sub },
      data: { passwordHash },
    })
    return NextResponse.json({ ok: true })
  } catch (e) {
    const msg = (e as Error).message
    if (msg.includes('NEXTAUTH_SECRET')) {
      return NextResponse.json({ error: 'Auth not configured' }, { status: 500 })
    }
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
