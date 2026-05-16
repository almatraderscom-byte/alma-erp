import { NextRequest, NextResponse } from 'next/server'
import { createHash, randomBytes } from 'crypto'
import { prisma } from '@/lib/prisma'
import { sendEmail, almaEmailTemplate } from '@/lib/resend'
import { errorMeta, logEvent } from '@/lib/logger'

export async function POST(req: NextRequest) {
  try {
    const { email } = (await req.json()) as { email?: string }
    const e = String(email || '').trim().toLowerCase()
    if (!e) return NextResponse.json({ ok: true })

    const user = await prisma.user.findUnique({ where: { email: e } })
    if (!user) return NextResponse.json({ ok: true })

    const raw = randomBytes(32).toString('hex')
    const tokenHash = createHash('sha256').update(raw).digest('hex')
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000)

    await prisma.passwordResetToken.deleteMany({ where: { userId: user.id } })
    await prisma.passwordResetToken.create({
      data: { tokenHash, userId: user.id, expiresAt },
    })

    const url = `${process.env.NEXTAUTH_URL || process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000'}/reset-password?token=${raw}`
    if (process.env.NODE_ENV !== 'production') {
      console.info('[forgot-password] reset URL for', e, url)
    }
    await sendEmail({
      to: user.email || '',
      subject: 'Reset your Alma ERP password',
      title: 'Password reset requested',
      preview: 'Use this secure link to reset your Alma ERP password.',
      priority: 'HIGH',
      actionUrl: url,
      actionLabel: 'Reset password',
      category: 'auth',
      dedupeKey: `password-reset:${user.id}:${tokenHash.slice(0, 12)}`,
      html: almaEmailTemplate({
        title: 'Password reset requested',
        preview: 'Use this secure link to reset your Alma ERP password.',
        priority: 'HIGH',
        actionUrl: url,
        actionLabel: 'Reset password',
        body: '<p style="margin:0;color:#d4d4d8;">This link expires in 60 minutes. If you did not request it, you can ignore this email.</p>',
      }),
      text: `Reset your Alma ERP password: ${url}`,
      metadata: { userId: user.id },
    })

    return NextResponse.json({ ok: true })
  } catch (e) {
    logEvent('error', 'auth.forgot_password_failed', errorMeta(e))
    return NextResponse.json({ error: (e as Error).message }, { status: 500 })
  }
}
