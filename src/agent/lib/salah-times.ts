/**
 * Dhaka prayer times for agent informational replies (matches worker fallback).
 */
import { todayYmdDhaka } from '@/lib/agent-api/dhaka-date'

export type WaqtKey = 'fajr' | 'dhuhr' | 'asr' | 'maghrib' | 'isha'

const WAQT_LABELS: Record<WaqtKey, string> = {
  fajr: 'ফজর',
  dhuhr: 'যোহর',
  asr: 'আসর',
  maghrib: 'মাগরিব',
  isha: 'ইশা',
}

function dhakaTime(ymd: string, h: number, min: number): Date {
  return new Date(`${ymd}T${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}:00+06:00`)
}

function formatTimeDhaka(d: Date): string {
  return d.toLocaleTimeString('bn-BD', {
    timeZone: 'Asia/Dhaka',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  })
}

/** Static Dhaka estimates — keep in sync with worker/src/salah/times.mjs fallback. */
export function getDhakaPrayerTimes(ymd = todayYmdDhaka()) {
  const windows: Record<WaqtKey, { start: Date; end: Date }> = {
    fajr:    { start: dhakaTime(ymd, 3, 43),  end: dhakaTime(ymd, 5, 11) },
    dhuhr:   { start: dhakaTime(ymd, 12, 3),  end: dhakaTime(ymd, 15, 17) },
    asr:     { start: dhakaTime(ymd, 15, 17), end: dhakaTime(ymd, 18, 48) },
    maghrib: { start: dhakaTime(ymd, 18, 48), end: dhakaTime(ymd, 20, 2) },
    isha:    { start: dhakaTime(ymd, 20, 2),  end: dhakaTime(ymd, 23, 2) },
  }

  return (Object.keys(windows) as WaqtKey[]).map((waqt) => ({
    waqt,
    label: WAQT_LABELS[waqt],
    start: windows[waqt].start.toISOString(),
    end: windows[waqt].end.toISOString(),
    startLabel: formatTimeDhaka(windows[waqt].start),
    endLabel: formatTimeDhaka(windows[waqt].end),
  }))
}

export function isPrayerTimeInquiry(text: string): boolean {
  const t = text.toLowerCase()
  return (
    /নামাজের\s*সময়|নামাজ\s*সময়|ওয়াক্তের\s*সময়|আজকে.*নামাজ|namaz.*time|salah.*time|prayer.*time|মুআজ্জিন|আযানের\s*সময়/i.test(t)
    || (/সময়|টাইম|time/i.test(t) && /নামাজ|namaz|salah|ওয়াক্ত|prayer/i.test(t))
  )
}
