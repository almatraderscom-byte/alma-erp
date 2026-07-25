/**
 * The SIP provider's own registration table (amarip.net).
 *
 * WHY THIS EXISTS, and why it is worth a credential: the provider keeps exactly ONE
 * registration binding per SIP account and the last registrant owns it. Our own Asterisk
 * happily reports "Registered (exp. 3227s)" while their table does not list us at all — and
 * every outbound INVITE sent in that state goes out from an address that is not the current
 * binding and quietly dies. That misreading cost roughly half of all outbound calls for
 * days. Our side is not evidence. Their table is.
 *
 * WHAT IT DOES NOT DO: it never shows a password back, never logs one, and never sends the
 * credential anywhere except to the provider's own host. The owner types it himself.
 *
 * HONEST LIMIT: we do not have documentation for their panel, so the two URLs are settings
 * rather than constants, and when the response cannot be parsed the screen shows the first
 * part of what actually came back instead of an empty table. Guessing at someone else's
 * private API and hiding the failure would be the worse design.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'
import { prisma } from '@/lib/prisma'
import type { ProviderState } from '@/agent/lib/phone-settings-types'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = prisma as any

const CREDENTIAL_ID = 'amarip'

/** What we believe the panel exposes; both are editable on the screen if the guess is wrong. */
export const DEFAULT_LOGIN_URL = 'https://amarip.net/login'
export const DEFAULT_STATUS_URL = 'https://amarip.net/api/sip-registrations'

// ── encryption at rest ───────────────────────────────────────────────────────
// Same construction as the office-call device tokens: AES-256-GCM with a key derived from a
// server secret, so a database dump does not hand anyone the provider account.

export function providerEncryptionConfigured(): boolean {
  return Boolean(process.env.PHONE_PROVIDER_KEY?.trim() || process.env.NEXTAUTH_SECRET?.trim())
}

function encryptionKey(): Buffer {
  const source = process.env.PHONE_PROVIDER_KEY?.trim() || process.env.NEXTAUTH_SECRET?.trim()
  if (!source) throw new Error('phone_provider_key_unconfigured')
  return createHash('sha256').update(source).digest()
}

function encrypt(secret: string): string {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', encryptionKey(), iv)
  const body = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()])
  return `v1:${iv.toString('base64url')}:${cipher.getAuthTag().toString('base64url')}:${body.toString('base64url')}`
}

function decrypt(value: string): string {
  const [version, ivRaw, tagRaw, bodyRaw] = value.split(':')
  if (version !== 'v1' || !ivRaw || !tagRaw || !bodyRaw) throw new Error('invalid_provider_ciphertext')
  const iv = Buffer.from(ivRaw, 'base64url')
  const tag = Buffer.from(tagRaw, 'base64url')
  if (iv.length !== 12 || tag.length !== 16) throw new Error('invalid_provider_ciphertext')
  const decipher = createDecipheriv('aes-256-gcm', encryptionKey(), iv)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(Buffer.from(bodyRaw, 'base64url')), decipher.final()]).toString('utf8')
}

// ── storage ──────────────────────────────────────────────────────────────────

type CredentialRow = {
  username: string
  secretEnc: string
  loginUrl: string | null
  statusUrl: string | null
  lastCheckAt: Date | null
  lastCheckOk: boolean | null
  lastError: string | null
  updatedAt: Date
}

async function loadCredential(): Promise<CredentialRow | null> {
  try {
    return (await db.phoneProviderCredential.findUnique({ where: { id: CREDENTIAL_ID } })) as CredentialRow | null
  } catch {
    return null
  }
}

