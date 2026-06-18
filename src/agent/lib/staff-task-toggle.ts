/**
 * Owner on/off switches for staff-facing agent behaviours.
 *
 * KV key `staff_task_enabled`: JSON map { [key]: boolean }. Absent key = enabled.
 * The VPS worker reads the same key (worker/src/staff/staff-toggle.mjs).
 */
import { prisma } from '@/lib/prisma'

export const STAFF_TASK_ENABLED_KV_KEY = 'staff_task_enabled'

/** Every staff-facing behaviour the owner can switch off, in display order. */
export const STAFF_TASK_TOGGLES: ReadonlyArray<{ key: string; label: string; hint: string }> = [
  { key: 'proof_request', label: 'প্রুফ চেক (ছবি চাওয়া)', hint: 'দিনে কয়েকবার "কাজের ছবি পাঠান" — random' },
  { key: 'slow_task_alert', label: 'ধীর কাজ অ্যালার্ট', hint: 'কাজ দেরি হলে স্টাফকে নাজ + আপনাকে সংক্ষিপ্ত নোট' },
  { key: 'idle_detect', label: 'Idle ডিটেকশন', hint: 'অনেকক্ষণ আপডেট না এলে নাজ' },
  { key: 'progress_ask', label: 'Progress বাটন', hint: 'স্টাফ এক ট্যাপে অগ্রগতি জানাতে পারবে' },
]

const VALID_KEYS = new Set(STAFF_TASK_TOGGLES.map((t) => t.key))

export type StaffTaskToggleMap = Record<string, boolean>

export function parseStaffToggleMap(value: string | null | undefined): StaffTaskToggleMap {
  if (!value) return {}
  try {
    const parsed = JSON.parse(value) as unknown
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {}
    return parsed as StaffTaskToggleMap
  } catch {
    return {}
  }
}

export async function getStaffToggleMap(): Promise<StaffTaskToggleMap> {
  const row = await prisma.agentKvSetting.findUnique({ where: { key: STAFF_TASK_ENABLED_KV_KEY } })
  return parseStaffToggleMap(row?.value)
}

/** Resolved booleans for every known toggle (UI). */
export async function getResolvedStaffToggles(): Promise<Record<string, boolean>> {
  const map = await getStaffToggleMap()
  const out: Record<string, boolean> = {}
  for (const t of STAFF_TASK_TOGGLES) out[t.key] = map[t.key] !== false
  return out
}

export function isValidStaffToggleKey(key: string): boolean {
  return VALID_KEYS.has(key)
}

export async function setStaffToggle(key: string, enabled: boolean): Promise<Record<string, boolean>> {
  const map = await getStaffToggleMap()
  const next: StaffTaskToggleMap = { ...map }
  if (enabled) delete next[key]
  else next[key] = false

  await prisma.agentKvSetting.upsert({
    where: { key: STAFF_TASK_ENABLED_KV_KEY },
    create: { key: STAFF_TASK_ENABLED_KV_KEY, value: JSON.stringify(next) },
    update: { value: JSON.stringify(next) },
  })

  const out: Record<string, boolean> = {}
  for (const t of STAFF_TASK_TOGGLES) out[t.key] = next[t.key] !== false
  return out
}
