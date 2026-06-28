/**
 * Geofence boundary alert — tell the owner when a supervised staffer who was
 * inside the office geofence moves outside during office hours.
 *
 * The Monitor UI already shows live in/out status (getGeoStatus in
 * staff-monitor-data.ts), but nothing alerts the owner on a boundary crossing.
 * This sweep runs from the geo-monitor cron: it compares each staffer's current
 * in/out state against the last-known state stored in one KV blob and raises a
 * single owner alert per in_zone → outside transition, with a cooldown so a
 * staffer lingering just outside doesn't re-alert every tick.
 *
 * Only genuine in_zone → outside transitions alert, so field staff who are never
 * inside the zone never trigger it, and a fresh deploy (no prior state) arms
 * silently. Office coordinates come from env per business
 * (OFFICE_<BUSINESS>_LAT / _LNG / _RADIUS_M, with legacy OFFICE_LAT/LNG fallback
 * for ALMA_LIFESTYLE), so only businesses with a configured office are swept.
 *
 * Honors the geo_fence_monitoring_enabled KV toggle and the office-hours gate.
 */
import { prisma } from '@/lib/prisma'
import { notifyOwner } from '@/agent/lib/notify-owner'
import { isWithinOfficeHours } from '@/agent/lib/office-supervisor'
import { getGeoFenceMonitoringEnabled } from '@/agent/lib/geo-fence-settings'
import { SUPERVISED_BUSINESSES } from '@/agent/lib/constants'

const STATE_KEY = 'geo_fence_state'
/** Don't re-alert a staffer who stays outside within this window. */
const RENOTIFY_COOLDOWN_MS = 60 * 60 * 1000
/** A GPS fix older than this is treated as "no fresh fix" — keep last-known state, don't decide. */
const STALE_FIX_MIN = 10

type ZoneStatus = 'in_zone' | 'outside'
interface StaffGeoState {
  status: ZoneStatus
  lastNotifiedAt?: string
}
type GeoStateMap = Record<string, StaffGeoState>

interface Office {
  lat: number
  lng: number
  radiusM: number
}

function businessLabel(businessId: string): string {
  if (businessId === 'ALMA_TRADING') return 'ALMA Trading'
  if (businessId === 'CDIT') return 'CDIT'
  return 'ALMA Lifestyle'
}

/** Resolve a business's office from env, or null when none is configured. */
function officeFor(businessId: string): Office | null {
  const key = businessId.toUpperCase()
  const legacy = businessId === 'ALMA_LIFESTYLE'
  const lat = Number(process.env[`OFFICE_${key}_LAT`] || (legacy ? process.env.OFFICE_LAT : '') || 0)
  const lng = Number(process.env[`OFFICE_${key}_LNG`] || (legacy ? process.env.OFFICE_LNG : '') || 0)
  const radiusM = Number(process.env[`OFFICE_${key}_RADIUS_M`] || (legacy ? process.env.OFFICE_RADIUS_M : '') || 300)
  if (!lat || !lng) return null
  return { lat, lng, radiusM }
}

function haversineM(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371000
  const toRad = (d: number) => (d * Math.PI) / 180
  const dLat = toRad(lat2 - lat1)
  const dLng = toRad(lng2 - lng1)
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
}

async function readState(): Promise<GeoStateMap> {
  const row = await prisma.agentKvSetting.findUnique({ where: { key: STATE_KEY } })
  if (!row?.value) return {}
  try {
    return JSON.parse(row.value) as GeoStateMap
  } catch {
    return {}
  }
}

async function writeState(state: GeoStateMap): Promise<void> {
  const value = JSON.stringify(state)
  await prisma.agentKvSetting.upsert({
    where: { key: STATE_KEY },
    create: { key: STATE_KEY, value },
    update: { value },
  })
}

export interface GeoFenceSweepResult {
  ran: boolean
  reason?: 'off_hours' | 'disabled'
  checked: number
  breaches: number
  alerted: number
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = prisma as any

/**
 * Sweep every supervised business with a configured office, alert the owner on
 * each fresh boundary breach, and persist the new in/out state for next tick.
 */
export async function runGeoFenceSweep(now: Date = new Date()): Promise<GeoFenceSweepResult> {
  if (!isWithinOfficeHours(now)) return { ran: false, reason: 'off_hours', checked: 0, breaches: 0, alerted: 0 }
  if (!(await getGeoFenceMonitoringEnabled())) return { ran: false, reason: 'disabled', checked: 0, breaches: 0, alerted: 0 }

  const prevState = await readState()
  const nextState: GeoStateMap = {}
  let checked = 0
  let breaches = 0
  let alerted = 0

  for (const businessId of SUPERVISED_BUSINESSES) {
    const office = officeFor(businessId)
    if (!office) continue

    const staff = (await db.agentStaff.findMany({
      where: { active: true, businessId },
      select: { id: true, name: true },
    })) as Array<{ id: string; name: string }>

    for (const s of staff) {
      const loc = await db.agentStaffLocation.findFirst({
        where: { staffId: s.id },
        orderBy: { recordedAt: 'desc' },
      })
      // No fix, or a stale one → can't decide; preserve last-known state untouched.
      if (!loc) {
        if (prevState[s.id]) nextState[s.id] = prevState[s.id]
        continue
      }
      const ageMin = (now.getTime() - new Date(loc.recordedAt).getTime()) / 60_000
      if (ageMin > STALE_FIX_MIN) {
        if (prevState[s.id]) nextState[s.id] = prevState[s.id]
        continue
      }

      checked++
      const dist = haversineM(office.lat, office.lng, loc.lat, loc.lng)
      const status: ZoneStatus = dist <= office.radiusM ? 'in_zone' : 'outside'
      const prev = prevState[s.id]
      let lastNotifiedAt = prev?.lastNotifiedAt

      // Alert only on a genuine in_zone → outside crossing (never on first sight).
      if (status === 'outside' && prev?.status === 'in_zone') {
        breaches++
        const sinceLast = lastNotifiedAt ? now.getTime() - Date.parse(lastNotifiedAt) : Infinity
        if (sinceLast >= RENOTIFY_COOLDOWN_MS) {
          const mapsLink = `https://www.google.com/maps?q=${loc.lat},${loc.lng}`
          const msg =
            `${s.name} অফিস এলাকা ছেড়ে গেছেন (≈${Math.round(dist)} মিটার দূরে)।\n` +
            `${businessLabel(businessId)} — অফিস সময়।\n` +
            `অবস্থান: ${mapsLink}`
          try {
            await notifyOwner({ tier: 2, category: 'urgent', title: 'স্টাফ অফিস এলাকার বাইরে', message: msg })
            alerted++
            lastNotifiedAt = now.toISOString()
          } catch {
            // Keep the old timestamp so the next tick retries this breach.
          }
        }
      }

      // Clear the notify clock once back inside, so a later exit alerts afresh.
      nextState[s.id] = { status, lastNotifiedAt: status === 'in_zone' ? undefined : lastNotifiedAt }
    }
  }

  await writeState(nextState)
  return { ran: true, checked, breaches, alerted }
}
