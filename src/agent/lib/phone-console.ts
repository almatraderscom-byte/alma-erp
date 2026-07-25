/**
 * Phone console — read-only server helpers.
 *
 * We replaced a paid middleman PBX with our own Asterisk and gained everything it could not
 * do, then discovered we had lost the one thing it was good at: a screen. Registration, live
 * calls, call history, recordings and hangup causes all existed, but only behind SSH. This
 * module is the read side of closing that gap. It writes nothing, anywhere — not to the
 * database, not to the gateway, not to Asterisk. The write paths come in later steps,
 * deliberately separately, because this is a live business line.
 */
import { prisma } from '@/lib/prisma'
import { agentStorageSignedUrls } from '@/agent/lib/storage'
import { dhakaDayStart } from '@/agent/lib/proactive-call'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = prisma as any

// ── periods ──────────────────────────────────────────────────────────────────

export type Period = 'today' | '7d' | '30d' | '90d'
export const PERIODS: Array<{ value: Period; label: string; days: number }> = [
  { value: 'today', label: 'আজ', days: 1 },
  { value: '7d', label: '৭ দিন', days: 7 },
  { value: '30d', label: '৩০ দিন', days: 30 },
  { value: '90d', label: '৯০ দিন', days: 90 },
]

export function periodDays(p: string | null | undefined): number {
  return PERIODS.find((x) => x.value === p)?.days ?? 1
}

/** Start of the Dhaka day `days - 1` days ago — i.e. a window of whole local days. */
function windowStart(days: number): Date {
  return new Date(dhakaDayStart().getTime() - (Math.max(1, days) - 1) * 86_400_000)
}

/** The Dhaka calendar date (YYYY-MM-DD) a timestamp falls on. */
function dhakaYmd(d: Date): string {
  return new Date(d.getTime() + 6 * 3_600_000).toISOString().slice(0, 10)
}

// ── the line, as the gateway sees it ─────────────────────────────────────────

export interface GatewayLiveCall {
  id: string
  direction: string | null
  from: string | null
  to: string | null
  did: string | null
  name: string | null
  purpose: string | null
  startedAt: number | null
  answeredAt: number | null
  answered: boolean
  state: 'ringing' | 'talking' | 'hold' | 'transferring' | 'voicemail' | 'message'
  botReady: boolean
  transferredTo: string | null
  ringRound: number | null
  audio?: CallAudio
}

export interface CallAudio {
  underruns: number
  dropped: number
  cushionFrames: number
  framesOut: number
  silenceFrames: number
  bargeIns: number
}

export interface LineView {
  /** false when SIP_GATEWAY_BASE / AGENT_INTERNAL_TOKEN are not configured for this env. */
  configured: boolean
  reachable: boolean
  error: string | null
  /**
   * Whether the gateway carries the console endpoint yet. The ERP deploys before the VPS
   * does, so a fresh preview legitimately talks to an older gateway; we degrade to /health
   * (counts only, no per-call detail) instead of showing an error for a working line.
   */
  liveDetail: boolean
  registration: {
    registered: boolean | null
    status: string | null
    /** Seconds left on our binding. ~60 counting down is the healthy shape — see below. */
    expiresIn: number | null
    consecutiveFailures: number | null
    lastWatchdogCheck: number | null
  }
  softphone: { healthy: boolean | null; status: string | null; repairs: number | null }
  counts: { active: number; maxConcurrent: number | null }
  hourly: { placed: number; cap: number } | null
  active: GatewayLiveCall[]
}

function gatewayConfig(): { base: string; token: string } | null {
  const base = (process.env.SIP_GATEWAY_BASE ?? '').replace(/\/$/, '')
  const token = process.env.AGENT_INTERNAL_TOKEN ?? ''
  return base && token ? { base, token } : null
}

const EMPTY_LINE: LineView = {
  configured: false,
  reachable: false,
  error: null,
  liveDetail: false,
  registration: { registered: null, status: null, expiresIn: null, consecutiveFailures: null, lastWatchdogCheck: null },
  softphone: { healthy: null, status: null, repairs: null },
  counts: { active: 0, maxConcurrent: null },
  hourly: null,
  active: [],
}

