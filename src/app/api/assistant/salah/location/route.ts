/**
 * Salah location (owner rule ৪, 2026-07-29): which country/city's clock and
 * prayer times the whole salah system follows.
 *
 * GET  → { offsetMin, label }
 * POST { offsetMin, label, autofill?: { city, country, method? } }
 *   - saves the location KV (worker reads it every tick, 60s cache)
 *   - with `autofill`, pulls the location's prayer times from AlAdhan and fills
 *     the ৩×৫ time config deterministically (azan = API time, jamaat = azan+15,
 *     end = next waqt's azan; ইশা ends at Islamic midnight). Owner can hand-tune
 *     any cell afterwards in the same card.
 */
import { type NextRequest } from 'next/server'
import { getToken } from 'next-auth/jwt'
import { requireAgentEnabled } from '@/agent/lib/guards'
import { isSystemOwner } from '@/lib/roles'
import { prisma } from '@/lib/prisma'
import { getSalahTimeConfig, setSalahTimeConfig, type SalahTimeConfig } from '@/lib/salah/time-config'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const OFFSET_KEY = 'salah_utc_offset_min'
const LABEL_KEY = 'salah_location_label'
const DEFAULT_OFFSET = 360

async function requireOwner(req: NextRequest) {
  const disabled = requireAgentEnabled()
  if (disabled) return { error: disabled }
  const token = await getToken({ req, secret: process.env.NEXTAUTH_SECRET })
  if (!token?.sub) return { error: Response.json({ error: 'unauthorized' }, { status: 401 }) }
  if (!isSystemOwner(token)) return { error: Response.json({ error: 'forbidden' }, { status: 403 }) }
  return { ok: true as const }
}

async function readLocation() {
  const rows = await prisma.agentKvSetting.findMany({
    where: { key: { in: [OFFSET_KEY, LABEL_KEY] } },
    select: { key: true, value: true },
  })
  const map = new Map(rows.map((r) => [r.key, r.value]))
  const n = Number(map.get(OFFSET_KEY))
  return {
    offsetMin: Number.isFinite(n) && n >= -720 && n <= 840 ? Math.round(n) : DEFAULT_OFFSET,
    label: map.get(LABEL_KEY) || 'বাংলাদেশ (ঢাকা)',
  }
}

export async function GET(req: NextRequest) {
  const auth = await requireOwner(req)
  if ('error' in auth && auth.error) return auth.error
  return Response.json(await readLocation())
}

function addMinutesHm(hm: string, mins: number): string {
  const [h, m] = hm.split(':').map(Number)
  const t = ((h * 60 + m + mins) % 1440 + 1440) % 1440
  return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`
}

/** AlAdhan "HH:MM (+04)" → "HH:MM". */
function cleanHm(v: unknown): string | null {
  const m = String(v ?? '').match(/^(\d{2}:\d{2})/)
  return m ? m[1] : null
}

async function autofillTimes(city: string, country: string, method: number) {
  const url =
    `https://api.aladhan.com/v1/timingsByCity?city=${encodeURIComponent(city)}` +
    `&country=${encodeURIComponent(country)}&method=${method}`
  const res = await fetch(url, { signal: AbortSignal.timeout(15_000) })
  if (!res.ok) throw new Error(`aladhan HTTP ${res.status}`)
  const data = (await res.json()) as { data?: { timings?: Record<string, string> } }
  const t = data.data?.timings
  const fajr = cleanHm(t?.Fajr)
  const sunrise = cleanHm(t?.Sunrise)
  const dhuhr = cleanHm(t?.Dhuhr)
  const asr = cleanHm(t?.Asr)
  const maghrib = cleanHm(t?.Maghrib)
  const isha = cleanHm(t?.Isha)
  const midnight = cleanHm(t?.Midnight)
  if (!fajr || !dhuhr || !asr || !maghrib || !isha) throw new Error('aladhan timings incomplete')

  const cfg = (await getSalahTimeConfig()) as SalahTimeConfig
  const next: SalahTimeConfig = {
    ...cfg,
    fajr:    { azan: fajr,    prayer: addMinutesHm(fajr, 20),   end: sunrise ?? addMinutesHm(fajr, 75) },
    dhuhr:   { azan: dhuhr,   prayer: addMinutesHm(dhuhr, 15),  end: asr },
    asr:     { azan: asr,     prayer: addMinutesHm(asr, 15),    end: maghrib },
    maghrib: { azan: maghrib, prayer: addMinutesHm(maghrib, 10), end: isha },
    isha:    { azan: isha,    prayer: addMinutesHm(isha, 15),   end: midnight ?? '23:59' },
  }
  await setSalahTimeConfig(next)
  return next
}

export async function POST(req: NextRequest) {
  const auth = await requireOwner(req)
  if ('error' in auth && auth.error) return auth.error

  let body: {
    offsetMin?: unknown
    label?: unknown
    autofill?: { city?: unknown; country?: unknown; method?: unknown } | null
  }
  try {
    body = await req.json()
  } catch {
    return Response.json({ error: 'invalid_json' }, { status: 400 })
  }

  const offsetMin = Number(body.offsetMin)
  if (!Number.isFinite(offsetMin) || offsetMin < -720 || offsetMin > 840) {
    return Response.json({ error: 'offsetMin (-720..840) লাগবে' }, { status: 400 })
  }
  const label = typeof body.label === 'string' && body.label.trim() ? body.label.trim().slice(0, 80) : null

  await prisma.agentKvSetting.upsert({
    where: { key: OFFSET_KEY },
    create: { key: OFFSET_KEY, value: String(Math.round(offsetMin)) },
    update: { value: String(Math.round(offsetMin)) },
  })
  if (label) {
    await prisma.agentKvSetting.upsert({
      where: { key: LABEL_KEY },
      create: { key: LABEL_KEY, value: label },
      update: { value: label },
    })
  }
  // Invalidate the worker's per-day init marker: the next 5-min tick rebuilds
  // today's records on the NEW offset even without a time-config write.
  await prisma.agentKvSetting.deleteMany({
    where: { key: { startsWith: 'salah_records_offset:' } },
  }).catch(() => {})

  let config: SalahTimeConfig | null = null
  if (body.autofill && typeof body.autofill.city === 'string' && typeof body.autofill.country === 'string') {
    try {
      const method = Number(body.autofill.method)
      config = await autofillTimes(
        body.autofill.city,
        body.autofill.country,
        Number.isFinite(method) && method >= 0 && method <= 23 ? method : 3,
      )
    } catch (err) {
      return Response.json(
        { ok: false, error: `লোকেশন সেভ হয়েছে, কিন্তু সময় আনা যায়নি: ${(err as Error).message}` },
        { status: 502 },
      )
    }
  }

  return Response.json({ ok: true, offsetMin: Math.round(offsetMin), label, config })
}
