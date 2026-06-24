/**
 * Attendance gate for staff-facing agent behaviour.
 *
 * The agent must only start tracking / asking a staff member once they have
 * actually checked in for the day. Task time is counted from check-in, NOT
 * from when the task was dispatched.
 *
 * Attendance lives in the ERP-managed Prisma table `AttendanceRecord` (PascalCase
 * table, camelCase columns). The correct join is:
 *
 *     AttendanceRecord.userId  ==  agent_staff.user_id   (both FK → User.id)
 *
 * `employeeId` on AttendanceRecord is the HR code (e.g. "EMP-51") and must NEVER
 * be used to join against agent_staff.user_id — that match always fails, which is
 * the historic bug that left every check-in gate empty (no presence nudges, no
 * follow-up, staff shown as AWAITING despite having checked in). The previous code
 * also queried a non-existent snake_case table `attendance_records` with snake_case
 * columns, so the gate silently returned nothing.
 */

export function dhakaToday() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Dhaka' })
}

/** Next calendar day (YYYY-MM-DD) after the given Dhaka date — for an exclusive upper bound. */
export function nextDhakaDate(ymd = dhakaToday()) {
  const [y, m, d] = ymd.split('-').map(Number)
  const dt = new Date(Date.UTC(y, m - 1, d))
  dt.setUTCDate(dt.getUTCDate() + 1)
  return dt.toISOString().slice(0, 10)
}

/**
 * Map of staffId → Date(checkInAt) for staff who have checked in today.
 * Staff without an attendance record (or without checkInAt) are absent from the map.
 *
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {Array<{ id: string, user_id?: string|null }>} staffList
 * @param {string} [businessId]
 * @returns {Promise<Map<string, Date>>}
 */
export async function getCheckedInMap(supabase, staffList, businessId = 'ALMA_LIFESTYLE') {
  const today = dhakaToday()
  const tomorrow = nextDhakaDate(today)
  const userIds = (staffList ?? []).map((s) => s.user_id).filter(Boolean)
  if (!userIds.length) return new Map()

  const { data, error } = await supabase
    .from('AttendanceRecord')
    .select('userId, checkInAt')
    .in('userId', userIds)
    .gte('attendanceDate', today)
    .lt('attendanceDate', tomorrow)
    .eq('businessId', businessId)

  if (error) {
    console.warn('[attendance] getCheckedInMap query failed:', error.message)
    return new Map()
  }

  const byUser = new Map()
  for (const r of data ?? []) {
    if (r.checkInAt) byUser.set(r.userId, new Date(r.checkInAt))
  }

  const result = new Map()
  for (const s of staffList ?? []) {
    if (s.user_id && byUser.has(s.user_id)) result.set(s.id, byUser.get(s.user_id))
  }
  return result
}

/**
 * checkInAt Date for a single staff member today, or null if not checked in.
 *
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {{ user_id?: string|null }} staff
 * @param {string} [businessId]
 * @returns {Promise<Date|null>}
 */
export async function getCheckInTime(supabase, staff, businessId = 'ALMA_LIFESTYLE') {
  if (!staff?.user_id) return null
  const today = dhakaToday()
  const tomorrow = nextDhakaDate(today)
  const { data, error } = await supabase
    .from('AttendanceRecord')
    .select('checkInAt')
    .eq('userId', staff.user_id)
    .gte('attendanceDate', today)
    .lt('attendanceDate', tomorrow)
    .eq('businessId', businessId)
    .order('checkInAt', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (error) {
    console.warn('[attendance] getCheckInTime query failed:', error.message)
    return null
  }
  return data?.checkInAt ? new Date(data.checkInAt) : null
}