/**
 * The line as OUR side sees it. Never presented as proof: the provider keeps exactly one
 * registration binding per SIP account and the last registrant owns it, and Asterisk has
 * reported "Registered (exp. 3227s)" while the provider's own table did not list us at all.
 * That misreading cost two sessions and roughly half of all outbound calls for days. Every
 * screen that shows this labels it "our side" and points at the provider's panel.
 */
export async function fetchLine(): Promise<LineView> {
  const gw = gatewayConfig()
  if (!gw) return EMPTY_LINE

  const headers = { Authorization: `Bearer ${gw.token}` }
  try {
    const res = await fetch(`${gw.base}/api/v1/active`, {
      headers,
      cache: 'no-store',
      signal: AbortSignal.timeout(12_000),
    })
    if (res.ok) {
      const d = (await res.json()) as {
        active?: GatewayLiveCall[]
        counts?: { active?: number; maxConcurrent?: number }
        hourly?: { placed?: number; cap?: number }
        registration?: {
          registered?: boolean; status?: string; expiresIn?: number | null
          consecutiveFailures?: number; lastWatchdogCheck?: number | null
        }
        softphone?: { healthy?: boolean; status?: string; repairs?: number }
      }
      return {
        configured: true,
        reachable: true,
        error: null,
        liveDetail: true,
        registration: {
          registered: d.registration?.registered ?? null,
          status: d.registration?.status ?? null,
          expiresIn: d.registration?.expiresIn ?? null,
          consecutiveFailures: d.registration?.consecutiveFailures ?? null,
          lastWatchdogCheck: d.registration?.lastWatchdogCheck ?? null,
        },
        softphone: {
          healthy: d.softphone?.healthy ?? null,
          status: d.softphone?.status ?? null,
          repairs: d.softphone?.repairs ?? null,
        },
        counts: { active: d.counts?.active ?? 0, maxConcurrent: d.counts?.maxConcurrent ?? null },
        hourly: d.hourly?.cap ? { placed: d.hourly.placed ?? 0, cap: d.hourly.cap } : null,
        active: Array.isArray(d.active) ? d.active : [],
      }
    }
    // 404 = an older gateway that predates this endpoint. Fall through to /health.
    if (res.status !== 404) {
      return { ...EMPTY_LINE, configured: true, error: `gateway HTTP ${res.status}` }
    }
  } catch (err) {
    return { ...EMPTY_LINE, configured: true, error: err instanceof Error ? err.message : String(err) }
  }

  try {
    const res = await fetch(`${gw.base}/health`, { cache: 'no-store', signal: AbortSignal.timeout(10_000) })
    const d = (await res.json()) as {
      active?: number
      maxConcurrent?: number
      registration?: { registered?: boolean; status?: string; failures?: number }
      softphone?: { healthy?: boolean; status?: string; repairs?: number }
    }
    return {
      configured: true,
      reachable: res.ok,
      error: res.ok ? null : `gateway HTTP ${res.status}`,
      liveDetail: false,
      registration: {
        registered: d.registration?.registered ?? null,
        status: d.registration?.status ?? null,
        expiresIn: null,
        consecutiveFailures: d.registration?.failures ?? null,
        lastWatchdogCheck: null,
      },
      softphone: {
        healthy: d.softphone?.healthy ?? null,
        status: d.softphone?.status ?? null,
        repairs: d.softphone?.repairs ?? null,
      },
      counts: { active: d.active ?? 0, maxConcurrent: d.maxConcurrent ?? null },
      hourly: null,
      active: [],
    }
  } catch (err) {
    return { ...EMPTY_LINE, configured: true, error: err instanceof Error ? err.message : String(err) }
  }
}

// ── vocabulary ───────────────────────────────────────────────────────────────

/** Statuses that mean the far end never had a conversation with us. */
const UNREACHED = new Set(['no_answer', 'busy', 'failed'])

export const STATUS_LABEL_BN: Record<string, string> = {
  completed: 'সম্পন্ন',
  answered: 'ধরা হয়েছে',
  no_answer: 'কেউ ধরেনি',
  busy: 'ব্যস্ত',
  failed: 'ব্যর্থ',
  blocked: 'আটকানো',
  report_missing: 'রিপোর্ট আসেনি',
  initiated: 'শুরু হয়েছে',
  ringing: 'রিং হচ্ছে',
  voicemail: 'ভয়েসমেইল',
}

