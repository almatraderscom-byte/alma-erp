import { prisma } from '@/lib/prisma'

export type CsGlobalMode = 'off' | 'shadow' | 'auto_night' | 'auto'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = prisma as any

export async function getCsMode(): Promise<CsGlobalMode> {
  const row = await db.agentKvSetting.findUnique({ where: { key: 'cs_mode' } })
  const v = String(row?.value ?? 'off')
  if (v === 'shadow' || v === 'auto_night' || v === 'auto') return v
  return 'off'
}

export async function setCsMode(mode: CsGlobalMode): Promise<void> {
  await db.agentKvSetting.upsert({
    where: { key: 'cs_mode' },
    update: { value: mode },
    create: { key: 'cs_mode', value: mode },
  })
}

/** Dhaka local hour 0–23 */
function dhakaHour(now = new Date()): number {
  return Number(now.toLocaleString('en-US', { timeZone: 'Asia/Dhaka', hour: 'numeric', hour12: false }))
}

/** Whether outbound CS replies are permitted for this conversation right now. */
export async function csReplyPermitted(conv: {
  mode: string
  status: string
}): Promise<{ permitted: boolean; effectiveMode: CsGlobalMode | 'human' }> {
  if (conv.mode === 'human' || conv.status === 'human') {
    return { permitted: false, effectiveMode: 'human' }
  }

  const global = await getCsMode()
  if (global === 'off') return { permitted: false, effectiveMode: global }

  if (global === 'shadow') return { permitted: true, effectiveMode: 'shadow' }

  if (global === 'auto_night') {
    const h = dhakaHour()
    const isNight = h >= 22 || h < 9
    return { permitted: isNight, effectiveMode: isNight ? 'auto' : 'shadow' }
  }

  return { permitted: true, effectiveMode: 'auto' }
}
