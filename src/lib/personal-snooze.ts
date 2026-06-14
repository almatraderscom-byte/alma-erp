import { prisma } from '@/lib/prisma'
import { todayYmdDhaka } from '@/lib/agent-api/dhaka-date'

const BUSY_PATTERN =
  /\b(ব্যস্ত|পরে|এখন\s*না|not\s*now|busy|পরে\s*কথা|এখন\s*সময়\s*নেই|এখন\s*বলব\s*না)\b/i

export function personalSnoozeKey(dateYmd?: string): string {
  return `personal_snooze_${dateYmd ?? todayYmdDhaka()}`
}

/** Owner signals "not now" — snooze proactive personal check-ins for the rest of the day. */
export function isPersonalSnoozeMessage(text: string): boolean {
  const t = text.trim()
  if (!t || t.length > 120) return false
  return BUSY_PATTERN.test(t)
}

export async function setPersonalSnoozeToday(): Promise<void> {
  const key = personalSnoozeKey()
  await prisma.agentKvSetting.upsert({
    where: { key },
    create: { key, value: 'true' },
    update: { value: 'true' },
  })
}

export async function isPersonalSnoozedToday(): Promise<boolean> {
  const row = await prisma.agentKvSetting.findUnique({
    where: { key: personalSnoozeKey() },
    select: { value: true },
  })
  return row?.value === 'true'
}
