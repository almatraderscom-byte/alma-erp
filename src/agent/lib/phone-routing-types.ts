/**
 * Phone console step 4 — routing, shared by the server and the browser.
 *
 * The single most important thing in this file is `decideInbound()` in the server module
 * next to it: **the routing preview and the live call run the same function.** A preview
 * that re-implements the rules is a second set of rules, and the moment they disagree the
 * screen is lying — which is exactly the failure this phase exists to prevent, because a
 * routing bug is invisible until a customer hits it.
 *
 * Client-safe: no Prisma, no `node:` imports.
 */

// ── inbound: which line answers, and how ─────────────────────────────────────

export type LineKind = 'boss' | 'support'

/** One DID (incoming number) and what it should do. Stored as JSON in KV `phone_did_map`. */
export type DidRoute = {
  did: string
  /** What the owner calls this line, e.g. "সাপোর্ট". Shown on the call log and the console. */
  label: string
  line: LineKind
  /** Optional per-line overrides; empty means "use the global setting". */
  forwardSupport?: string
  forwardBoss?: string
  /** Legacy single-target field from the original SIP_DID_MAP; the bot still honours it. */
  forward?: string
  /** Off means the AI answers but never offers to connect a human on this line. */
  allowTransfer?: boolean
}

export type TimeVerdict = {
  open: boolean
  /** The window that applied, e.g. "10-21" — or null when a rule closed the whole day. */
  window: string | null
  /** Which rule decided it, in Bangla, for the preview and the after-hours message. */
  reason: string
  rule: 'holiday' | 'weekly_offday' | 'special_hours' | 'office_hours'
}

export type InboundDecision = {
  did: string
  route: DidRoute | null
  /** True when the caller is the owner — he is never blocked and never gets the receptionist. */
  owner: boolean
  blocked: boolean
  time: TimeVerdict
  transferMode: 'direct' | 'ask_first'
  forwardSupport: string
  forwardBoss: string
  /** Plain Bangla: what would actually happen. This is the whole point of the preview. */
  outcome: string
}

// ── outbound: what may be dialled ────────────────────────────────────────────

export type OutboundDecision = {
  allowed: boolean
  /** The number as Asterisk would actually dial it, after prefix rules. */
  dialled: string
  reason: string
}

export const WEEKDAYS: ReadonlyArray<{ value: string; label: string; index: number }> = [
  { value: 'sun', label: 'রবি', index: 0 },
  { value: 'mon', label: 'সোম', index: 1 },
  { value: 'tue', label: 'মঙ্গল', index: 2 },
  { value: 'wed', label: 'বুধ', index: 3 },
  { value: 'thu', label: 'বৃহঃ', index: 4 },
  { value: 'fri', label: 'শুক্র', index: 5 },
  { value: 'sat', label: 'শনি', index: 6 },
]

// ── shapes the API returns ───────────────────────────────────────────────────

export type RoutingPayload = {
  ok: true
  dids: DidRoute[]
  /** The DIDs we have actually seen calls arrive on, so the owner is not typing from memory. */
  seenDids: Array<{ did: string; calls: number; lastAt: string | null }>
  ourDid: string
}

export type PreviewRequest = {
  caller: string
  did: string
  /** "21:30" — Dhaka wall clock. */
  at: string
  /** YYYY-MM-DD, so a holiday or a Friday can be tested without waiting for one. */
  date: string
}
