import { ATTENDANCE_TIMEZONE, OFFICE_START_MINUTES } from '@/lib/attendance'
import { BUSINESSES, type BusinessId } from '@/lib/businesses'

const TIME_FMT = new Intl.DateTimeFormat('en-GB', {
  timeZone: ATTENDANCE_TIMEZONE,
  hour: 'numeric',
  minute: '2-digit',
  hour12: true,
})

const DATE_FMT = new Intl.DateTimeFormat('en-GB', {
  timeZone: ATTENDANCE_TIMEZONE,
  day: '2-digit',
  month: 'short',
  year: 'numeric',
})

export function erpBaseUrl(): string {
  const raw = process.env.NEXTAUTH_URL || process.env.VERCEL_URL
  if (!raw) return 'https://alma-erp-six.vercel.app'
  if (raw.startsWith('http')) return raw.replace(/\/$/, '')
  return `https://${raw}`
}

export function attendanceDeepLink(businessId: string, employeeId?: string | null): string {
  const base = erpBaseUrl()
  const qs = new URLSearchParams({ business_id: businessId })
  if (employeeId) qs.set('employee_id', employeeId)
  return `${base}/attendance?${qs.toString()}`
}

export function tradingDeepLink(path: string): string {
  return `${erpBaseUrl()}${path.startsWith('/') ? path : `/${path}`}`
}

export function businessLabel(businessId: string): string {
  const b = BUSINESSES[businessId as BusinessId]
  return b?.shortName || b?.name || businessId
}

export function formatBdTime(date: Date | string): string {
  return TIME_FMT.format(typeof date === 'string' ? new Date(date) : date)
}

export function formatBdDate(date: Date | string): string {
  return DATE_FMT.format(typeof date === 'string' ? new Date(date) : date)
}

export function formatMinutesLabel(minutes: number): string {
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  if (!h) return `${m}m`
  if (!m) return `${h}h`
  return `${h}h ${m}m`
}

export function formatOfficeStart(minutes = OFFICE_START_MINUTES): string {
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  const period = h >= 12 ? 'PM' : 'AM'
  const hour12 = h % 12 || 12
  return m ? `${hour12}:${String(m).padStart(2, '0')} ${period}` : `${hour12}:00 ${period}`
}

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

export type CheckInAlertInput = {
  employeeName: string
  department: string
  checkInAt: Date
  lateMinutes: number
  phone: string | null
  erpLink: string
}

export type FaceVerifiedCheckInInput = {
  employeeName: string
  department: string
  checkInAt: Date
  lateMinutes: number
  phone: string | null
  erpLink: string
}

export function formatFaceVerifiedCheckInAlert(input: FaceVerifiedCheckInInput): string {
  const lines = [
    '🟢 <b>Employee Verified Check-In</b>',
    '',
    `👤 <b>Employee:</b> ${escapeHtml(input.employeeName)}`,
    `🕒 <b>Time:</b> ${formatBdTime(input.checkInAt)}`,
    `🏢 <b>Department:</b> ${escapeHtml(input.department)}`,
    '',
    '📸 <b>Verification Photo Attached</b>',
  ]
  if (input.phone) lines.push(`📞 <b>Phone:</b> ${escapeHtml(input.phone)}`)
  if (input.lateMinutes > 0) {
    lines.push('', `🔴 <b>LATE</b> by ${input.lateMinutes} minutes`)
  }
  lines.push('', `<a href="${input.erpLink}">Open in ERP →</a>`)
  return lines.join('\n')
}

export function formatCheckInAlert(input: CheckInAlertInput): string {
  const onTime = input.lateMinutes <= 0
  const header = onTime ? '🟢 <b>Employee Checked In</b>' : '🟢 <b>Employee Checked In</b>'
  const status = onTime ? 'On Time' : 'Late'
  const lines = [
    header,
    '',
    `👤 <b>Employee:</b> ${escapeHtml(input.employeeName)}`,
    `🕒 <b>Time:</b> ${formatBdTime(input.checkInAt)}`,
    `🏢 <b>Department:</b> ${escapeHtml(input.department)}`,
    `📍 <b>Status:</b> ${status}`,
  ]
  if (input.phone) lines.push(`📞 <b>Phone:</b> ${escapeHtml(input.phone)}`)
  if (!onTime) {
    lines.push('', `🔴 <b>LATE</b> by ${input.lateMinutes} minutes`)
  }
  lines.push('', `<a href="${input.erpLink}">Open in ERP →</a>`)
  return lines.join('\n')
}

export type AbsentAlertInput = {
  employeeName: string
  department: string
  officeStartLabel: string
  delayMinutes: number
  phone: string | null
  attendanceStatus: string
  erpLink: string
}

