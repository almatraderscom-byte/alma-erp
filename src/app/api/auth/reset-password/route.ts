import { NextRequest, NextResponse } from 'next/server'
import { createHash } from 'crypto'
import bcrypt from 'bcryptjs'
import { prisma } from '@/lib/prisma'

export async function POST(req: NextRequest) {
  try {
    const { token, password } = (await req.json()) as { token?: string; password?: string }
    if (!token || !password || password.length < 8) {
      return NextResponse.json({ error: 'Invalid payload' }, { status: 400 })
    }
    const tokenHash = createHash('sha256').update(token).digest('hex')
    const row = await prisma.passwordResetToken.findUnique({ where: { tokenHash } })
    if (!row || row.expiresAt < new Date()) {
      return NextResponse.json({ error: 'Invalid or expired token' }, { status: 400 })
    }

    const passwordHash = await bcrypt.hash(password, 12)
    await prisma.$transaction([
      prisma.user.update({
        where: { id: row.userId },
        data: { passwordHash },
      }),
      prisma.passwordResetToken.delete({ where: { id: row.id } }),
    ])

    return NextResponse.json({ ok: true })
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 })
  }
}
