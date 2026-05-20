import { prisma } from '@/lib/prisma'
import { logTelegram } from '@/lib/telegram-notification/telegram-log'

async function loadTelegramOpsSetting(businessId: string) {
  const existing = await prisma.telegramOpsSetting.findUnique({ where: { businessId } })
  if (existing) return existing
  return prisma.telegramOpsSetting.create({ data: { businessId } })
}

const CHAT_ID_RE = /^-?\d{5,20}$/

export type OwnerRoutingSource = 'disabled' | 'database' | 'env_fallback' | 'none'

export function parseOwnerChatIdsFromRaw(raw: string | null | undefined): string[] {
  return (raw || '')
    .split(/[,;\n\r]+/)
    .map(s => s.trim())
    .filter(Boolean)
}

/** Env fallback — supports TELEGRAM_OWNER_CHAT_IDS and legacy OWNER_TELEGRAM_CHAT_IDS. */
export function envOwnerChatIdsRaw(): string {
  return (
    process.env.TELEGRAM_OWNER_CHAT_IDS
    || process.env.OWNER_TELEGRAM_CHAT_IDS
    || ''
  ).trim()
}

/** Valid numeric Telegram chat IDs only (user, group, supergroup). */
export function normalizeOwnerChatIds(ids: string[]): string[] {
  return [...new Set(ids.map(id => id.trim()).filter(id => CHAT_ID_RE.test(id)))]
}

export type OwnerRoutingMeta = {
  chatIds: string[]
  source: OwnerRoutingSource
  dbIds: string[]
  envIds: string[]
  invalidDbTokens: string[]
  invalidEnvTokens: string[]
}

/**
 * Priority: database owner IDs first; env fallback only when DB has no valid IDs.
 */
export async function resolveOwnerChatIdsWithMeta(businessId: string): Promise<OwnerRoutingMeta> {
  const setting = await loadTelegramOpsSetting(businessId)
  const dbTokens = parseOwnerChatIdsFromRaw(setting.ownerChatIds)
  const envTokens = parseOwnerChatIdsFromRaw(envOwnerChatIdsRaw())
  const dbIds = normalizeOwnerChatIds(dbTokens)
  const envIds = normalizeOwnerChatIds(envTokens)
  const invalidDbTokens = dbTokens.filter(id => !dbIds.includes(id))
  const invalidEnvTokens = envTokens.filter(id => !envIds.includes(id))

  if (!setting.enabled) {
    return { chatIds: [], source: 'disabled', dbIds, envIds, invalidDbTokens, invalidEnvTokens }
  }

  if (dbIds.length > 0) {
    logTelegram('info', 'telegram.owner.routing', {
      businessId,
      source: 'database',
      recipientCount: dbIds.length,
      envFallbackAvailable: envIds.length > 0,
    })
    return { chatIds: dbIds, source: 'database', dbIds, envIds, invalidDbTokens, invalidEnvTokens }
  }

  if (envIds.length > 0) {
    logTelegram('warn', 'telegram.owner.routing', {
      businessId,
      source: 'env_fallback',
      recipientCount: envIds.length,
      invalidDbTokens: invalidDbTokens.length,
    })
    return { chatIds: envIds, source: 'env_fallback', dbIds, envIds, invalidDbTokens, invalidEnvTokens }
  }

  logTelegram('error', 'telegram.owner.routing', {
    businessId,
    source: 'none',
    invalidDbTokens,
    invalidEnvTokens,
  })
  return { chatIds: [], source: 'none', dbIds, envIds, invalidDbTokens, invalidEnvTokens }
}

export async function resolveOwnerChatIds(businessId: string): Promise<string[]> {
  const meta = await resolveOwnerChatIdsWithMeta(businessId)
  return meta.chatIds
}
