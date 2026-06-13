/**
 * Phase 10 — Staff GPS location tools (owner only, excluded from STAFF_SAFE_TOOLS).
 */
import { prisma } from '@/lib/prisma'
import type { AgentTool } from './registry'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = prisma as any

function mapsLink(lat: number, lng: number): string {
  return `https://www.google.com/maps?q=${lat},${lng}`
}

function dhakaDateStr(d = new Date()): string {
  return d.toLocaleDateString('en-CA', { timeZone: 'Asia/Dhaka' })
}

async function resolveStaff(staffQuery: string) {
  const q = staffQuery.trim()
  const rows = await db.agentStaff.findMany({
    where: { active: true },
    select: { id: true, name: true },
  })
  const match = rows.find(
    (s: { name: string }) => s.name.toLowerCase() === q.toLowerCase() || s.name.toLowerCase().includes(q.toLowerCase()),
  )
  return match ?? null
}

/** NULL metadata must be included — PostgreSQL excludes NULL from `NOT metadata = 'stopped'`. */
function activeLocationWhere(staffId: string, extra: Record<string, unknown> = {}) {
  return {
    staffId,
    OR: [{ metadata: null }, { metadata: { not: 'stopped' } }],
    ...extra,
  }
}

const get_staff_location: AgentTool = {
  name: 'get_staff_location',
  description: 'Returns the latest GPS location shared by a staff member (Telegram live location or task-done share) with Google Maps link. Owner only.',
  input_schema: {
    type: 'object' as const,
    properties: {
      staff: { type: 'string', description: 'Staff name (e.g. Mustahid, Eyafi)' },
    },
    required: ['staff'],
  },
  handler: async (input) => {
    const staff = await resolveStaff(String(input.staff ?? ''))
    if (!staff) return { success: false, error: `Staff "${input.staff}" পাওয়া যায়নি` }

    const loc = await db.agentStaffLocation.findFirst({
      where: activeLocationWhere(staff.id),
      orderBy: { recordedAt: 'desc' },
      select: { lat: true, lng: true, accuracy: true, recordedAt: true, source: true },
    })

    if (!loc) {
      return { success: true, data: { staff: staff.name, found: false, message: 'কোনো লোকেশন শেয়ার করা হয়নি।' } }
    }

    const at = loc.recordedAt.toLocaleString('en-BD', { timeZone: 'Asia/Dhaka', hour12: true })
    return {
      success: true,
      data: {
        staff: staff.name,
        found: true,
        lat: loc.lat,
        lng: loc.lng,
        accuracy: loc.accuracy,
        source: loc.source,
        recordedAt: loc.recordedAt.toISOString(),
        recordedAtBangla: at,
        mapsUrl: mapsLink(loc.lat, loc.lng),
      },
    }
  },
}

const get_staff_location_history: AgentTool = {
  name: 'get_staff_location_history',
  description: 'Lists staff GPS locations for a given date (Asia/Dhaka) with times and Google Maps links. Owner only.',
  input_schema: {
    type: 'object' as const,
    properties: {
      staff: { type: 'string' },
      date: { type: 'string', description: 'YYYY-MM-DD (default: today Dhaka)' },
    },
    required: ['staff'],
  },
  handler: async (input) => {
    const staff = await resolveStaff(String(input.staff ?? ''))
    if (!staff) return { success: false, error: `Staff "${input.staff}" পাওয়া যায়নি` }

    const dateStr = input.date ? String(input.date) : dhakaDateStr()
    const dayStart = new Date(`${dateStr}T00:00:00+06:00`)
    const dayEnd = new Date(`${dateStr}T23:59:59+06:00`)

    const rows = await db.agentStaffLocation.findMany({
      where: activeLocationWhere(staff.id, {
        recordedAt: { gte: dayStart, lte: dayEnd },
      }),
      orderBy: { recordedAt: 'asc' },
      select: { lat: true, lng: true, accuracy: true, recordedAt: true, source: true },
    })

    const points = rows.map((r: { lat: number; lng: number; accuracy: number | null; recordedAt: Date; source: string }) => ({
      time: r.recordedAt.toLocaleString('en-BD', { timeZone: 'Asia/Dhaka', hour12: true }),
      source: r.source,
      lat: r.lat,
      lng: r.lng,
      mapsUrl: mapsLink(r.lat, r.lng),
    }))

    return {
      success: true,
      data: { staff: staff.name, date: dateStr, count: points.length, points },
    }
  },
}

export const LOCATION_TOOLS: AgentTool[] = [get_staff_location, get_staff_location_history]
