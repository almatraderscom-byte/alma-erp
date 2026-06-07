import { prisma } from '@/lib/prisma'
import { smsProviderConfigured } from '@/lib/sms/provider'
import type { SmsType } from '@/lib/sms/types'
import {
  ALL_SMS_TYPES,
  DEFAULT_SMS_ENABLED_TYPES,
  SMS_TYPE_CATALOG,
  defaultEnabledTypesJson,
  parseEnabledTypesJson,
  serializeEnabledTypes,
  type SmsTypeCatalogItem,
} from '@/lib/sms/catalog'

export {
  ALL_SMS_TYPES,
  DEFAULT_SMS_ENABLED_TYPES,
  SMS_TYPE_CATALOG,
  defaultEnabledTypesJson,
  parseEnabledTypesJson,
  serializeEnabledTypes,
  type SmsTypeCatalogItem,
}

const SMS_TYPE_SET = new Set<SmsType>(ALL_SMS_TYPES)

let typesColumnReady: boolean | null = null

/** Idempotent — adds enabledTypesJson if production DB predates migration. */
export async function ensureSmsTypesColumn() {
  if (typesColumnReady) return
  try {
    await prisma.$executeRawUnsafe(
      'ALTER TABLE "SmsSetting" ADD COLUMN IF NOT EXISTS "enabledTypesJson" TEXT',
    )
    typesColumnReady = true
  } catch (err) {
    console.error('[sms] ensureSmsTypesColumn failed', err)
  }
}

export async function findSmsSetting(businessId: string) {
  await ensureSmsTypesColumn()
  try {
    return await prisma.smsSetting.findUnique({ where: { businessId } })
  } catch (err) {
    console.error('[sms] findSmsSetting fallback', err)
    const rows = await prisma.$queryRaw<
      Array<{
        id: string
        businessId: string
        enabled: boolean
        senderId: string | null
        updatedById: string | null
        createdAt: Date
        updatedAt: Date
      }>
    >`SELECT "id", "businessId", "enabled", "senderId", "updatedById", "createdAt", "updatedAt"
      FROM "SmsSetting" WHERE "businessId" = ${businessId} LIMIT 1`
    const row = rows[0]
    if (!row) return null
    return { ...row, enabledTypesJson: null }
  }
}

export async function smsEnabledForBusiness(businessId?: string | null) {
  if (!smsProviderConfigured()) return false
  const id = businessId || 'GLOBAL'
  const setting = await findSmsSetting(id)
  if (setting) return setting.enabled
  if (id !== 'GLOBAL') {
    const global = await findSmsSetting('GLOBAL')
    if (global) return global.enabled
  }
  return process.env.SMS_ENABLED === 'true'
}

export async function getEnabledSmsTypes(businessId?: string | null): Promise<Set<SmsType>> {
  const id = businessId || 'GLOBAL'
  const setting = await findSmsSetting(id)
  if (setting?.enabledTypesJson) {
    return new Set(parseEnabledTypesJson(setting.enabledTypesJson))
  }
  if (id !== 'GLOBAL') {
    const global = await findSmsSetting('GLOBAL')
    if (global?.enabledTypesJson) {
      return new Set(parseEnabledTypesJson(global.enabledTypesJson))
    }
  }
  return new Set(DEFAULT_SMS_ENABLED_TYPES)
}

export async function isSmsTypeActive(
  businessId: string | null | undefined,
  type: SmsType,
): Promise<boolean> {
  if (!SMS_TYPE_SET.has(type)) return false
  if (!(await smsEnabledForBusiness(businessId))) return false
  const enabled = await getEnabledSmsTypes(businessId)
  return enabled.has(type)
}

export type SmsSettingDto = {
  businessId: string
  enabled: boolean
  senderId: string
  enabledTypes: SmsType[]
}

export function smsSettingDto(
  businessId: string,
  row: {
    enabled: boolean
    senderId: string | null
    enabledTypesJson: string | null
  } | null,
  envSenderId?: string,
): SmsSettingDto {
  return {
    businessId,
    enabled: row?.enabled ?? false,
    senderId: row?.senderId || envSenderId || '',
    enabledTypes: parseEnabledTypesJson(row?.enabledTypesJson),
  }
}
