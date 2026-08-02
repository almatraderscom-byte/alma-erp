/**
 * RC-1 — server-side state for phone→Mac REMOTE CONTROL (touch → CGEvent).
 *
 * Watching the Mac (L9 video) and touching it are two different rights. Video
 * is a subscriber token; control is a SEPARATE, short-lived token with a
 * different privilege set, minted only when the owner flips the control switch
 * in the dock sheet. This module owns the three facts that make that safe:
 *
 *   1. **Which uids the server itself minted for the owner** (`mac_view_uids:*`).
 *      The control token must be for the uid the phone is ALREADY joined with
 *      (renewing beats rejoining — a rejoin blacks out the video), but a client
 *      must never be able to name an arbitrary uid. So the video-token route
 *      registers every uid it hands out, and the control route will only mint
 *      for a uid found in that register.
 *   2. **The single pinned control uid** (`mac_control_session:*`). The
 *      broadcaster accepts stream messages from that uid and drops everything
 *      else, so another participant in the channel cannot inject.
 *   3. **An audit trail** (`mac_control_audit:*`) — session start/stop with
 *      event and drop counts. Per-tap logging would be noise; per-session is
 *      what answers "what touched my Mac, when".
 *
 * All three live in `agent_kv_settings` (no migration): the state is ephemeral
 * by nature — a grant is worthless 2 minutes after it is written, and a stale
 * row is indistinguishable from no row because every read is freshness-gated.
 */
import { prisma } from '@/lib/prisma'
import { randomUUID } from 'crypto'

/** Control grants are short and renewed by the phone; a lost phone goes dark fast. */
export const CONTROL_TTL_SEC = 120
/** A viewer uid may be upgraded to control for this long after it was minted. */
const VIEW_UID_TTL_MS = 15 * 60 * 1000
const MAX_VIEW_UIDS = 6
const MAX_AUDIT_ROWS = 30

export const viewUidsKey = (deviceId: string) => `mac_view_uids:${deviceId}`
export const controlPinKey = (deviceId: string) => `mac_control_session:${deviceId}`
export const controlAuditKey = (deviceId: string) => `mac_control_audit:${deviceId}`

export interface ControlPin {
  uid: number
  sessionId: string
  grantedAt: string
  expiresAt: string
}

export interface ControlAuditRow {
  sessionId: string
  uid: number
  startedAt: string
  endedAt?: string
  events: number
  drops: number
  endedBy?: string
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const kv = () => (prisma as any).agentKvSetting

async function readJson<T>(key: string): Promise<T | null> {
  try {
    const row = await kv().findUnique({ where: { key }, select: { value: true } })
    if (!row?.value) return null
    return JSON.parse(row.value) as T
  } catch {
    return null
  }
}

async function writeJson(key: string, value: unknown): Promise<void> {
  const str = JSON.stringify(value)
  await kv()
    .upsert({ where: { key }, create: { key, value: str }, update: { value: str } })
    .catch(() => {})
}

async function delKey(key: string): Promise<void> {
  await kv().delete({ where: { key } }).catch(() => {})
}

/** Called by the video-token route for every subscriber uid it mints. */
export async function registerViewUid(deviceId: string, uid: number): Promise<void> {
  const now = Date.now()
  const rows = (await readJson<{ uid: number; at: string }[]>(viewUidsKey(deviceId))) ?? []
  const kept = rows
    .filter((r) => r && typeof r.uid === 'number' && now - Date.parse(r.at) < VIEW_UID_TTL_MS)
    .filter((r) => r.uid !== uid)
  kept.push({ uid, at: new Date(now).toISOString() })
  await writeJson(viewUidsKey(deviceId), kept.slice(-MAX_VIEW_UIDS))
}

/** True only if THIS server minted `uid` for THIS device recently. */
export async function isKnownViewUid(deviceId: string, uid: number): Promise<boolean> {
  const now = Date.now()
  const rows = (await readJson<{ uid: number; at: string }[]>(viewUidsKey(deviceId))) ?? []
  return rows.some((r) => r?.uid === uid && now - Date.parse(r.at) < VIEW_UID_TTL_MS)
}

/**
 * Grant (or renew) control for one uid. Renewing keeps the same sessionId so
 * the audit row stays a single session instead of one row per 45s heartbeat.
 */
export class ControlHeldByAnother extends Error {
  constructor(public readonly heldByUid: number) {
    super('control_held')
  }
}

export async function grantControl(deviceId: string, uid: number): Promise<ControlPin> {
  const key = controlPinKey(deviceId)
  const now = new Date()
  const claim: ControlPin = {
    uid,
    sessionId: randomUUID(),
    grantedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + CONTROL_TTL_SEC * 1000).toISOString(),
  }

