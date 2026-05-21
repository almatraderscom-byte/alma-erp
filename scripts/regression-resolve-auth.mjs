#!/usr/bin/env node
/**
 * Resolve production regression auth: REGRESSION_COOKIE or NextAuth credentials login.
 * Never logs cookie or password values.
 */
import { loadRegressionEnvFiles } from './regression-env.mjs'

loadRegressionEnvFiles()

const PROD_COOKIE_NAMES = [
  '__Secure-next-auth.session-token',
  'next-auth.session-token',
]

function normalizeCookieHeader(raw) {
  const trimmed = String(raw || '').trim()
  if (!trimmed) return ''
  if (/^__Secure-next-auth|^next-auth\.session-token/i.test(trimmed)) {
    return trimmed.includes('=') ? trimmed : ''
  }
  if (trimmed.includes('=')) return trimmed
  return `__Secure-next-auth.session-token=${trimmed}`
}

function cookiesFromSetCookie(headers) {
  const list = typeof headers.getSetCookie === 'function'
    ? headers.getSetCookie()
    : []
  const fallback = headers.get('set-cookie')
  if (!list.length && fallback) {
    for (const part of fallback.split(/,(?=[^;]+?=)/)) list.push(part.trim())
  }
  const pairs = []
  for (const line of list) {
    const name = line.split(';')[0]?.trim()
    if (!name) continue
    const [k] = name.split('=')
    if (PROD_COOKIE_NAMES.includes(k)) pairs.push(name)
  }
  return pairs.join('; ')
}

export async function resolveRegressionCookie(baseUrl) {
  const direct = normalizeCookieHeader(process.env.REGRESSION_COOKIE)
  if (direct) return { cookie: direct, source: 'REGRESSION_COOKIE' }

  const identifier = process.env.REGRESSION_IDENTIFIER || process.env.REGRESSION_EMAIL || ''
  const password = process.env.REGRESSION_PASSWORD || ''
  if (!identifier || !password) {
    return { cookie: '', source: 'none' }
  }

  const base = baseUrl.replace(/\/$/, '')
  const csrfRes = await fetch(`${base}/api/auth/csrf`, { cache: 'no-store' })
  if (!csrfRes.ok) {
    throw new Error(`CSRF fetch failed (${csrfRes.status})`)
  }
  const { csrfToken } = await csrfRes.json()
  if (!csrfToken) throw new Error('Missing csrfToken from /api/auth/csrf')

  const body = new URLSearchParams({
    csrfToken,
    callbackUrl: `${base}/`,
    json: 'true',
    identifier,
    email: identifier,
    password,
  })

  const loginRes = await fetch(`${base}/api/auth/callback/credentials`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
    redirect: 'manual',
    cache: 'no-store',
  })

  let cookie = cookiesFromSetCookie(loginRes.headers)
  if (!cookie && loginRes.status >= 300 && loginRes.status < 400) {
    const loc = loginRes.headers.get('location')
    if (loc) {
      const follow = await fetch(loc.startsWith('http') ? loc : `${base}${loc}`, {
        redirect: 'manual',
        cache: 'no-store',
      })
      cookie = cookiesFromSetCookie(follow.headers)
    }
  }

  if (!cookie) {
    throw new Error(
      `Credentials login did not return session cookie (HTTP ${loginRes.status}). Check REGRESSION_IDENTIFIER / REGRESSION_PASSWORD and SUPER_ADMIN role.`,
    )
  }

  return { cookie, source: 'credentials' }
}
