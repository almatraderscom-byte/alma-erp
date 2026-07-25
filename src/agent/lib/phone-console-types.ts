/**
 * Phone console — the shapes and labels BOTH sides share.
 *
 * Kept apart from `phone-console.ts` on purpose. That module talks to Prisma and to the
 * gateway, and Prisma pulls in the job queue, which pulls in `child_process`; one value
 * import of a constant from a client component was enough to drag all of it into the browser
 * bundle and fail the build. Types erase at compile time, but constants do not — so anything
 * a client component needs at RUNTIME lives here, where there is nothing to drag along.
 */

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

// ── vocabulary ───────────────────────────────────────────────────────────────

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

// ── the line ─────────────────────────────────────────────────────────────────

export interface CallAudio {
  underruns: number
  dropped: number
  cushionFrames: number
  framesOut: number
  silenceFrames: number
  bargeIns: number
  turnEnds: number
}

/**
 * What the network did to a call, from Asterisk's own RTP counters. Kept apart from
 * `CallAudio` because they answer different questions: `CallAudio` is how well WE fed the
 * line, this is what happened to the audio once it left. A recording is tapped inside our
 * server, so it can never contain this half — which is why a call can sound broken while its
 * recording sounds clean.
 */
export interface CallNetwork {
  codec: string | null
  rxLost: number | null
  rxLostPct: number | null
  rxJitterMs: number | null
  txLost: number | null
  txLostPct: number | null
  txJitterMs: number | null
  rttMs: number | null
}

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
    /** Seconds left on our binding. ~60 counting down is the healthy shape. */
    expiresIn: number | null
    consecutiveFailures: number | null
    lastWatchdogCheck: number | null
  }
  softphone: { healthy: boolean | null; status: string | null; repairs: number | null }
  counts: { active: number; maxConcurrent: number | null }
  hourly: { placed: number; cap: number } | null
  active: GatewayLiveCall[]
}

// ── calls ────────────────────────────────────────────────────────────────────

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
  network: CallNetwork | null
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

export interface CallPage {
  calls: CallRow[]
  total: number
  page: number
  perPage: number
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

export interface QualityDay {
  date: string
  measured: number
  withUnderruns: number
  underruns: number
  dropped: number
  avgCushionFrames: number
  /** Calls whose network numbers we have, and the average loss/jitter across them. */
  measuredNetwork: number
  avgRxLostPct: number
  avgRxJitterMs: number
  worstRxLostPct: number
}

export interface QualityWorst {
  id: string
  number: string
  startedAt: string | null
  durationSecs: number | null
  underruns: number
  dropped: number
  cushionFrames: number
  rxLostPct: number | null
  rxJitterMs: number | null
}
