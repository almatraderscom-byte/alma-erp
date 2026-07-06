/**
 * Per-waqt snooze state, stored in agent_kv_settings (no schema change, resets
 * naturally each day because the key embeds the Dhaka date).
 *
 * Three markers per waqt/day:
 *   - snooze30_used  : the one-time 30-min snooze has been consumed for this waqt.
 *   - reremind       : after a snooze lock expires, one reminder-with-buttons is
 *                      owed (value = ISO time it becomes due) BEFORE calls resume.
 *   - pre15          : the "15 min before jamat" heads-up reminder has been sent.
 *
 * Web side reads/writes via Prisma; the worker mirrors the SAME key strings via
 * Supabase (worker/src/salah/snooze-state.mjs). Keep the builders identical.
 */
import { prisma } from '@/lib/prisma'

export function snooze30UsedKey(ymd: string, waqt: string): string {
  return `salah_snooze30_used:${ymd}:${waqt}`
}
export function reremindKey(ymd: string, waqt: string): string {
  return `salah_reremind:${ymd}:${waqt}`
}
export function pre15Key(ymd: string, waqt: string): string {
  return `salah_pre15:${ymd}:${waqt}`
}

async function getKv(key: string): Promise<string | null> {
  const row = await prisma.agentKvSetting.findUnique({ where: { key }, select: { value: true } })
  return row?.value ?? null
}

async function setKv(key: string, value: string): Promise<void> {
  await prisma.agentKvSetting.upsert({
    where: { key },
    create: { key, value },
    update: { value },
  })
}

/** Has the one-time 30-min snooze already been used for this waqt today? */
export async function is30SnoozeUsed(ymd: string, waqt: string): Promise<boolean> {
  return (await getKv(snooze30UsedKey(ymd, waqt))) === '1'
}

export async function mark30SnoozeUsed(ymd: string, waqt: string): Promise<void> {
  await setKv(snooze30UsedKey(ymd, waqt), '1')
}

/** Owe a "reminder before calls resume" at `dueAt` (set when a snooze is applied). */
export async function setReremindMarker(ymd: string, waqt: string, dueAt: Date): Promise<void> {
  await setKv(reremindKey(ymd, waqt), dueAt.toISOString())
}
