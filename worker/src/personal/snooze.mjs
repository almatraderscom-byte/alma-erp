const BUSY_PATTERN =
  /\b(ব্যস্ত|পরে|এখন\s*না|not\s*now|busy|পরে\s*কথা|এখন\s*সময়\s*নেই|এখন\s*বলব\s*না)\b/i

export function dhakaDateYmd() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Dhaka' })
}

export function personalSnoozeKey(date = dhakaDateYmd()) {
  return `personal_snooze_${date}`
}

export function isPersonalSnoozeMessage(text) {
  const t = String(text ?? '').trim()
  if (!t || t.length > 120) return false
  return BUSY_PATTERN.test(t)
}

export async function isPersonalSnoozedToday(supabase) {
  const { data } = await supabase
    .from('agent_kv_settings')
    .select('value')
    .eq('key', personalSnoozeKey())
    .maybeSingle()
  return data?.value === 'true' || data?.value === true
}

export async function setPersonalSnoozeToday(supabase) {
  await supabase.from('agent_kv_settings').upsert({
    key: personalSnoozeKey(),
    value: 'true',
    updated_at: new Date().toISOString(),
  })
}