export function formatAbsentAlert(input: AbsentAlertInput): string {
  const lines = [
    '⚠️ <b>Employee Not Checked In</b>',
    '',
    `👤 <b>Employee:</b> ${escapeHtml(input.employeeName)}`,
    `🏢 <b>Department:</b> ${escapeHtml(input.department)}`,
    `🕒 <b>Office Start:</b> ${input.officeStartLabel}`,
    `⏳ <b>Current Delay:</b> ${input.delayMinutes} minutes`,
    `📋 <b>Status:</b> ${escapeHtml(input.attendanceStatus)}`,
  ]
  if (input.phone) lines.push(`📞 <b>Phone:</b> ${escapeHtml(input.phone)}`)
  lines.push('', `<a href="${input.erpLink}">Open in ERP →</a>`)
  return lines.join('\n')
}

export type CheckOutAlertInput = {
  employeeName: string
  checkOutAt: Date
  totalWorkMinutes: number
  erpLink: string
}

export function formatCheckOutAlert(input: CheckOutAlertInput): string {
  return [
    '🔵 <b>Employee Checked Out</b>',
    '',
    `👤 ${escapeHtml(input.employeeName)}`,
    `🕒 ${formatBdTime(input.checkOutAt)}`,
    `⏱ <b>Total Hours:</b> ${formatMinutesLabel(input.totalWorkMinutes)}`,
    '',
    `<a href="${input.erpLink}">Open in ERP →</a>`,
  ].join('\n')
}

export type NoCheckoutAlertInput = {
  employeeName: string
  lastActivityAt: Date | null
  checkInAt: Date
  erpLink: string
}

export function formatNoCheckoutAlert(input: NoCheckoutAlertInput): string {
  const activity = input.lastActivityAt
    ? formatBdTime(input.lastActivityAt)
    : formatBdTime(input.checkInAt)
  return [
    '⚠️ <b>Missing Checkout</b>',
    '',
    `<b>Employee:</b> ${escapeHtml(input.employeeName)}`,
    `<b>Checked in:</b> ${formatBdTime(input.checkInAt)}`,
    `<b>Last activity:</b> ${activity}`,
    '',
    `<a href="${input.erpLink}">Open in ERP →</a>`,
  ].join('\n')
}

export type EarlyLeaveAlertInput = {
  employeeName: string
  workedMinutes: number
  erpLink: string
}

export function formatEarlyLeaveAlert(input: EarlyLeaveAlertInput): string {
  return [
    '⚠️ <b>Early Leave Detected</b>',
    '',
    `<b>Employee:</b> ${escapeHtml(input.employeeName)}`,
    `<b>Worked:</b> ${formatMinutesLabel(input.workedMinutes)}`,
    '',
    `<a href="${input.erpLink}">Open in ERP →</a>`,
  ].join('\n')
}

export type SuspiciousCheckInInput = {
  employeeName: string
  reasons: string[]
  checkInAt: Date
  erpLink: string
}

export function formatSuspiciousCheckInAlert(input: SuspiciousCheckInInput): string {
  return [
    '🚨 <b>Suspicious Attendance</b>',
    '',
    `👤 ${escapeHtml(input.employeeName)}`,
    `🕒 ${formatBdTime(input.checkInAt)}`,
    `<b>Flags:</b> ${input.reasons.map(escapeHtml).join(', ')}`,
    '',
    `<a href="${input.erpLink}">Review in ERP →</a>`,
  ].join('\n')
}

export function formatScreenshotUploadAlert(input: {
  accountTitle: string
  uploaderName: string
  shotDate: string
  link: string
}): string {
  return [
    '📸 <b>Screenshot Uploaded</b>',
    '',
    `<b>Account:</b> ${escapeHtml(input.accountTitle)}`,
    `<b>By:</b> ${escapeHtml(input.uploaderName)}`,
    `<b>Date:</b> ${escapeHtml(input.shotDate)}`,
    '',
    `<a href="${input.link}">View account →</a>`,
  ].join('\n')
}

export function formatScreenshotFailureAlert(input: {
  accountTitle: string
  uploaderName: string
  error: string
  link: string
}): string {
  return [
    '❌ <b>Screenshot Upload Failed</b>',
    '',
    `<b>Account:</b> ${escapeHtml(input.accountTitle)}`,
    `<b>By:</b> ${escapeHtml(input.uploaderName)}`,
    `<b>Error:</b> ${escapeHtml(input.error.slice(0, 200))}`,
    '',
    `<a href="${input.link}">Open trading →</a>`,
  ].join('\n')
}

export function formatDeleteRequestAlert(input: {
  accountTitle: string
  requesterName: string
  reason: string
  link: string
}): string {
  return [
    '🗑 <b>Delete Request</b>',
    '',
    `<b>Account:</b> ${escapeHtml(input.accountTitle)}`,
    `<b>Requested by:</b> ${escapeHtml(input.requesterName)}`,
    `<b>Reason:</b> ${escapeHtml(input.reason.slice(0, 300))}`,
    '',
    `<a href="${input.link}">Review approval →</a>`,
  ].join('\n')
}
