/**
 * Imou event webhook receiver — the event-driven entrance watch.
 *
 * Registered via setMessageCallback (see /api/assistant/known-people/webhook):
 * when a camera's on-device detection fires (videoMotion / human), Imou's cloud
 * POSTs an alarm message here. Only then do we spend a snapshot + Gemini call —
 * replacing the every-minute polling that burned the API quota.
 *
 * Payload (per Imou push docs): { id, appId, did, cid, msgType, time, cname,
 * token, desc } — `did` is the deviceId, `msgType` e.g. "videoMotion".
 *
 * Rules Imou imposes: the receiver MUST answer 200 quickly and consistently —
 * repeated non-200s make Imou stop pushing to the URL permanently. So this route
 * returns 200 for EVERYTHING (bad key, wrong device, internal errors) and only
 * varies the JSON body; real processing is guarded + best-effort.
 *
 * Auth: Imou signs nothing usable, so the callback URL we register carries our
 * own secret (?k=<KV imou_webhook_key>). Wrong/missing key → logged + ignored.
 * We additionally check appId (when present) and only act on the entrance device.
 */
import { NextRequest, NextResponse } from 'next/server'
import { requireAgentEnabled } from '@/agent/lib/guards'
import { prisma } from '@/lib/prisma'

export const runtime = 'nodejs'
export const maxDuration = 60

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = prisma as any

interface ImouEvent {
  appId?: string
  did?: string
  deviceId?: string
  cid?: number | string
  msgType?: string
  time?: number | string
}

// Event types worth a snapshot. Owner-tunable via KV imou_event_types
// (comma-separated) — real msgType names vary by model/firmware, and the log
// line below shows what THIS camera actually sends so the list can be tuned.
const DEFAULT_EVENT_TYPES = 'videoMotion,human,humanDetect,aiHuman,pir'

async function kvGet(key: string): Promise<string | null> {
  try {
    const row = await db.agentKvSetting.findUnique({ where: { key }, select: { value: true } })
    return row?.value ?? null
  } catch {
    return null
  }
}

/** Parse the push body as leniently as possible — Imou pushes are not always tidy JSON. */
async function parseEvent(req: NextRequest): Promise<ImouEvent | null> {
  let raw = ''
  try {
    raw = await req.text()
  } catch {
    return null
  }
  if (!raw.trim()) return null
  try {
    return JSON.parse(raw) as ImouEvent
  } catch {
    // Some integrations report form-encoded or wrapped bodies; salvage a JSON object if present.
    const m = raw.match(/\{[\s\S]*\}/)
    if (m) {
      try {
        return JSON.parse(m[0]) as ImouEvent
      } catch { /* fall through */ }
    }
    console.warn('[imou-event] unparseable body:', raw.slice(0, 300))
    return null
  }
}

export async function POST(req: NextRequest) {
  // Always 200 (see header comment) — even when the agent kill switch is on we
  // must not make Imou blacklist the callback URL.
  if (requireAgentEnabled()) return NextResponse.json({ ok: true, ignored: 'agent_disabled' })

  const expectedKey = ((await kvGet('imou_webhook_key')) ?? '').trim()
  const presentedKey = (req.nextUrl.searchParams.get('k') ?? '').trim()
  if (!expectedKey || presentedKey !== expectedKey) {
    console.warn('[imou-event] bad or missing key — ignored')
    return NextResponse.json({ ok: true, ignored: 'bad_key' })
  }

  const event = await parseEvent(req)
  if (!event) return NextResponse.json({ ok: true, ignored: 'no_body' })

  const did = String(event.did ?? event.deviceId ?? '').trim()
  const msgType = String(event.msgType ?? '').trim()
  // One log line per event — this is how we learn the real msgType vocabulary.
  console.log(`[imou-event] received did=${did} msgType=${msgType}`)

  const ourAppId = (process.env.IMOU_APP_ID ?? '').trim()
  if (event.appId && ourAppId && String(event.appId).trim() !== ourAppId) {
    return NextResponse.json({ ok: true, ignored: 'wrong_app' })
  }

  const entranceDevice = ((await kvGet('entrance_camera_device_id')) ?? '').trim()
    || (process.env.IMOU_ENTRANCE_DEVICE_ID ?? '').trim()
  if (!did || did !== entranceDevice) {
    return NextResponse.json({ ok: true, ignored: 'other_device' })
  }

  const wanted = (((await kvGet('imou_event_types')) ?? DEFAULT_EVENT_TYPES) as string)
    .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)
  if (msgType && !wanted.includes(msgType.toLowerCase())) {
    return NextResponse.json({ ok: true, ignored: `msgType_${msgType}` })
  }

  try {
    const { runEntranceEvent } = await import('@/agent/lib/entrance-watch')
    const result = await runEntranceEvent(did)
    return NextResponse.json({ ok: true, ...result })
  } catch (err) {
    console.warn('[imou-event] processing failed:', err instanceof Error ? err.message : err)
    return NextResponse.json({ ok: true, ignored: 'processing_error' })
  }
}

// Imou (or its console) may probe the URL with GET — answer politely.
// With ?diag=1 and the correct key, also report what callback config Imou's
// cloud actually has stored (getMessageCallback) — for debugging missing pushes.
export async function GET(req: NextRequest) {
  const diag = req.nextUrl.searchParams.get('diag') === '1'
  if (!diag) return NextResponse.json({ ok: true })

  const expectedKey = ((await kvGet('imou_webhook_key')) ?? '').trim()
  const presentedKey = (req.nextUrl.searchParams.get('k') ?? '').trim()
  if (!expectedKey || presentedKey !== expectedKey) {
    return NextResponse.json({ ok: true, ignored: 'bad_key' })
  }
  try {
    const { getImouMessageCallback, setImouMessageCallback } = await import('@/agent/lib/imou-camera')
    // ?fix=1 → re-register, adding deviceStatus so a camera reboot produces a
    // controllable delivery test (alarm-only left us with no way to force a push).
    if (req.nextUrl.searchParams.get('fix') === '1') {
      await setImouMessageCallback({
        enable: true,
        callbackUrl: `https://alma-erp-six.vercel.app/api/assistant/internal/imou-event?k=${expectedKey}`,
        callbackFlag: 'alarm,deviceStatus',
      })
    }
    const config = await getImouMessageCallback()
    return NextResponse.json({ ok: true, config })
  } catch (err) {
    return NextResponse.json({
      ok: true,
      error: err instanceof Error ? err.message : 'getMessageCallback failed',
    })
  }
}
