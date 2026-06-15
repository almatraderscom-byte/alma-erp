/** Client-safe salah time types/constants — no Prisma / server imports. */

export const KV_KEY = 'salah_time_config'

export type WaqtKey = 'fajr' | 'dhuhr' | 'asr' | 'maghrib' | 'isha'

export type WaqtTimes = {
  /** HH:MM 24h Dhaka — wakto / azan start */
  azan: string
  /** HH:MM — jamat (duty-window anchor) */
  prayer: string
  /** HH:MM — wakto end */
  end: string
}

export type SalahTimeConfig = Record<WaqtKey, WaqtTimes>

/** Matches worker/src/salah/dhaka-schedule.mjs hardcoded values (pre-edit behavior). */
export const DEFAULT_SALAH_TIMES: SalahTimeConfig = {
  fajr: { azan: '03:43', prayer: '03:43', end: '05:11' },
  dhuhr: { azan: '12:30', prayer: '13:30', end: '15:17' },
  asr: { azan: '16:30', prayer: '17:00', end: '18:30' },
  maghrib: { azan: '18:45', prayer: '18:45', end: '20:13' },
  isha: { azan: '20:13', prayer: '20:45', end: '23:00' },
}

export const WAQT_ORDER: WaqtKey[] = ['fajr', 'dhuhr', 'asr', 'maghrib', 'isha']

export const WAQT_LABELS: Record<WaqtKey, string> = {
  fajr: 'ফজর',
  dhuhr: 'যোহর',
  asr: 'আসর',
  maghrib: 'মাগরিব',
  isha: 'ইশা',
}

export const HM_PATTERN = /^([01]?\d|2[0-3]):[0-5]\d$/

export function isValidHm(value: string): boolean {
  return HM_PATTERN.test(value.trim())
}
