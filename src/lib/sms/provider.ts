import type { SmsDeliveryReport, SmsProviderSendResult } from '@/lib/sms/types'

const DEFAULT_SMS_API_URL = 'https://api.sms.net.bd'
const SMS_TIMEOUT_MS = 8_000

const PROVIDER_ERRORS: Record<string, string> = {
  '400': 'Invalid parameter',
  '403': 'Permission denied',
  '404': 'Endpoint missing',
  '405': 'Authorization required',
  '409': 'Provider unknown error',
  '410': 'Account expired',
  '412': 'Invalid schedule',
  '413': 'Invalid sender ID',
  '414': 'Empty message',
  '415': 'Message too long',
  '416': 'Invalid number',
  '417': 'Insufficient balance',
  '420': 'Content blocked',
  '421': 'Recharge required',
}

function apiBase() {
  return (process.env.SMS_API_URL || DEFAULT_SMS_API_URL).replace(/\/+$/, '')
}

function apiKey() {
  return String(process.env.SMS_API_KEY || '').trim()
}

function senderId() {
  return String(process.env.SMS_SENDER_ID || '').trim()
}

export function smsProviderConfigured() {
  return Boolean(apiKey())
}

export function providerErrorMessage(code: unknown, fallback?: string) {
  const key = String(code ?? '').trim()
  return PROVIDER_ERRORS[key] || fallback || 'SMS provider error'
}

export async function sendSmsViaProvider(input: {
  to: string
  message: string
  senderId?: string | null
  schedule?: string | null
  contentId?: string | null
}): Promise<SmsProviderSendResult> {
  if (!smsProviderConfigured()) {
    return { ok: false, errorCode: 'CONFIG', errorMessage: 'SMS_API_KEY is not configured.' }
  }
  if (!input.message.trim()) {
    return { ok: false, errorCode: '414', errorMessage: providerErrorMessage('414') }
  }

  const body = new URLSearchParams()
  body.set('api_key', apiKey())
  body.set('msg', input.message)
  body.set('to', input.to)
  const resolvedSender = input.senderId?.trim() || senderId()
  if (resolvedSender) body.set('sender_id', resolvedSender)
  if (input.schedule) body.set('schedule', input.schedule)
  if (input.contentId) body.set('content_id', input.contentId)

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), SMS_TIMEOUT_MS)
  try {
    const res = await fetch(`${apiBase()}/sendsms`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
      body,
      signal: controller.signal,
    })
    const json = await res.json().catch(() => ({}))
    const code = String((json as { error?: unknown }).error ?? (res.ok ? 0 : res.status))
    if (!res.ok || code !== '0') {
      return {
        ok: false,
        errorCode: code,
        errorMessage: providerErrorMessage(code, (json as { msg?: string }).msg),
        raw: json,
      }
    }
    return {
      ok: true,
      requestId: String((json as { data?: { request_id?: unknown } }).data?.request_id || ''),
      raw: json,
    }
  } catch (e) {
    return {
      ok: false,
      errorCode: e instanceof Error && e.name === 'AbortError' ? 'TIMEOUT' : 'NETWORK',
      errorMessage: e instanceof Error && e.name === 'AbortError' ? 'SMS provider request timed out.' : (e as Error).message,
    }
  } finally {
    clearTimeout(timer)
  }
}

export async function fetchSmsBalance() {
  if (!smsProviderConfigured()) return { ok: false, error: 'SMS_API_KEY is not configured.' }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), SMS_TIMEOUT_MS)
  try {
    const res = await fetch(`${apiBase()}/user/balance/?api_key=${encodeURIComponent(apiKey())}`, {
      cache: 'no-store',
      signal: controller.signal,
    })
    const json = await res.json().catch(() => ({}))
    if (!res.ok) return { ok: false, error: providerErrorMessage(res.status, (json as { msg?: string }).msg), raw: json }
    return { ok: true, data: json }
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  } finally {
    clearTimeout(timer)
  }
}

export async function fetchSmsReport(requestId: string): Promise<SmsDeliveryReport> {
  if (!smsProviderConfigured()) return { ok: false, status: 'Pending', errorCode: 'CONFIG', errorMessage: 'SMS_API_KEY is not configured.' }
  const id = requestId.trim()
  if (!id) return { ok: false, status: 'Pending', errorCode: 'NO_REQUEST_ID', errorMessage: 'Missing request ID.' }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), SMS_TIMEOUT_MS)
  try {
    const res = await fetch(`${apiBase()}/report/request/${encodeURIComponent(id)}/?api_key=${encodeURIComponent(apiKey())}`, {
      cache: 'no-store',
      signal: controller.signal,
    })
    const json = await res.json().catch(() => ({}))
    if (!res.ok) return { ok: false, status: 'Pending', errorCode: String(res.status), errorMessage: providerErrorMessage(res.status), raw: json }
    const text = JSON.stringify(json).toLowerCase()
    const status = text.includes('fail') ? 'Failed' : text.includes('sent') || text.includes('delivered') || text.includes('success') ? 'Sent' : 'Pending'
    return { ok: true, status, raw: json }
  } catch (e) {
    return { ok: false, status: 'Pending', errorCode: 'NETWORK', errorMessage: (e as Error).message }
  } finally {
    clearTimeout(timer)
  }
}
