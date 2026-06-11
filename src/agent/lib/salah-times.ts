/**
 * Dhaka prayer times for agent informational replies.
 */
import { todayYmdDhaka } from '@/lib/agent-api/dhaka-date'
import { getDhakaSchedule } from '@/agent/lib/dhaka-schedule'

export type WaqtKey = 'fajr' | 'dhuhr' | 'asr' | 'maghrib' | 'isha'

function formatTimeDhaka(d: Date): string {
  return d.toLocaleTimeString('bn-BD', {
    timeZone: 'Asia/Dhaka',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  })
}

export async function getDhakaPrayerTimes(ymd = todayYmdDhaka()) {
  const schedule = await getDhakaSchedule(ymd)
  const order: WaqtKey[] = ['fajr', 'dhuhr', 'asr', 'maghrib', 'isha']

  return order.map((waqt) => {
    const w = schedule[waqt]!
    return {
      waqt,
      label: w.label,
      start: w.start.toISOString(),
      end: w.end.toISOString(),
      startLabel: formatTimeDhaka(w.start),
      endLabel: formatTimeDhaka(w.end),
      azanLabel: w.azanLabel,
    }
  })
}

export function isPrayerTimeInquiry(text: string): boolean {
  const t = text.toLowerCase()
  return (
    /নামাজের\s*সময়|নামাজ\s*সময়|ওয়াক্তের\s*সময়|আজকে.*নামাজ|namaz.*time|salah.*time|prayer.*time|মুআজ্জিন|আযানের\s*সময়/i.test(t)
    || (/সময়|টাইম|time|gulo/i.test(t) && /নামাজ|namaz|salah|ওয়াক্ত|prayer|waqt/i.test(t))
    || /ajke.*namaz|aajke.*namaz|ajker.*namaz/i.test(t)
  )
}
