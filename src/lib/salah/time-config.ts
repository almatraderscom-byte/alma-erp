import 'server-only'

import { prisma } from '@/lib/prisma'
import {
  DEFAULT_SALAH_TIMES,
  KV_KEY,
  WAQT_ORDER,
  type SalahTimeConfig,
  type WaqtKey,
  type WaqtTimes,
} from '@/lib/salah/time-config-shared'

export {
  DEFAULT_SALAH_TIMES,
  HM_PATTERN,
  isValidHm,
  KV_KEY,
  WAQT_LABELS,
  WAQT_ORDER,
  type SalahTimeConfig,
  type WaqtKey,
  type WaqtTimes,
} from '@/lib/salah/time-config-shared'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = prisma as any

function mergeConfig(parsed: Partial<SalahTimeConfig>): SalahTimeConfig {
  const out = { ...DEFAULT_SALAH_TIMES }
  for (const waqt of WAQT_ORDER) {
    if (parsed[waqt]) {
      out[waqt] = { ...out[waqt], ...parsed[waqt] }
    }
  }
  return out
}

export async function getSalahTimeConfig(): Promise<SalahTimeConfig> {
  const row = await db.agentKvSetting.findUnique({ where: { key: KV_KEY } })
  if (!row?.value) return { ...DEFAULT_SALAH_TIMES }
  try {
    const parsed = JSON.parse(row.value) as Partial<SalahTimeConfig>
    return mergeConfig(parsed)
  } catch {
    return { ...DEFAULT_SALAH_TIMES }
  }
}

export async function setSalahWaqtTimes(
  waqt: WaqtKey,
  times: Partial<WaqtTimes>,
): Promise<SalahTimeConfig> {
  const cfg = await getSalahTimeConfig()
  cfg[waqt] = { ...cfg[waqt], ...times }
  await db.agentKvSetting.upsert({
    where: { key: KV_KEY },
    create: { key: KV_KEY, value: JSON.stringify(cfg) },
    update: { value: JSON.stringify(cfg) },
  })
  return cfg
}

export async function setSalahTimeConfig(cfg: SalahTimeConfig): Promise<SalahTimeConfig> {
  const merged = mergeConfig(cfg)
  await db.agentKvSetting.upsert({
    where: { key: KV_KEY },
    create: { key: KV_KEY, value: JSON.stringify(merged) },
    update: { value: JSON.stringify(merged) },
  })
  return merged
}
