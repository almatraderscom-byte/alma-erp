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
      azan: w.azan.toISOString(),
      prayerStart: w.prayerStart.toISOString(),
      startLabel: formatTimeDhaka(w.start),
      endLabel: formatTimeDhaka(w.end),
      azanLabel: w.azanLabel,
      prayerLabel: w.prayerLabel,
    }
  })
}

/** Owner asks which prayers are done / left / status — NOT a schedule-only question */
export function isSalahStatusInquiry(text: string): boolean {
  const t = text.toLowerCase()
  return (
    /বাকি|baki|remaining|left|pending|কোন\s*কোন|kon\s*kon|কত\s*টা|koy\s*tay|কি\s*অবস্থা|status/i.test(t)
    && /নামাজ|namaz|salah|ওয়াক্ত|prayer|waqt/i.test(t)
  ) || (
    /পড়েছি\s*কি|পড়লাম\s*কি|porlam|porchi|porbo|পড়বো/i.test(t)
    && /নামাজ|namaz|salah|ওয়াক্ত|ফজর|যোহর|আসর|মাগরিব|ইশা|fajr|asr|maghrib|isha/i.test(t)
  ) || /সব\s*নামাজ|all\s*prayer|৫\s*ওয়াক্ত|5\s*waqt/i.test(t)
}

/** Owner asks for prayer schedule / azan times only */
export function isPrayerTimeInquiry(text: string): boolean {
  if (isSalahStatusInquiry(text)) return false
  const t = text.toLowerCase()
  return (
    /নামাজের\s*সময়|নামাজ\s*সময়|ওয়াক্তের\s*সময়|namaz.*time|salah.*time|prayer.*time|মুআজ্জিন|আযানের\s*সময়/i.test(t)
    || (/সময়|টাইম|time|gulo/i.test(t) && /নামাজ|namaz|salah|ওয়াক্ত|prayer|waqt/i.test(t))
    || /ajke.*namaz.*time|ajker.*namaz.*time|aajke.*namaz.*somoy/i.test(t)
  )
}