/**
 * ISDN (Q.850) hangup causes in plain Bangla. This is the column that answers "why did that
 * call fail", which until now could only be answered by reading the VPS log — and the
 * outbound investigation turned entirely on telling `no_route` apart from `user busy`.
 */
export const HANGUP_CAUSE_BN: Record<number, string> = {
  1: 'নম্বরটি নেই',
  16: 'স্বাভাবিকভাবে শেষ',
  17: 'নম্বর ব্যস্ত',
  18: 'কেউ সাড়া দেয়নি',
  19: 'রিং হয়েছে, কেউ ধরেনি',
  20: 'গ্রাহকের ফোন বন্ধ',
  21: 'কল বাতিল করা হয়েছে',
  27: 'গন্তব্য অচল',
  28: 'নম্বরের গঠন ভুল',
  31: 'অনির্দিষ্ট কারণে শেষ',
  34: 'নেটওয়ার্কে লাইন খালি ছিল না',
  38: 'নেটওয়ার্ক অচল',
  41: 'সাময়িক গোলযোগ',
  42: 'নেটওয়ার্কে ভিড়',
  47: 'রিসোর্স পাওয়া যায়নি',
  50: 'এই সেবা প্যাকেজে নেই',
  57: 'এই ধরনের কলের অনুমতি নেই',
  58: 'এই ধরনের কল এখন সম্ভব নয়',
  63: 'সেবা পাওয়া যায়নি',
  65: 'কোডেক সমর্থিত নয়',
  88: 'বেমানান গন্তব্য',
  102: 'সময় শেষ হয়ে গেছে',
  111: 'প্রোটোকল ত্রুটি',
  127: 'অন্য নেটওয়ার্কের কারণে শেষ',
}

// ── the call log ─────────────────────────────────────────────────────────────

export interface CallRow {
  id: string
  direction: 'inbound' | 'outbound' | 'unknown'
  /** The far end: the caller on an inbound call, the dialled number on an outbound one. */
  number: string
  name: string | null
  did: string | null
  purpose: string | null
  status: string
  statusLabel: string
  reached: boolean
  startedAt: string | null
  answeredAt: string | null
  endedAt: string | null
  durationSecs: number | null
  hangupCause: number | null
  hangupCauseLabel: string | null
  hangupCauseTxt: string | null
  transferredTo: string | null
  transferTalkSecs: number | null
  recordingUrl: string | null
  recordingSecs: number | null
  summary: string | null
  transcript: Array<{ role: string; message: string }> | null
  audio: CallAudio | null
}

export interface CallLogFilters {
  /** Dhaka calendar days to look back over. 1 = today only. */
  days?: number
  direction?: 'inbound' | 'outbound' | 'all'
  status?: 'all' | 'answered' | 'unreached' | 'recorded'
  /** Digits; matched on the last 9+ so 01…, 880… and +880… all find the same person. */
  number?: string
  page?: number
  perPage?: number
}

/**
 * Direction for rows written before the `direction` column existed. Old rows keep the guess
 * the system used to make (`purpose`), and the UI shows "—" rather than a confident wrong
 * arrow when even that is missing.
 */
function directionOf(row: { direction?: string | null; purpose?: string | null }): CallRow['direction'] {
  const d = (row.direction ?? '').toLowerCase()
  if (d === 'inbound' || d === 'outbound') return d
  if (row.purpose === 'inbound_call') return 'inbound'
  if (row.purpose) return 'outbound'
  return 'unknown'
}

/** `…/object/sign/agent-files/calls/recordings/x.wav?token=…` → `calls/recordings/x.wav`. */
function recordingObjectPath(url: string | null): string | null {
  if (!url) return null
  const m = url.match(/\/object\/(?:sign|public)\/agent-files\/([^?]+)/)
  return m ? decodeURIComponent(m[1]) : null
}

function toTranscript(raw: unknown): CallRow['transcript'] {
  if (!Array.isArray(raw)) return null
  const turns = raw
    .map((t) => {
      const o = (t ?? {}) as { role?: unknown; message?: unknown; text?: unknown }
      const message = String(o.message ?? o.text ?? '').trim()
      if (!message) return null
      return { role: String(o.role ?? 'agent'), message }
    })
    .filter((t): t is { role: string; message: string } => t !== null)
  return turns.length ? turns : null
}

