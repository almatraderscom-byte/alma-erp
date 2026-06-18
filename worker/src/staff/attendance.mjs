/**
 * Attendance gate for staff-facing agent behaviour.
 *
 * The agent must only start tracking / asking a staff member once they have
 * actually checked in for the day. Task time is counted from check-in, NOT
 * from when the task was dispatched.
 *
 * Attendance lives in `attendance_records`, keyed by employee_id (= agent_staff.user_id),
 * attendance_date (Dhaka YYYY-MM-DD) and business_id.
 */

export function dhakaToday() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Dhaka' })
}

/**
 * Map of staffId → Date(check_in_at) for staff who have checked in today.
 * Staff without an attendance record (or without check_in_at) are absent from the map.
 *
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {Array<{ id: string, user_id?: string|null }>} staffList
 * @param {string} [businessId]
 * @returns {Promise<Map<string, Date>>}
 */
export async function getCheckedInMap(supabase, staffList, businessId = 'ALMA_LIFESTYLE') {
  const today = dhakaToday()
  const userIds = (staffList ?? []).map((s) => s.user_id).filter(Boolean)
  if (!userIds.length) return new Map()

  const { data } = await supabase
    .from('attendance_records')
    .select('employee_id, check_in_at')
    .in('employee_id', userIds)
    .eq('attendance_date', today)
    .eq('business_id', businessId)

  const byUser = new Map()
  for (const r of data ?? []) {
    if (r.check_in_at) byUser.set(r.employee_id, new Date(r.check_in_at))
  }

  const result = new Map()
  for (const s of staffList ?? []) {
    if (s.user_id && byUser.has(s.user_id)) result.set(s.id, byUser.get(s.user_id))
  }
  return result
}

/**
 * check_in_at Date for a single staff member today, or null if not checked in.
 *
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {{ user_id?: string|null }} staff
 * @param {string} [businessId]
 * @returns {Promise<Date|null>}
 */
export async function getCheckInTime(supabase, staff, businessId = 'ALMA_LIFESTYLE') {
  if (!staff?.user_id) return null
  const { data } = await supabase
    .from('attendance_records')
    .select('check_in_at')
    .eq('employee_id', staff.user_id)
    .eq('attendance_date', dhakaToday())
    .eq('business_id', businessId)
    .maybeSingle()
  return data?.check_in_at ? new Date(data.check_in_at) : null
}
