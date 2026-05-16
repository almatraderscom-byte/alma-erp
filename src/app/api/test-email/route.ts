import { NextResponse } from 'next/server'
import { almaEmailTemplate, sendEmail } from '@/lib/resend'

export const dynamic = 'force-dynamic'

export async function GET() {
  if (process.env.NODE_ENV === 'production' && process.env.ENABLE_TEST_EMAIL_ENDPOINT !== 'true') {
    return NextResponse.json({ ok: false, error: 'Test email endpoint is disabled in production' }, { status: 404 })
  }

  const result = await sendEmail({
    to: 'delivered@resend.dev',
    subject: 'Alma ERP email test',
    title: 'Resend is connected',
    preview: 'Alma ERP sent this premium dark/gold test email successfully.',
    priority: 'NORMAL',
    actionUrl: '/settings/notifications',
    actionLabel: 'Open notification settings',
    category: 'test',
    dedupeKey: `test-email:${new Date().toISOString().slice(0, 13)}`,
    html: almaEmailTemplate({
      title: 'Resend is connected',
      preview: 'Alma ERP sent this premium dark/gold test email successfully.',
      priority: 'NORMAL',
      actionUrl: '/settings/notifications',
      actionLabel: 'Open notification settings',
      body: `
        <p style="margin:0 0 14px;">Your Resend API key is active and Alma ERP can send operational email notifications.</p>
        <div style="border:1px solid rgba(214,169,74,.22);border-radius:16px;padding:14px;background:rgba(214,169,74,.06);">
          <strong style="color:#f8f1df;">Verified channel:</strong>
          <span style="color:#d4d4d8;">orders, invoices, payroll, finance, and admin alerts.</span>
        </div>
      `,
    }),
    text: 'Resend is connected. Alma ERP can send operational email notifications.',
  })

  const payload = result as {
    ok: boolean
    id?: string | null
    skipped?: boolean
    duplicatePrevented?: boolean
    error?: string | null
  }

  return NextResponse.json({
    ok: result.ok,
    messageId: payload.id || null,
    skipped: payload.skipped || false,
    duplicatePrevented: payload.duplicatePrevented || false,
    error: payload.error || null,
  }, { status: payload.ok || payload.duplicatePrevented ? 200 : 500 })
}
