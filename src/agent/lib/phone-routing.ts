/**
 * Phone console step 4 — inbound routing, and the time rules that drive it.
 *
 * `decideInbound()` is the whole point of this file: **the live inbound route and the
 * routing preview call it with the same arguments.** Routing bugs are invisible until a
 * customer hits one, so a preview that re-derived the rules would be the most dangerous
 * screen in the console — right up to the day the two drifted apart.
 *
 * The DID map moves out of the `SIP_DID_MAP` env JSON and into KV, edited as a table. The
 * env is still the fallback and still parsed in the same shape, so nothing changes until the
 * owner saves something.
 *
 * NOTE ON THE DIALPLAN: nothing here touches Asterisk. `from-alma` already forwards the
 * dialled DID to the gateway, which passes it to the inbound route — so per-DID routing is
 * decided entirely in this application. That is why step 4's inbound half needs no VPS
 * change at all, which is the safest possible shape for it.
 *
 * SERVER ONLY (Prisma). Shapes for the browser live in `phone-routing-types.ts`.
 */
import { prisma } from '@/lib/prisma'
import { readSettingMap } from '@/agent/lib/phone-settings'
import {
  WEEKDAYS,
  type DidRoute,
  type InboundDecision,
  type TimeVerdict,
} from '@/agent/lib/phone-routing-types'

export * from '@/agent/lib/phone-routing-types'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = prisma as any

/** KV key holding the DID table as JSON. */
export const DID_MAP_KEY = 'phone_did_map'

/** Our own line. Used as the default row and as the loopback target in tests. */
export const OUR_DID = '09649777738'

// ── the DID table ────────────────────────────────────────────────────────────

/** Last nine digits — the same comparison used everywhere else a number is matched. */
function tail(n: string): string {
  return String(n ?? '').replace(/\D/g, '').slice(-9)
}

function normaliseRoute(did: string, raw: Record<string, unknown>): DidRoute {
  const line = raw.line === 'support' ? 'support' : 'boss'
  return {
    did,
    label: typeof raw.label === 'string' ? raw.label : '',
    line,
    forwardSupport: typeof raw.forwardSupport === 'string' ? raw.forwardSupport : undefined,
    forwardBoss: typeof raw.forwardBoss === 'string' ? raw.forwardBoss : undefined,
    forward: typeof raw.forward === 'string' ? raw.forward : undefined,
    allowTransfer: raw.allowTransfer !== false,
  }
}

/**
 * The DID table, from KV, falling back to the `SIP_DID_MAP` env in its original shape.
 * Never throws — an inbound call must not fail because a routing table would not parse.
 */
export async function readDidRoutes(): Promise<DidRoute[]> {
  let source: Record<string, Record<string, unknown>> = {}

  try {
    const row = await db.agentKvSetting.findUnique({ where: { key: DID_MAP_KEY } })
    if (typeof row?.value === 'string' && row.value.trim()) source = JSON.parse(row.value)
  } catch { /* fall through to the env */ }

  if (!Object.keys(source).length) {
    try {
      source = JSON.parse(process.env.SIP_DID_MAP ?? '{}')
    } catch { source = {} }
  }

  return Object.entries(source)
    .filter(([did]) => did && /\d/.test(did))
    .map(([did, cfg]) => normaliseRoute(did, cfg ?? {}))
}

export async function writeDidRoutes(routes: DidRoute[]): Promise<void> {
  const out: Record<string, Omit<DidRoute, 'did'>> = {}
  for (const r of routes) {
    const did = String(r.did ?? '').replace(/[^\d+]/g, '')
    if (!did) continue
    out[did] = {
      label: r.label ?? '',
      line: r.line === 'support' ? 'support' : 'boss',
      ...(r.forwardSupport ? { forwardSupport: r.forwardSupport } : {}),
      ...(r.forwardBoss ? { forwardBoss: r.forwardBoss } : {}),
      ...(r.forward ? { forward: r.forward } : {}),
      allowTransfer: r.allowTransfer !== false,
    }
  }
  const value = JSON.stringify(out)
  await db.agentKvSetting.upsert({
    where: { key: DID_MAP_KEY },
    create: { key: DID_MAP_KEY, value },
    update: { value },
  })
}