function audioOf(row: {
  audioUnderruns?: number | null; audioDropped?: number | null; audioCushionFrames?: number | null
  audioFramesOut?: number | null; audioSilenceFrames?: number | null; audioBargeIns?: number | null
}): CallAudio | null {
  if (row.audioFramesOut == null && row.audioUnderruns == null) return null
  return {
    underruns: row.audioUnderruns ?? 0,
    dropped: row.audioDropped ?? 0,
    cushionFrames: row.audioCushionFrames ?? 0,
    framesOut: row.audioFramesOut ?? 0,
    silenceFrames: row.audioSilenceFrames ?? 0,
    bargeIns: row.audioBargeIns ?? 0,
  }
}

const CALL_SELECT = {
  id: true, toNumber: true, fromNumber: true, did: true, recipientName: true, purpose: true,
  direction: true, status: true, providerStatus: true, durationSecs: true,
  dialedAt: true, answeredAt: true, endedAt: true, createdAt: true,
  hangupCause: true, hangupCauseTxt: true, transferredTo: true, transferTalkSecs: true,
  recordingUrl: true, recordingSecs: true, summary: true, transcript: true,
  audioUnderruns: true, audioDropped: true, audioCushionFrames: true,
  audioFramesOut: true, audioSilenceFrames: true, audioBargeIns: true,
} as const

/**
 * Every filter is an entry in ONE `AND` list. Assigning `where.OR` per filter instead would
 * silently OR unrelated filters together — "inbound calls from this number" would quietly
 * become "inbound calls, or any call from this number".
 */
function callWhere(f: CallLogFilters) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const and: any[] = [{ createdAt: { gte: windowStart(f.days ?? 7) } }]
  // Rows written before the `direction` column fall back to the old `purpose` guess, so a
  // filter still finds the history rather than only calls made since this shipped.
  if (f.direction === 'inbound') {
    and.push({ OR: [{ direction: 'inbound' }, { AND: [{ direction: null }, { purpose: 'inbound_call' }] }] })
  }
  if (f.direction === 'outbound') {
    and.push({ OR: [{ direction: 'outbound' }, { AND: [{ direction: null }, { purpose: { not: 'inbound_call' } }] }] })
  }
  if (f.status === 'answered') and.push({ answeredAt: { not: null } })
  if (f.status === 'unreached') and.push({ status: { in: [...UNREACHED] } })
  if (f.status === 'recorded') and.push({ recordingUrl: { not: null } })
  const tail = (f.number ?? '').replace(/\D/g, '').slice(-10)
  if (tail.length >= 6) {
    and.push({ OR: [{ toNumber: { endsWith: tail } }, { fromNumber: { endsWith: tail } }] })
  }
  return { AND: and }
}

export interface CallPage {
  calls: CallRow[]
  total: number
  page: number
  perPage: number
}

