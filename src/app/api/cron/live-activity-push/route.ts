// "Business Pulse" Dynamic Panel — the priority + dedupe push service (spec §15).
//
// Recomputes the authoritative snapshot and pushes it to the owner's Live
// Activity so the lock screen stays live while the app is closed. This is the
// ONLY thing that makes an approval appear (and chime) seconds after it is
// created without the owner opening the app.
//
// Why a cron and not ERP event hooks: hooking every place that creates an
// approval would mean editing live ERP code all over the repo (CLAUDE.md hard
// rule #1). Recomputing one cheap snapshot on a tick is the same outcome with a
// single, isolated touch point — and it is self-healing, because a missed event
// simply corrects itself on the next run.
//
// Discipline this route enforces:
//   • SILENT by default — a push only carries an alert for a NEW approval /
//     urgent event key we have never alerted on (spec §11.1, §11.5).
//   • COALESCED — we only push when something MATERIAL changed (mode, a count,
//     the focused event). Ordinary no-op ticks send nothing at all (spec §14).
//   • Dedupe state lives in agent_kv_settings, so it survives redeploys and is
//     shared across every device the owner owns.
import { NextRequest, NextResponse } from 'next/server'
import { createHash } from 'node:crypto'
import { prisma } from '@/lib/prisma'
import { isAgentEnabled } from '@/agent/config'
import { buildPulseSnapshot } from '@/agent/lib/pulse-snapshot'
import { getLiveActivityTokens, sendPulsePush } from '@/agent/lib/live-activity-push'
import { resolveOwnerUserIds } from '@/agent/lib/native-owner-push'
import { toPulseContentState } from '@/lib/pulse-state'

export const runtime = 'nodejs'
export const maxDuration = 60

/** KV: JSON { hash, alertKeys[] } describing what we last pushed. */
const KV_KEY = 'pulse_push_state'
/** How many recent alert keys we remember (bounded — old ones can't recur). */
const MAX_REMEMBERED_KEYS = 50

function authorized(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET
  if (!secret) return false
  const auth = req.headers.get('authorization')
  const internal = req.headers.get('x-alma-internal-token')
  return (
    auth === `Bearer ${secret}` ||
    (Boolean(process.env.AGENT_INTERNAL_TOKEN) &&
      internal === process.env.AGENT_INTERNAL_TOKEN)
  )
}

type PushState = { hash: string; alertKeys: string[] }

async function readState(): Promise<PushState> {
  try {
    const row = await prisma.agentKvSetting.findUnique({
      where: { key: KV_KEY },
      select: { value: true },
    })
    const parsed = row?.value ? (JSON.parse(row.value) as Partial<PushState>) : {}
    return {
      hash: typeof parsed.hash === 'string' ? parsed.hash : '',
      alertKeys: Array.isArray(parsed.alertKeys)
        ? parsed.alertKeys.filter((k): k is string => typeof k === 'string')
        : [],
    }
  } catch {
    // Unreadable state must not cause a noisy re-alert — treat as "seen
    // nothing new" by returning an empty hash but no keys, and let the
    // material-change check below decide.
    return { hash: '', alertKeys: [] }
  }
}

async function writeState(state: PushState): Promise<void> {
  const value = JSON.stringify({
    hash: state.hash,
    alertKeys: state.alertKeys.slice(-MAX_REMEMBERED_KEYS),
  })
  try {
    await prisma.agentKvSetting.upsert({
      where: { key: KV_KEY },
      create: { key: KV_KEY, value },
      update: { value },
    })
  } catch {
    /* best-effort: worst case we re-push an identical state next tick */
  }
}

/**
 * A fingerprint of everything the owner would actually SEE. Deliberately
 * excludes timestamps — otherwise every tick would look "changed" and we'd push
 * (and drain battery) once a minute forever.
 */
function materialHash(s: {
  mode: string
  headline: string
  subtitle: string
  pendingTaskCount: number
  approvalCount: number
  runningOrderCount: number
  orderProgress?: number
  items: { id: string; title: string; valueText?: string }[]
}): string {
  const shape = JSON.stringify({
    mode: s.mode,
    headline: s.headline,
    subtitle: s.subtitle,
    p: s.pendingTaskCount,
    a: s.approvalCount,
    r: s.runningOrderCount,
    // Round progress so a 1% drift doesn't count as news.
    g: s.orderProgress === undefined ? null : Math.round(s.orderProgress * 20),
    i: s.items.map((i) => [i.id, i.title, i.valueText ?? '']),
  })
  return createHash('sha1').update(shape).digest('hex')
}

export async function GET(req: NextRequest) {
  if (!process.env.CRON_SECRET?.trim()) {
    return NextResponse.json({ error: 'CRON_SECRET not configured' }, { status: 500 })
  }
  if (!authorized(req)) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  if (!isAgentEnabled()) return NextResponse.json({ skipped: 'agent_disabled' })

  const ownerIds = await resolveOwnerUserIds()
  if (ownerIds.length === 0) return NextResponse.json({ skipped: 'no_owner' })

  const tokens = await getLiveActivityTokens(ownerIds)
  if (tokens.length === 0) return NextResponse.json({ skipped: 'no_tokens' })

  const snapshot = await buildPulseSnapshot()
  const hash = materialHash(snapshot)
  const prev = await readState()

  // Nothing the owner would notice has changed — stay off the radio entirely.
  if (hash === prev.hash) return NextResponse.json({ skipped: 'unchanged', mode: snapshot.mode })

  // Alert at most once per event key, ever (spec §11.5).
  const alertKey = snapshot.alertKey
  const isNewEvent = Boolean(alertKey) && !prev.alertKeys.includes(alertKey!)
  const alert = isNewEvent
    ? {
        title: snapshot.headline,
        body: snapshot.subtitle,
        sound: snapshot.mode === 'urgent' ? 'alma_urgent.caf' : 'alma_approval.caf',
      }
    : undefined

  const results = await sendPulsePush(tokens, toPulseContentState(snapshot), alert)
  const delivered = results.filter((r) => r.ok).length

  // Remember the key even if delivery failed: a retry must not double-chime
  // (spec §15 "Retry transient push failures without duplicating audible
  // alerts"). A silent re-push still corrects the panel on the next tick.
  await writeState({
    hash,
    alertKeys: alertKey && isNewEvent ? [...prev.alertKeys, alertKey] : prev.alertKeys,
  })

  return NextResponse.json({
    pushed: true,
    mode: snapshot.mode,
    alerted: Boolean(alert),
    tokens: tokens.length,
    delivered,
  })
}