/** The row for a dialled DID: exact first, then on the last nine digits. */
export function routeForDid(routes: DidRoute[], did: string): DidRoute | null {
  if (!did) return null
  return routes.find((r) => r.did === did)
    ?? routes.find((r) => tail(r.did) === tail(did))
    ?? null
}

/**
 * DIDs we have actually received calls on. The owner should not have to remember his own
 * numbers to configure them, and a typo in a DID is silent — the row simply never matches.
 */
export async function seenDids(): Promise<Array<{ did: string; calls: number; lastAt: string | null }>> {
  try {
    const rows = (await db.agentVoiceCall.groupBy({
      by: ['did'],
      where: { did: { not: null } },
      _count: { did: true },
      _max: { createdAt: true },
    })) as Array<{ did: string | null; _count: { did: number }; _max: { createdAt: Date | null } }>
    return rows
      .filter((r) => r.did)
      .map((r) => ({ did: r.did!, calls: r._count.did, lastAt: r._max.createdAt?.toISOString() ?? null }))
      .sort((a, b) => b.calls - a.calls)
  } catch {
    return []
  }
}

// ── time conditions ──────────────────────────────────────────────────────────

/**
 * Dhaka wall clock from a UTC instant, without a timezone library.
 *
 * Bangladesh is UTC+6 with no daylight saving, so this is exact arithmetic rather than an
 * approximation — the same reason the quiet-hours code does it this way. Fewer moving parts
 * on a path an inbound caller is waiting on.
 */
export function dhakaParts(at: Date): { ymd: string; hour: number; minute: number; weekday: string } {
  const shifted = new Date(at.getTime() + 6 * 3_600_000)
  return {
    ymd: shifted.toISOString().slice(0, 10),
    hour: shifted.getUTCHours(),
    minute: shifted.getUTCMinutes(),
    weekday: WEEKDAYS.find((d) => d.index === shifted.getUTCDay())!.value,
  }
}

function windowOpen(window: string, hour: number): boolean {
  const [fromRaw, toRaw] = window.split('-').map(Number)
  const from = Number.isFinite(fromRaw) ? fromRaw : 10
  const to = Number.isFinite(toRaw) ? toRaw : 21
  // A window that wraps midnight (22-6) is legal and handled.
  return from <= to ? hour >= from && hour < to : hour >= from || hour < to
}

/** Parses "2027-02-18..2027-03-19=10-16" lines and returns the one covering `ymd`. */
function specialWindowFor(raw: string, ymd: string): string | null {
  for (const line of raw.split(/[\n,]/).map((x) => x.trim()).filter(Boolean)) {
    const m = line.match(/^(\d{4}-\d{2}-\d{2})\.\.(\d{4}-\d{2}-\d{2})=(\d{1,2}-\d{1,2})$/)
    if (m && ymd >= m[1] && ymd <= m[2]) return m[3]
  }
  return null
}

/**
 * Is the shop open at this instant, and WHICH rule decided?
 *
 * The rules are checked in the order a person would state them: a declared holiday beats a
 * weekly off-day beats a special (Ramadan) window beats the ordinary hours. The reason
 * travels with the verdict because "closed" alone is not a debuggable answer, and because
 * the AI's after-hours line reads better when it can say WHY.
 */
export function decideTime(settings: Record<string, string>, at: Date): TimeVerdict {
  const { ymd, hour, weekday } = dhakaParts(at)

  const holidays = (settings.phone_holidays ?? '').split(',').map((d) => d.trim()).filter(Boolean)
  if (holidays.includes(ymd)) {
    return { open: false, window: null, reason: 'আজ ছুটির দিন হিসেবে সেট করা আছে', rule: 'holiday' }
  }

  const offDays = (settings.phone_weekly_offdays ?? '').split(',').map((d) => d.trim().toLowerCase()).filter(Boolean)
  if (offDays.includes(weekday)) {
    const label = WEEKDAYS.find((d) => d.value === weekday)?.label ?? weekday
    return { open: false, window: null, reason: `${label}বার সাপ্তাহিক বন্ধ`, rule: 'weekly_offday' }
  }

  const special = specialWindowFor(settings.phone_special_hours ?? '', ymd)
  if (special) {
    return {
      open: windowOpen(special, hour),
      window: special,
      reason: `বিশেষ সময় চলছে (${special} টা)`,
      rule: 'special_hours',
    }
  }

  const raw = settings.office_hours_dhaka?.trim() || process.env.SIP_OFFICE_HOURS?.trim()
  const window = raw && /^\d{1,2}-\d{1,2}$/.test(raw) ? raw : '10-21'
  return {
    open: windowOpen(window, hour),
    window,
    reason: `সাধারণ অফিস সময় ${window} টা`,
    rule: 'office_hours',
  }
}