export async function saveProviderCredential(input: {
  username: string
  secret: string
  loginUrl?: string
  statusUrl?: string
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const username = input.username.trim()
  const secret = input.secret
  if (!username) return { ok: false, error: 'ইউজারনেম দিন।' }
  if (!secret) return { ok: false, error: 'পাসওয়ার্ড দিন।' }
  if (!providerEncryptionConfigured()) {
    return { ok: false, error: 'সার্ভারে এনক্রিপশন কী নেই — পাসওয়ার্ড নিরাপদে রাখা যাবে না, তাই সেভ করা হলো না।' }
  }

  const loginUrl = (input.loginUrl ?? '').trim() || DEFAULT_LOGIN_URL
  const statusUrl = (input.statusUrl ?? '').trim() || DEFAULT_STATUS_URL
  for (const [label, url] of [['লগইন', loginUrl], ['স্ট্যাটাস', statusUrl]] as const) {
    // The credential must only ever be posted to the provider. An http:// URL would put it
    // on the wire in clear text, and a non-provider host would simply be sending it away.
    if (!/^https:\/\//i.test(url)) return { ok: false, error: `${label} লিংক https:// দিয়ে শুরু হতে হবে।` }
  }

  try {
    const data = { username, secretEnc: encrypt(secret), loginUrl, statusUrl, lastCheckAt: null, lastCheckOk: null, lastError: null }
    await db.phoneProviderCredential.upsert({
      where: { id: CREDENTIAL_ID },
      create: { id: CREDENTIAL_ID, ...data },
      update: data,
    })
    return { ok: true }
  } catch (err) {
    return { ok: false, error: `সেভ করা যায়নি: ${err instanceof Error ? err.message : String(err)}` }
  }
}

export async function deleteProviderCredential(): Promise<void> {
  try {
    await db.phoneProviderCredential.delete({ where: { id: CREDENTIAL_ID } })
  } catch { /* already gone is the desired end state */ }
}

// ── fetching their table ─────────────────────────────────────────────────────

export type ProviderRegistration = ProviderState['registrations'][number]

/**
 * Pull whatever their panel will give us. Tries the status URL directly first (a session
 * cookie may not be needed), and on a 401/403 does a form login and retries once.
 *
 * Returns rows plus, when parsing fails, a `sample` of the response so the failure is
 * diagnosable from the screen rather than by guessing.
 */
async function fetchRegistrations(cred: CredentialRow): Promise<{
  rows: ProviderRegistration[]
  error: string | null
  sample: string | null
}> {
  const statusUrl = cred.statusUrl || DEFAULT_STATUS_URL
  const loginUrl = cred.loginUrl || DEFAULT_LOGIN_URL
  const ua = 'ALMA-ERP-PhoneConsole/1.0'

  const get = async (cookie: string) => fetch(statusUrl, {
    headers: { Accept: 'application/json, text/html', 'User-Agent': ua, ...(cookie ? { Cookie: cookie } : {}) },
    cache: 'no-store',
    redirect: 'follow',
    signal: AbortSignal.timeout(15_000),
  })

  try {
    let cookie = ''
    let res = await get('')

    if (res.status === 401 || res.status === 403 || res.status === 302) {
      const secret = decrypt(cred.secretEnc)
      const body = new URLSearchParams({ username: cred.username, password: secret, email: cred.username })
      const login = await fetch(loginUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': ua },
        body,
        redirect: 'manual',
        signal: AbortSignal.timeout(15_000),
      })
      cookie = (login.headers.getSetCookie?.() ?? [])
        .map((c) => c.split(';')[0])
        .join('; ')
      if (!cookie) {
        return { rows: [], error: 'লগইন হয়নি — ইউজারনেম/পাসওয়ার্ড অথবা লগইন লিংকটা মিলছে না।', sample: null }
      }
      res = await get(cookie)
    }

    const text = await res.text()
    if (!res.ok) return { rows: [], error: `প্রোভাইডারের সাইট ${res.status} ফেরত দিয়েছে।`, sample: text.slice(0, 400) }

    const rows = parseRegistrations(text)
    if (!rows.length) {
      return { rows: [], error: 'উত্তর এসেছে কিন্তু registration সারি পড়া যায়নি — লিংকটা ঠিক আছে কি না দেখুন।', sample: text.slice(0, 400) }
    }
    return { rows, error: null, sample: null }
  } catch (err) {
    return { rows: [], error: err instanceof Error ? err.message : String(err), sample: null }
  }
}

/**
 * Accepts either JSON or an HTML table, because we do not know which their panel serves.
 * Both shapes look for the same four things: the IP that holds the binding, the user agent
 * (ours is "Asterisk PBX 20.6.0"; the old middleman's was "NextGenSwitch v1.0.0" — that
 * string is how the whole outbound problem was finally identified), the seconds left, and a
 * timestamp.
 */
export function parseRegistrations(raw: string): ProviderRegistration[] {
  const text = raw.trim()

  if (text.startsWith('{') || text.startsWith('[')) {
    try {
      const parsed = JSON.parse(text) as unknown
      const list = Array.isArray(parsed)
        ? parsed
        : Array.isArray((parsed as { data?: unknown[] }).data)
          ? (parsed as { data: unknown[] }).data
          : Array.isArray((parsed as { registrations?: unknown[] }).registrations)
            ? (parsed as { registrations: unknown[] }).registrations
            : []
      return list.map((item) => {
        const r = (item ?? {}) as Record<string, unknown>
        const pick = (...names: string[]) => {
          for (const n of names) {
            const v = r[n]
            if (v != null && String(v).trim()) return String(v).trim()
          }
          return null
        }
        const exp = pick('expires', 'expiry', 'expiration', 'exp', 'seconds')
        return {
          ip: pick('ip', 'ipAddress', 'ip_address', 'contact', 'source'),
          userAgent: pick('userAgent', 'user_agent', 'ua', 'agent'),
          expiresIn: exp != null && /\d/.test(exp) ? Number(exp.replace(/\D/g, '')) : null,
          at: pick('time', 'at', 'updatedAt', 'updated_at', 'lastSeen', 'created_at'),
        }
      }).filter((r) => r.ip || r.userAgent)
    } catch {
      return []
    }
  }

  // HTML table fallback: one row per <tr>, cells matched by what they look like rather than
  // by column position, since we cannot rely on their column order staying put.
  const rows: ProviderRegistration[] = []
  for (const tr of text.match(/<tr[\s\S]*?<\/tr>/gi) ?? []) {
    const cells = (tr.match(/<t[dh][\s\S]*?<\/t[dh]>/gi) ?? [])
      .map((c) => c.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim())
      .filter(Boolean)
    if (!cells.length) continue
    const ip = cells.find((c) => /^\d{1,3}(\.\d{1,3}){3}(:\d+)?$/.test(c)) ?? null
    if (!ip) continue
    const userAgent = cells.find((c) => /asterisk|nextgenswitch|pjsip|linphone|zoiper/i.test(c)) ?? null
    const expCell = cells.find((c) => /^\d{1,5}$/.test(c) && Number(c) <= 7200)
    const at = cells.find((c) => /\d{1,2}:\d{2}/.test(c)) ?? null
    rows.push({ ip, userAgent, expiresIn: expCell ? Number(expCell) : null, at })
  }
  return rows
}

/** The screen's whole view of the provider: is a credential stored, and what does it say. */
export async function providerState(check: boolean): Promise<ProviderState & { sample?: string | null }> {
  const cred = await loadCredential()
  if (!cred) {
    return {
      stored: false,
      username: null,
      updatedAt: null,
      lastCheckAt: null,
      lastCheckOk: null,
      lastError: null,
      registrations: [],
    }
  }

  let registrations: ProviderRegistration[] = []
  let lastError = cred.lastError
  let lastCheckOk = cred.lastCheckOk
  let lastCheckAt = cred.lastCheckAt?.toISOString() ?? null
  let sample: string | null = null

  if (check) {
    const result = await fetchRegistrations(cred)
    registrations = result.rows
    lastError = result.error
    lastCheckOk = result.error == null
    lastCheckAt = new Date().toISOString()
    sample = result.sample
    try {
      await db.phoneProviderCredential.update({
        where: { id: CREDENTIAL_ID },
        data: { lastCheckAt: new Date(), lastCheckOk, lastError },
      })
    } catch { /* the reading is still worth showing even if we cannot remember it */ }
  }

  return {
    stored: true,
    username: cred.username,
    updatedAt: cred.updatedAt.toISOString(),
    lastCheckAt,
    lastCheckOk,
    lastError,
    registrations,
    sample,
  }
}

export async function providerUrls(): Promise<{ loginUrl: string; statusUrl: string }> {
  const cred = await loadCredential()
  return {
    loginUrl: cred?.loginUrl || DEFAULT_LOGIN_URL,
    statusUrl: cred?.statusUrl || DEFAULT_STATUS_URL,
  }
}
