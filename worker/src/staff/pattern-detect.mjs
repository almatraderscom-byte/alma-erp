const DONE_STATUSES = new Set(['done', 'verified', 'done_unverified'])

/**
 * Looks back 7 days per staff: completion %, repeated low days.
 */
export async function detectStaffPatterns({ supabase }) {
  const since = new Date(Date.now() - 7 * 86_400_000).toLocaleDateString('en-CA', {
    timeZone: 'Asia/Dhaka',
  })

  const { data: rows } = await supabase
    .from('staff_tasks')
    .select('status, proposed_for, type, agent_staff(id, name)')
    .gte('proposed_for', since)
    .not('status', 'eq', 'cancelled')

  const byStaff = {}
  for (const r of rows ?? []) {
    if (r.type === 'learning') continue
    const s = r.agent_staff
    if (!s) continue
    byStaff[s.id] ??= { name: s.name, days: {}, total: 0, done: 0 }
    byStaff[s.id].total++
    if (DONE_STATUSES.has(r.status)) byStaff[s.id].done++
    const day = String(r.proposed_for).slice(0, 10)
    byStaff[s.id].days[day] ??= { total: 0, done: 0 }
    byStaff[s.id].days[day].total++
    if (DONE_STATUSES.has(r.status)) byStaff[s.id].days[day].done++
  }

  const flags = []
  for (const s of Object.values(byStaff)) {
    const weekPct = s.total ? Math.round((s.done / s.total) * 100) : 0
    const lowDays = Object.values(s.days).filter((d) => d.total && d.done / d.total < 0.5).length
    if (weekPct < 60) {
      flags.push({ name: s.name, type: 'low_week', detail: `সপ্তাহে ${weekPct}% completion` })
    }
    if (lowDays >= 3) {
      flags.push({ name: s.name, type: 'repeated_low', detail: `${lowDays} দিন ৫০% এর নিচে` })
    }
  }
  return flags
}