  // Claim by CREATE, not by read-then-write: two owner devices arming at the
  // same moment would both read "no pin", both write, and the loser would show
  // itself as armed while every tap it sent was dropped as uid_mismatch. The
  // unique key makes exactly one of them win (Codex P2).
  const claimed = await kv()
    .create({ data: { key, value: JSON.stringify(claim) } })
    .then(() => true)
    .catch(() => false)
  if (claimed) {
    await appendAudit(deviceId, {
      sessionId: claim.sessionId, uid, startedAt: claim.grantedAt, events: 0, drops: 0,
    })
    return claim
  }

  // A row exists. `readControlPin` retires it if the lease has lapsed.
  const existing = await readControlPin(deviceId)
  if (!existing) {
    // It was stale and has just been cleared — one retry, then give up rather
    // than loop against a live competitor.
    const retried = await kv()
      .create({ data: { key, value: JSON.stringify(claim) } })
      .then(() => true)
      .catch(() => false)
    if (retried) {
      await appendAudit(deviceId, {
        sessionId: claim.sessionId, uid, startedAt: claim.grantedAt, events: 0, drops: 0,
      })
      return claim
    }
    const winner = await readControlPin(deviceId)
    if (winner && winner.uid !== uid) throw new ControlHeldByAnother(winner.uid)
    if (!winner) throw new ControlHeldByAnother(0)
    return renew(deviceId, winner, now)
  }

  // Whoever holds a FRESH pin keeps it; the same device simply renews.
  if (existing.uid !== uid) throw new ControlHeldByAnother(existing.uid)
  return renew(deviceId, existing, now)
}

/** Extend an existing grant, keeping its session (and its one audit row). */
async function renew(deviceId: string, pin: ControlPin, now: Date): Promise<ControlPin> {
  const renewed: ControlPin = {
    ...pin,
    expiresAt: new Date(now.getTime() + CONTROL_TTL_SEC * 1000).toISOString(),
  }
  await writeJson(controlPinKey(deviceId), renewed)
  return renewed
}

/** Fresh pin, or null when absent/expired — an expired grant is simply no grant. */
export async function readControlPin(deviceId: string): Promise<ControlPin | null> {
  const pin = await readJson<ControlPin>(controlPinKey(deviceId))
  if (!pin || typeof pin.uid !== 'number') return null
  if (Date.parse(pin.expiresAt) <= Date.now()) {
    // A phone that was killed or lost signal never sends the off request, so
    // an expired grant must clean up after itself — otherwise its audit row
    // stays open forever and the next session is appended beneath it
    // (Codex P2).
    await delKey(controlPinKey(deviceId))
    await closeAudit(deviceId, pin.sessionId, 'expired')
    return null
  }
  return pin
}

export async function revokeControl(deviceId: string, endedBy: string, counts?: { events?: number; drops?: number }): Promise<void> {
  const pin = await readJson<ControlPin>(controlPinKey(deviceId))
  await delKey(controlPinKey(deviceId))
  if (pin) await closeAudit(deviceId, pin.sessionId, endedBy, counts)
}

async function appendAudit(deviceId: string, row: ControlAuditRow): Promise<void> {
  const rows = (await readJson<ControlAuditRow[]>(controlAuditKey(deviceId))) ?? []
  rows.push(row)
  await writeJson(controlAuditKey(deviceId), rows.slice(-MAX_AUDIT_ROWS))
}

/** Roll the daemon's reported counters into the open audit row (cheap, per-frame). */
export async function recordControlCounts(
  deviceId: string, sessionId: string, events: number, drops: number,
): Promise<void> {
  const rows = (await readJson<ControlAuditRow[]>(controlAuditKey(deviceId))) ?? []
  const row = rows.find((r) => r.sessionId === sessionId)
  if (!row) return
  if (row.events === events && row.drops === drops) return
  row.events = events
  row.drops = drops
  await writeJson(controlAuditKey(deviceId), rows)
}

async function closeAudit(
  deviceId: string, sessionId: string, endedBy: string, counts?: { events?: number; drops?: number },
): Promise<void> {
  const rows = (await readJson<ControlAuditRow[]>(controlAuditKey(deviceId))) ?? []
  const row = rows.find((r) => r.sessionId === sessionId)
  if (!row || row.endedAt) return
  row.endedAt = new Date().toISOString()
  row.endedBy = endedBy
  if (typeof counts?.events === 'number') row.events = counts.events
  if (typeof counts?.drops === 'number') row.drops = counts.drops
  await writeJson(controlAuditKey(deviceId), rows)
}

export async function listControlAudit(deviceId: string): Promise<ControlAuditRow[]> {
  return (await readJson<ControlAuditRow[]>(controlAuditKey(deviceId))) ?? []
}