export async function listCalls(f: CallLogFilters = {}): Promise<CallPage> {
  const perPage = Math.min(Math.max(Math.round(f.perPage ?? 25), 5), 200)
  const page = Math.max(Math.round(f.page ?? 1), 1)
  const where = callWhere({ ...f, days: Math.min(Math.max(Math.round(f.days ?? 7), 1), 365) })

  const [total, rows] = await Promise.all([
    db.agentVoiceCall.count({ where }),
    db.agentVoiceCall.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * perPage,
      take: perPage,
      select: CALL_SELECT,
    }),
  ])

  // Recording links are signed and expire; the stored one can already be dead on an older
  // call, which would give the owner a player that silently fails. Re-sign every one from
  // its object path in a single batch request instead.
  const paths = rows
    .map((r: { recordingUrl: string | null }) => recordingObjectPath(r.recordingUrl))
    .filter((p: string | null): p is string => Boolean(p))
  const signed: Record<string, string> = paths.length
    ? await agentStorageSignedUrls(paths, 3600).catch(() => ({}))
    : {}

  return {
    total,
    page,
    perPage,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    calls: rows.map((r: any): CallRow => {
      const direction = directionOf(r)
      const path = recordingObjectPath(r.recordingUrl)
      const status = String(r.status ?? 'initiated')
      return {
        id: r.id,
        direction,
        number: (direction === 'inbound' ? r.fromNumber || r.toNumber : r.toNumber) ?? '—',
        name: r.recipientName ?? null,
        did: r.did ?? null,
        purpose: r.purpose ?? null,
        status,
        statusLabel: STATUS_LABEL_BN[status] ?? status,
        reached: Boolean(r.answeredAt) && !UNREACHED.has(status),
        startedAt: (r.dialedAt ?? r.createdAt)?.toISOString() ?? null,
        answeredAt: r.answeredAt?.toISOString() ?? null,
        endedAt: r.endedAt?.toISOString() ?? null,
        durationSecs: r.durationSecs ?? null,
        hangupCause: r.hangupCause ?? null,
        hangupCauseLabel: r.hangupCause != null ? HANGUP_CAUSE_BN[r.hangupCause] ?? null : null,
        hangupCauseTxt: r.hangupCauseTxt ?? null,
        transferredTo: r.transferredTo ?? null,
        transferTalkSecs: r.transferTalkSecs ?? null,
        recordingUrl: (path && signed[path]) || r.recordingUrl || null,
        recordingSecs: r.recordingSecs ?? null,
        summary: r.summary ?? null,
        transcript: toTranscript(r.transcript),
        audio: audioOf(r),
      }
    }),
  }
}

// ── the numbers ──────────────────────────────────────────────────────────────

export interface Tally {
  /** First Dhaka calendar day covered, as YYYY-MM-DD. */
  from: string
  to: string
  days: number
  total: number
  inbound: number
  outbound: number
  answered: number
  unreached: number
  voicemail: number
  recorded: number
  talkSecs: number
  avgTalkSecs: number
  successPct: number
  /** Calls whose audio dipped — a count to watch instead of listening to every call. */
  withUnderruns: number
  /** Per-direction split, the shape the old PBX's trunk report had. */
  split: {
    inbound: { total: number; answered: number; unreached: number; talkSecs: number }
    outbound: { total: number; answered: number; unreached: number; talkSecs: number }
  }
}

export interface TrendDay {
  date: string
  total: number
  answered: number
  unreached: number
  talkSecs: number
}

const TALLY_SELECT = {
  direction: true, purpose: true, status: true, answeredAt: true, createdAt: true,
  durationSecs: true, recordingUrl: true, audioUnderruns: true,
} as const

