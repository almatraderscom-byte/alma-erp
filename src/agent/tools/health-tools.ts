import { prisma } from '@/lib/prisma'
import { todayYmdDhaka, dhakaMidnightUtc, dhakaDayBounds } from '@/lib/agent-api/dhaka-date'
import type { AgentTool } from './registry'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = prisma as any

const FREQUENCIES = ['daily', 'weekly', 'as_needed', 'one_time']

/** Normalise a "HH:mm,HH:mm" times string — keep only valid 24h clock entries. */
function normaliseTimes(raw: unknown): string | null {
  if (raw == null) return null
  const parts = String(raw)
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter(Boolean)
    .filter((s) => /^\d{1,2}:\d{2}$/.test(s))
    .map((s) => {
      const [h, m] = s.split(':').map(Number)
      if (h! > 23 || m! > 59) return null
      return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
    })
    .filter((s): s is string => s != null)
  return parts.length ? parts.join(',') : null
}

// ─── Medications ────────────────────────────────────────────────────────────

const add_medication: AgentTool = {
  name: 'add_medication',
  description:
    'Track a medicine/supplement the owner takes on a schedule, so the agent can remind him in the daily ' +
    'briefing and (for daily meds) at dose times. Use when the owner says "X ush prtidin nite hbe", ' +
    '"sokal-rat e oushod ache", "vitamin add koro". times is a comma list of 24h HH:mm (e.g. "08:00,21:00").',
  input_schema: {
    type: 'object' as const,
    properties: {
      name: { type: 'string', description: 'Medicine name, e.g. "Napa", "Metformin", "Vitamin D"' },
      dosage: { type: 'string', description: 'e.g. "1 ট্যাবলেট", "500mg"' },
      times: { type: 'string', description: 'Dose times, 24h HH:mm comma list, e.g. "08:00,14:00,21:00"' },
      frequency: { type: 'string', enum: FREQUENCIES, description: 'Default daily' },
      startDate: { type: 'string', description: 'yyyy-MM-dd (default today)' },
      endDate: { type: 'string', description: 'yyyy-MM-dd — when to stop (optional, for a course)' },
      notes: { type: 'string', description: 'Optional free-text note' },
    },
    required: ['name'],
  },
  handler: async (input) => {
    const name = String(input.name ?? '').trim()
    if (!name) return { success: false, error: 'name is required' }
    const frequency = FREQUENCIES.includes(String(input.frequency)) ? String(input.frequency) : 'daily'
    const startYmd =
      input.startDate && /^\d{4}-\d{2}-\d{2}$/.test(String(input.startDate))
        ? String(input.startDate)
        : todayYmdDhaka()
    const endYmd =
      input.endDate && /^\d{4}-\d{2}-\d{2}$/.test(String(input.endDate)) ? String(input.endDate) : null
    try {
      const med = await db.agentMedication.create({
        data: {
          name,
          dosage: input.dosage ? String(input.dosage) : null,
          times: normaliseTimes(input.times),
          frequency,
          startDate: dhakaMidnightUtc(startYmd),
          endDate: endYmd ? dhakaMidnightUtc(endYmd) : null,
          active: true,
          notes: input.notes ? String(input.notes) : null,
        },
      })
      return {
        success: true,
        data: {
          id: med.id,
          name: med.name,
          message: `"${name}" ওষুধ ট্র্যাকে যোগ হয়েছে${med.times ? ` — সময়: ${med.times}` : ''}${endYmd ? `, ${endYmd} পর্যন্ত` : ''}।`,
        },
      }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  },
}

const list_medications: AgentTool = {
  name: 'list_medications',
  description:
    'List the medicines/supplements being tracked. Use when the owner asks "ki ki oushod nicchi", ' +
    '"amar medicine list dekhao". Returns each with dose times and course end date.',
  input_schema: {
    type: 'object' as const,
    properties: {
      includeInactive: { type: 'boolean', description: 'Default false (only active)' },
    },
  },
  handler: async (input) => {
    try {
      const where = input.includeInactive ? {} : { active: true }
      const meds = await db.agentMedication.findMany({ where, orderBy: { name: 'asc' }, take: 100 })
      return {
        success: true,
        data: {
          count: meds.length,
          medications: meds.map(
            (m: {
              id: string
              name: string
              dosage: string | null
              times: string | null
              frequency: string
              startDate: Date | null
              endDate: Date | null
              active: boolean
              notes: string | null
            }) => ({
              id: m.id,
              name: m.name,
              dosage: m.dosage,
              times: m.times,
              frequency: m.frequency,
              startDate: m.startDate ? new Date(m.startDate).toISOString().slice(0, 10) : null,
              endDate: m.endDate ? new Date(m.endDate).toISOString().slice(0, 10) : null,
              active: m.active,
              notes: m.notes,
            }),
          ),
        },
      }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  },
}

const update_medication: AgentTool = {
  name: 'update_medication',
  description:
    'Update or stop a tracked medicine — change dose/times, or mark the course finished. Use when the owner ' +
    'says "X oushod ses / bondho koro", "dose change holo", "rate r lagbe na".',
  input_schema: {
    type: 'object' as const,
    properties: {
      id: { type: 'string', description: 'Medication id from list_medications' },
      nameMatch: { type: 'string', description: 'Alternative to id — match an active medicine by partial name' },
      dosage: { type: 'string', description: 'New dose, e.g. 500mg' },
      times: { type: 'string', description: 'New dose times, e.g. "সকাল, রাত" or "09:00,21:00"' },
      frequency: { type: 'string', enum: FREQUENCIES, description: 'How often the medicine is taken' },
      endDate: { type: 'string', description: 'yyyy-MM-dd' },
      active: { type: 'boolean', description: 'Set false to stop tracking/reminding' },
      notes: { type: 'string', description: 'Optional free-text note' },
    },
  },
  handler: async (input) => {
    try {
      let id = input.id ? String(input.id) : null
      if (!id && input.nameMatch) {
        const match = await db.agentMedication.findFirst({
          where: { active: true, name: { contains: String(input.nameMatch), mode: 'insensitive' } },
        })
        if (!match) return { success: false, error: `"${input.nameMatch}" নামে কোনো active ওষুধ পাওয়া যায়নি।` }
        id = match.id
      }
      if (!id) return { success: false, error: 'id or nameMatch required' }

      const data: Record<string, unknown> = {}
      if (input.dosage != null) data.dosage = String(input.dosage)
      if (input.times != null) data.times = normaliseTimes(input.times)
      if (input.frequency != null && FREQUENCIES.includes(String(input.frequency))) data.frequency = String(input.frequency)
      if (input.endDate != null && /^\d{4}-\d{2}-\d{2}$/.test(String(input.endDate)))
        data.endDate = dhakaMidnightUtc(String(input.endDate))
      if (typeof input.active === 'boolean') data.active = input.active
      if (input.notes != null) data.notes = String(input.notes)
      if (!Object.keys(data).length) return { success: false, error: 'কিছু পরিবর্তন দিন।' }

      const updated = await db.agentMedication.update({ where: { id }, data })
      return { success: true, data: { id: updated.id, name: updated.name, message: `"${updated.name}" আপডেট হয়েছে।` } }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  },
}

// ─── Health logs ────────────────────────────────────────────────────────────

const log_health: AgentTool = {
  name: 'log_health',
  description:
    'Record a health reading or note — weight, blood pressure, blood sugar, sleep, mood, symptoms, etc. ' +
    'Use when the owner says "ojon 72 kg", "BP 120/80", "sugar 6.5", "aj matha betha". Free-form: type is the ' +
    'metric name, value is the reading, unit optional.',
  input_schema: {
    type: 'object' as const,
    properties: {
      type: { type: 'string', description: 'Metric, e.g. "weight", "blood_pressure", "sugar", "sleep", "mood", "symptom"' },
      value: { type: 'string', description: 'The reading, e.g. "72", "120/80", "6.5", "matha betha"' },
      unit: { type: 'string', description: 'e.g. "kg", "mmHg", "mmol/L", "hours"' },
      note: { type: 'string', description: 'Optional context note for the reading' },
      loggedAt: { type: 'string', description: 'ISO time (default now)' },
    },
    required: ['type'],
  },
  handler: async (input) => {
    const type = String(input.type ?? '').trim()
    if (!type) return { success: false, error: 'type is required' }
    let loggedAt = new Date()
    if (input.loggedAt) {
      const d = new Date(String(input.loggedAt))
      if (!isNaN(d.getTime())) loggedAt = d
    }
    try {
      const row = await db.agentHealthLog.create({
        data: {
          type,
          value: input.value != null ? String(input.value) : null,
          unit: input.unit ? String(input.unit) : null,
          note: input.note ? String(input.note) : null,
          loggedAt,
        },
      })
      return {
        success: true,
        data: {
          id: row.id,
          message: `${type} রেকর্ড হয়েছে${input.value != null ? `: ${input.value}${input.unit ? ' ' + input.unit : ''}` : ''}।`,
        },
      }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  },
}

const list_health_logs: AgentTool = {
  name: 'list_health_logs',
  description:
    'Show recent health readings, optionally filtered by type, to spot trends. Use when the owner asks ' +
    '"amar ojon er history dekhao", "last koyek diner BP", "sugar er trend ki".',
  input_schema: {
    type: 'object' as const,
    properties: {
      type: { type: 'string', description: 'Filter by metric (optional)' },
      days: { type: 'number', description: 'Look-back window in days (default 30)' },
      limit: { type: 'number', description: 'Max rows (default 30)' },
    },
  },
  handler: async (input) => {
    try {
      const days = input.days != null ? Math.max(1, Math.trunc(Number(input.days))) : 30
      const since = dhakaDayBounds(todayYmdDhaka()).end
      since.setTime(since.getTime() - days * 86_400_000)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const where: any = { loggedAt: { gte: since } }
      if (input.type) where.type = { contains: String(input.type), mode: 'insensitive' }
      const rows = await db.agentHealthLog.findMany({
        where,
        orderBy: { loggedAt: 'desc' },
        take: input.limit != null ? Math.min(200, Math.max(1, Math.trunc(Number(input.limit)))) : 30,
      })
      return {
        success: true,
        data: {
          count: rows.length,
          logs: rows.map(
            (r: { id: string; type: string; value: string | null; unit: string | null; note: string | null; loggedAt: Date }) => ({
              id: r.id,
              type: r.type,
              value: r.value,
              unit: r.unit,
              note: r.note,
              loggedAt: new Date(r.loggedAt).toISOString(),
            }),
          ),
        },
      }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  },
}

export const HEALTH_TOOLS: AgentTool[] = [
  add_medication,
  list_medications,
  update_medication,
  log_health,
  list_health_logs,
]

export const HEALTH_ROLE_PROMPT = `
## স্বাস্থ্য ও ওষুধ
owner-এর ওষুধের সময়সূচি ও স্বাস্থ্যের রিডিং ট্র্যাক করুন। ব্রিফিং-এ আজকের ওষুধ মনে করিয়ে দেওয়া হয়।
- "X oushod prtidin / sokal-rat nite hbe" → add_medication (times = 24h "08:00,21:00")।
- "ki ki oushod nicchi" → list_medications। "ses / dose change" → update_medication।
- "ojon 72", "BP 120/80", "sugar 6.5", "matha betha" → log_health (type=metric, value=reading)।
- "ojon/BP er history / trend" → list_health_logs।
- চিকিৎসা পরামর্শ নয় — শুধু ট্র্যাকিং ও মনে করিয়ে দেওয়া। গুরুতর কিছু হলে ডাক্তার দেখাতে বলুন।
`