// ── the decision itself ──────────────────────────────────────────────────────

/** Every setting the inbound path reads, fetched once. */
export const INBOUND_SETTING_KEYS = [
  'office_hours_dhaka',
  'phone_holidays',
  'phone_weekly_offdays',
  'phone_special_hours',
  'blocked_callers',
  'inbound_transfer_mode',
  'phone_forward_support',
  'phone_forward_boss',
]

export async function readInboundSettings(): Promise<Record<string, string>> {
  return readSettingMap(INBOUND_SETTING_KEYS).catch(() => ({}) as Record<string, string>)
}

function isBlocked(caller: string, list: string): boolean {
  const target = tail(caller)
  if (!target) return false
  return list.split(',').map(tail).filter(Boolean).includes(target)
}

/**
 * What happens to this call. Used by the live inbound route AND by the preview screen.
 *
 * `owner` short-circuits nearly everything on purpose: the boss is never blocked, never gets
 * the receptionist, and is always allowed through to a human — he is calling his own
 * assistant, and the whole reason for self-hosting was that the caller-ID finally makes this
 * possible.
 */
export function decideInbound(input: {
  caller: string
  did: string
  at: Date
  owner: boolean
  settings: Record<string, string>
  routes: DidRoute[]
}): InboundDecision {
  const { caller, did, at, owner, settings, routes } = input
  const route = routeForDid(routes, did)
  const time = decideTime(settings, at)

  const blocked = !owner && isBlocked(caller, settings.blocked_callers ?? '')

  const forwardSupport = route?.forwardSupport || settings.phone_forward_support || ''
  const forwardBoss = route?.forwardBoss || settings.phone_forward_boss || process.env.NGS_FORWARD_NUMBER || ''

  let transferMode: 'direct' | 'ask_first' =
    settings.inbound_transfer_mode === 'ask_first' ? 'ask_first' : 'direct'
  // Outside office hours nobody is at the support line, so a blind transfer would ring an
  // empty desk and drop the customer. The owner is always allowed through.
  if (!time.open && !owner) transferMode = 'ask_first'
  // A line the owner has marked as no-transfer never connects a human, at any hour.
  if (route && route.allowTransfer === false && !owner) transferMode = 'ask_first'

  const lineName = route?.label ? `${route.label} লাইন` : route ? (route.line === 'support' ? 'সাপোর্ট লাইন' : 'বস লাইন') : 'ডিফল্ট'

  let outcome: string
  if (blocked) {
    outcome = 'কলটা ধরাই হবে না — নম্বরটা ব্লকলিস্টে আছে, তাই কোনো খরচও হবে না।'
  } else if (owner) {
    outcome = 'AI ধরবে এবং আপনাকে চিনে পূর্ণ সহকারী মোডে কথা বলবে — অফিস সময় বা ছুটি এখানে কিছু আটকায় না।'
  } else if (!time.open) {
    outcome = `AI ধরবে (${lineName})। এখন অফিস বন্ধ — ${time.reason} — সেটা ভদ্রভাবে জানিয়ে নাম, নম্বর ও প্রয়োজন লিখে নেবে। কাউকে ফোন যুক্ত করবে না।`
  } else if (transferMode === 'ask_first') {
    outcome = `AI ধরবে (${lineName})। মানুষ চাইলে যুক্ত না করে বার্তা নেবে আর সাথে সাথে আপনাকে পুশ পাঠাবে।`
  } else if (forwardSupport || forwardBoss) {
    const target = forwardSupport || forwardBoss
    outcome = `AI ধরবে (${lineName})। মানুষ চাইলে ${target}-এ রিং যাবে; কেউ না ধরলে কলদাতা AI-এর কাছেই ফিরে আসবে।`
  } else {
    outcome = `AI ধরবে (${lineName})। কোনো ফরওয়ার্ড নম্বর সেট নেই, তাই যুক্ত করার বদলে বার্তা নেবে।`
  }

  return { did, route, owner, blocked, time, transferMode, forwardSupport, forwardBoss, outcome }
}