export async function tally(days: number): Promise<{ tally: Tally; trend: TrendDay[] }> {
  const d = Math.min(Math.max(Math.round(days), 1), 365)
  const start = windowStart(d)
  const rows = await db.agentVoiceCall.findMany({
    where: { createdAt: { gte: start } },
    select: TALLY_SELECT,
  })

  const t: Tally = {
    from: dhakaYmd(start),
    to: dhakaYmd(dhakaDayStart()),
    days: d,
    total: rows.length,
    inbound: 0, outbound: 0, answered: 0, unreached: 0, voicemail: 0, recorded: 0,
    talkSecs: 0, avgTalkSecs: 0, successPct: 0, withUnderruns: 0,
    split: {
      inbound: { total: 0, answered: 0, unreached: 0, talkSecs: 0 },
      outbound: { total: 0, answered: 0, unreached: 0, talkSecs: 0 },
    },
  }
  const byDay = new Map<string, TrendDay>()
  for (let i = 0; i < d; i++) {
    const date = dhakaYmd(new Date(start.getTime() + i * 86_400_000))
    byDay.set(date, { date, total: 0, answered: 0, unreached: 0, talkSecs: 0 })
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  for (const r of rows as any[]) {
    const dir = directionOf(r)
    const answered = Boolean(r.answeredAt)
    const unreached = UNREACHED.has(String(r.status))
    const secs = typeof r.durationSecs === 'number' ? r.durationSecs : 0

    if (dir === 'inbound') t.inbound++
    else if (dir === 'outbound') t.outbound++
    if (answered) t.answered++
    if (unreached) t.unreached++
    if (r.purpose === 'voicemail' || r.status === 'voicemail') t.voicemail++
    if (r.recordingUrl) t.recorded++
    t.talkSecs += secs
    if ((r.audioUnderruns ?? 0) > 0) t.withUnderruns++

    if (dir === 'inbound' || dir === 'outbound') {
      const s = t.split[dir]
      s.total++
      if (answered) s.answered++
      if (unreached) s.unreached++
      s.talkSecs += secs
    }

    const day = byDay.get(dhakaYmd(r.createdAt))
    if (day) {
      day.total++
      if (answered) day.answered++
      if (unreached) day.unreached++
      day.talkSecs += secs
    }
  }

  t.avgTalkSecs = t.answered > 0 ? Math.round(t.talkSecs / t.answered) : 0
  t.successPct = t.total > 0 ? Math.round((t.answered / t.total) * 1000) / 10 : 0
  return { tally: t, trend: [...byDay.values()] }
}

// ── audio quality ────────────────────────────────────────────────────────────

export interface QualityDay {
  date: string
  measured: number
  withUnderruns: number
  underruns: number
  dropped: number
  avgCushionFrames: number
}

export interface QualityWorst {
  id: string
  number: string
  startedAt: string | null
  durationSecs: number | null
  underruns: number
  dropped: number
  cushionFrames: number
}

/**
 * Audio quality as a graph rather than as the owner's ear. An underrun is the playout queue
 * running dry mid-sentence — roughly 200 ms of dead air dropped into the middle of a word,
 * which is exactly what "কথার মাঝখানে কেটে যাচ্ছে" describes. Only calls the gateway measured
 * are counted, so the numbers are not diluted by history from before it reported them.
 */
export async function qualityReport(days: number): Promise<{ daily: QualityDay[]; worst: QualityWorst[] }> {
  const d = Math.min(Math.max(Math.round(days), 1), 365)
  const start = windowStart(d)
  const rows = await db.agentVoiceCall.findMany({
    where: { createdAt: { gte: start }, audioFramesOut: { not: null } },
    orderBy: { createdAt: 'desc' },
    select: {
      id: true, toNumber: true, fromNumber: true, direction: true, purpose: true,
      createdAt: true, dialedAt: true, durationSecs: true,
      audioUnderruns: true, audioDropped: true, audioCushionFrames: true,
    },
  })

  const byDay = new Map<string, QualityDay & { cushionSum: number }>()
  for (let i = 0; i < d; i++) {
    const date = dhakaYmd(new Date(start.getTime() + i * 86_400_000))
    byDay.set(date, { date, measured: 0, withUnderruns: 0, underruns: 0, dropped: 0, avgCushionFrames: 0, cushionSum: 0 })
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  for (const r of rows as any[]) {
    const day = byDay.get(dhakaYmd(r.createdAt))
    if (!day) continue
    day.measured++
    day.underruns += r.audioUnderruns ?? 0
    day.dropped += r.audioDropped ?? 0
    day.cushionSum += r.audioCushionFrames ?? 0
    if ((r.audioUnderruns ?? 0) > 0) day.withUnderruns++
  }
  const daily: QualityDay[] = [...byDay.values()].map((x) => ({
    date: x.date,
    measured: x.measured,
    withUnderruns: x.withUnderruns,
    underruns: x.underruns,
    dropped: x.dropped,
    avgCushionFrames: x.measured ? Math.round(x.cushionSum / x.measured) : 0,
  }))

  const worst: QualityWorst[] = [...rows]
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .sort((a: any, b: any) => (b.audioUnderruns ?? 0) - (a.audioUnderruns ?? 0) || (b.audioDropped ?? 0) - (a.audioDropped ?? 0))
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .filter((r: any) => (r.audioUnderruns ?? 0) > 0 || (r.audioDropped ?? 0) > 0)
    .slice(0, 10)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .map((r: any) => ({
      id: r.id,
      number: (directionOf(r) === 'inbound' ? r.fromNumber || r.toNumber : r.toNumber) ?? '—',
      startedAt: (r.dialedAt ?? r.createdAt)?.toISOString() ?? null,
      durationSecs: r.durationSecs ?? null,
      underruns: r.audioUnderruns ?? 0,
      dropped: r.audioDropped ?? 0,
      cushionFrames: r.audioCushionFrames ?? 0,
    }))

  return { daily, worst }
}
