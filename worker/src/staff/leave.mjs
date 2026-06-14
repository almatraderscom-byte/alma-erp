/**
 * Staff leave helpers (Supabase — worker has no Prisma).
 */

export function dhakaToday() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Dhaka' })
}

/** @param {import('@supabase/supabase-js').SupabaseClient} supabase */
export async function isStaffOnLeaveSb(supabase, staffId, dateYmd) {
  const date = dateYmd ?? dhakaToday()
  const { data } = await supabase
    .from('staff_leave')
    .select('id')
    .eq('staff_id', staffId)
    .eq('status', 'approved')
    .lte('start_date', date)
    .gte('end_date', date)
    .maybeSingle()
  return Boolean(data)
}

/** Expand approved leave ranges into per-staff date sets (YYYY-MM-DD). */
export function expandLeaveRanges(leaves) {
  /** @type {Record<string, Set<string>>} */
  const byStaff = {}
  for (const l of leaves ?? []) {
    byStaff[l.staff_id] ??= new Set()
    const start = new Date(`${l.start_date}T12:00:00+06:00`)
    const end = new Date(`${l.end_date}T12:00:00+06:00`)
    for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
      byStaff[l.staff_id].add(d.toLocaleDateString('en-CA', { timeZone: 'Asia/Dhaka' }))
    }
  }
  return byStaff
}

/** @param {import('@supabase/supabase-js').SupabaseClient} supabase */
export async function loadLeaveDatesSince(supabase, sinceYmd) {
  const { data } = await supabase
    .from('staff_leave')
    .select('staff_id, start_date, end_date')
    .eq('status', 'approved')
    .gte('end_date', sinceYmd)
  return expandLeaveRanges(data)
}

export function leaveRequestButton() {
  return { text: '🌿 ছুটির আবেদন', callback_data: 'leave_request' }
}
