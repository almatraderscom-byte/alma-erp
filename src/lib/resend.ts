import { Resend } from 'resend'
import type { NotificationPriority } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import { logEvent } from '@/lib/logger'

function getFrom() {
  return process.env.EMAIL_FROM || 'Alma ERP <onboarding@resend.dev>'
}

let _resend: Resend | null = null
function getResend(): Resend | null {
  if (_resend) return _resend
  const key = process.env.RESEND_API_KEY
  if (!key) return null
  _resend = new Resend(key)
  return _resend
}

type EmailInput = {
  to: string | string[]
  subject: string
  title?: string
  preview?: string
  html?: string
  text?: string
  priority?: NotificationPriority
  actionUrl?: string
  actionLabel?: string
  category?: string
  dedupeKey?: string
  notificationId?: string
  recipientUserId?: string
  metadata?: Record<string, unknown>
}

function escapeHtml(value: string) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;')
}

function priorityColor(priority: NotificationPriority) {
  if (priority === 'CRITICAL') return '#ef4444'
  if (priority === 'HIGH') return '#f59e0b'
  if (priority === 'LOW') return '#71717a'
  return '#d6a94a'
}

function appUrl(path?: string) {
  const base = process.env.NEXTAUTH_URL || process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000'
  if (!path) return base
  if (/^https?:\/\//i.test(path)) return path
  return `${base.replace(/\/$/, '')}/${path.replace(/^\//, '')}`
}

export function almaEmailTemplate(input: {
  title: string
  preview?: string
  body: string
  priority?: NotificationPriority
  actionUrl?: string
  actionLabel?: string
  footer?: string
}) {
  const priority = input.priority || 'NORMAL'
  const color = priorityColor(priority)
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(input.title)}</title>
  </head>
  <body style="margin:0;background:#050506;color:#f8f1df;font-family:Inter,Segoe UI,Arial,sans-serif;">
    <div style="display:none;max-height:0;overflow:hidden;color:transparent;">${escapeHtml(input.preview || input.title)}</div>
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:radial-gradient(circle at top left,#2b2110 0,#050506 38%,#050506 100%);padding:32px 12px;">
      <tr>
        <td align="center">
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:640px;border:1px solid rgba(214,169,74,.28);border-radius:24px;background:#0b0b0f;overflow:hidden;box-shadow:0 24px 80px rgba(0,0,0,.45);">
            <tr>
              <td style="padding:28px 30px 18px;border-bottom:1px solid rgba(255,255,255,.08);background:linear-gradient(135deg,rgba(214,169,74,.14),rgba(214,169,74,0));">
                <div style="font-size:11px;letter-spacing:.18em;text-transform:uppercase;color:#d6a94a;font-weight:900;">Alma ERP</div>
                <h1 style="margin:10px 0 0;font-size:26px;line-height:1.18;color:#f8f1df;">${escapeHtml(input.title)}</h1>
                <div style="display:inline-block;margin-top:14px;padding:6px 10px;border-radius:999px;border:1px solid ${color};color:${color};font-size:11px;font-weight:800;letter-spacing:.08em;">${priority}</div>
              </td>
            </tr>
            <tr>
              <td style="padding:28px 30px;color:#d4d4d8;font-size:14px;line-height:1.7;">
                ${input.body}
                ${input.actionUrl ? `<div style="margin-top:26px;"><a href="${escapeHtml(appUrl(input.actionUrl))}" style="display:inline-block;background:#d6a94a;color:#0b0b0f;text-decoration:none;font-weight:900;border-radius:14px;padding:12px 18px;">${escapeHtml(input.actionLabel || 'Open Alma ERP')}</a></div>` : ''}
              </td>
            </tr>
            <tr>
              <td style="padding:18px 30px;border-top:1px solid rgba(255,255,255,.08);color:#71717a;font-size:11px;line-height:1.5;">
                ${escapeHtml(input.footer || 'This operational email was sent by Alma ERP.')}
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`
}

async function alreadySent(dedupeKey?: string) {
  if (!dedupeKey) return false
  const count = await prisma.notification.count({
    where: { metadataJson: { contains: `"emailDedupeKey":"${dedupeKey}"` } },
  })
  return count > 0
}

async function recordEmailAudit(input: EmailInput, result: { ok: boolean; id?: string | null; error?: string | null; skipped?: boolean }) {
  if (input.notificationId) return
  const to = Array.isArray(input.to) ? input.to : [input.to]
  await prisma.notification.create({
    data: {
      type: 'ADMIN_ANNOUNCEMENT',
      priority: input.priority || 'NORMAL',
      title: input.subject.slice(0, 160),
      message: (input.text || input.preview || input.subject).slice(0, 2000),
      actionUrl: input.actionUrl || null,
      metadataJson: JSON.stringify({
        emailDedupeKey: input.dedupeKey || null,
        emailStatus: result.ok ? 'SENT' : result.skipped ? 'SKIPPED' : 'FAILED',
        emailMessageId: result.id || null,
        emailError: result.error || null,
        to,
        category: input.category || null,
        metadata: input.metadata || null,
      }).slice(0, 12000),
    },
  })
}

export async function sendEmail(input: EmailInput) {
  const to = Array.isArray(input.to) ? input.to.filter(Boolean) : [input.to].filter(Boolean)
  if (!to.length) return { ok: false, skipped: true, error: 'No recipients' }
  if (input.dedupeKey && await alreadySent(input.dedupeKey)) {
    return { ok: true, skipped: true, duplicatePrevented: true }
  }
  const resend = getResend()
  if (!resend) {
    logEvent('warn', 'resend_not_configured', { subject: input.subject })
    const result = { ok: false, skipped: true, error: 'RESEND_API_KEY is not configured' }
    await recordEmailAudit(input, result)
    return result
  }

  const html = input.html || almaEmailTemplate({
    title: input.title || input.subject,
    preview: input.preview,
    priority: input.priority,
    actionUrl: input.actionUrl,
    actionLabel: input.actionLabel,
    body: `<p style="margin:0;">${escapeHtml(input.text || input.preview || input.subject)}</p>`,
  })

  try {
    const result = await resend.emails.send({
      from: getFrom(),
      to,
      subject: input.subject,
      html,
      text: input.text || input.preview || input.subject,
      headers: input.dedupeKey ? { 'X-Alma-Dedupe-Key': input.dedupeKey } : undefined,
    })
    const id = result.data?.id || null
    if (input.notificationId && input.recipientUserId) {
      await prisma.notificationRecipient.updateMany({
        where: { notificationId: input.notificationId, userId: input.recipientUserId },
        data: { emailStatus: id ? 'SENT' : 'FAILED', emailMessageId: id, emailSentAt: id ? new Date() : null, emailError: result.error?.message || null },
      })
    }
    logEvent(id ? 'info' : 'warn', 'resend_email_send', { subject: input.subject, toCount: to.length, messageId: id, error: result.error?.message })
    const final = { ok: Boolean(id), id, error: result.error?.message || null }
    await recordEmailAudit(input, final)
    return final
  } catch (e) {
    if (input.notificationId && input.recipientUserId) {
      await prisma.notificationRecipient.updateMany({
        where: { notificationId: input.notificationId, userId: input.recipientUserId },
        data: { emailStatus: 'FAILED', emailError: (e as Error).message },
      })
    }
    logEvent('error', 'resend_email_failed', { subject: input.subject, error: (e as Error).message })
    const final = { ok: false, error: (e as Error).message }
    await recordEmailAudit(input, final)
    return final
  }
}

async function roleEmails(role: 'SUPER_ADMIN' | 'ADMIN' | 'HR', businessId?: string) {
  const users = await prisma.user.findMany({
    where: {
      active: true,
      role,
      ...(businessId ? { businessAccess: { contains: businessId } } : {}),
    },
    select: { email: true },
  })
  return users.map(u => u.email).filter(Boolean) as string[]
}

async function superAdminEmails() {
  return roleEmails('SUPER_ADMIN')
}

export async function sendAdminAlert(input: Omit<EmailInput, 'to'> & { businessId?: string }) {
  const to = await superAdminEmails()
  return sendEmail({ ...input, to, category: input.category || 'admin' })
}

export async function sendOrderAlert(input: Omit<EmailInput, 'to'> & { businessId?: string }) {
  const to = [...await roleEmails('SUPER_ADMIN', input.businessId), ...await roleEmails('ADMIN', input.businessId)]
  return sendEmail({ ...input, to: [...new Set(to)], category: 'orders' })
}

export async function sendPayrollAlert(input: Omit<EmailInput, 'to'> & { businessId?: string }) {
  const to = [...await roleEmails('SUPER_ADMIN', input.businessId), ...await roleEmails('HR', input.businessId)]
  return sendEmail({ ...input, to: [...new Set(to)], category: 'payroll' })
}

export async function sendFinanceAlert(input: Omit<EmailInput, 'to'> & { businessId?: string }) {
  const to = [...await roleEmails('SUPER_ADMIN', input.businessId), ...await roleEmails('ADMIN', input.businessId), ...await roleEmails('HR', input.businessId)]
  return sendEmail({ ...input, to: [...new Set(to)], category: 'finance' })
}
