/**
 * Sir's Dhaka mosque schedule (+06:00) — reads configurable times from KV.
 */
import { getSalahTimeConfig } from '@/lib/salah/time-config'
import { buildDhakaSchedule, type WaqtSchedule } from '@/lib/salah/build-schedule'
import { isFridayDhaka, dhakaInstant } from '@/lib/salah/dhaka-utils'

export { isFridayDhaka, dhakaInstant }
export type { WaqtSchedule }

export async function getDhakaSchedule(ymd: string): Promise<Record<string, WaqtSchedule>> {
  const cfg = await getSalahTimeConfig()
  return buildDhakaSchedule(ymd, cfg, isFridayDhaka(ymd))
}
