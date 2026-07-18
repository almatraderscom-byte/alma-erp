import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'
import { prisma } from '@/lib/prisma'

export const OFFICE_CALL_DEVICE_PROVIDERS = ['apns_voip', 'fcm'] as const
export type OfficeCallDeviceProvider = (typeof OFFICE_CALL_DEVICE_PROVIDERS)[number]
export type OfficeCallDevicePlatform = 'ios' | 'android'
export type OfficeCallDeviceEnvironment = 'sandbox' | 'production'

export function officeCallDeviceEncryptionConfigured(): boolean {
  return Boolean(process.env.OFFICE_CALL_DEVICE_KEY?.trim() || process.env.NEXTAUTH_SECRET?.trim())
}

function encryptionKey(): Buffer {
  const source = process.env.OFFICE_CALL_DEVICE_KEY?.trim() || process.env.NEXTAUTH_SECRET?.trim()
  if (!source) throw new Error('office_call_device_key_unconfigured')
  return createHash('sha256').update(source).digest()
}

function tokenHash(provider: OfficeCallDeviceProvider, token: string): string {
  return createHash('sha256').update(`${provider}:${token}`).digest('hex')
}

function encryptToken(token: string): string {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', encryptionKey(), iv)
  const encrypted = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return `v1:${iv.toString('base64url')}:${tag.toString('base64url')}:${encrypted.toString('base64url')}`
}

export function decryptOfficeCallDeviceToken(value: string): string {
  const [version, ivRaw, tagRaw, encryptedRaw] = value.split(':')
  if (version !== 'v1' || !ivRaw || !tagRaw || !encryptedRaw) throw new Error('invalid_device_token_ciphertext')
  const iv = Buffer.from(ivRaw, 'base64url')
  const tag = Buffer.from(tagRaw, 'base64url')
  if (iv.length !== 12 || tag.length !== 16) throw new Error('invalid_device_token_ciphertext')
  const decipher = createDecipheriv('aes-256-gcm', encryptionKey(), iv)
  decipher.setAuthTag(tag)
  return Buffer.concat([
    decipher.update(Buffer.from(encryptedRaw, 'base64url')),
    decipher.final(),
  ]).toString('utf8')
}

function validateToken(provider: OfficeCallDeviceProvider, token: string): boolean {
  if (token.length < 20 || token.length > 4096) return false
  return provider !== 'apns_voip' || /^[a-f0-9]{64,}$/i.test(token)
}

export async function registerOfficeCallDevice(args: {
  userId: string
  businessId: string
  installationId: string
  platform: OfficeCallDevicePlatform
  environment: OfficeCallDeviceEnvironment
  provider: OfficeCallDeviceProvider
  token: string
  appBuild?: string | null
  buildSha?: string | null
}) {
  const token = args.token.trim()
  const installationId = args.installationId.trim()
  if (!installationId || installationId.length > 180) return { ok: false, error: 'invalid_installation_id' } as const
  if (!validateToken(args.provider, token)) return { ok: false, error: 'invalid_provider_token' } as const
  if ((args.platform === 'ios') !== (args.provider === 'apns_voip')) {
    return { ok: false, error: 'provider_platform_mismatch' } as const
  }
  const providerTokenHash = tokenHash(args.provider, token)
  const providerTokenEnc = encryptToken(token)
  const now = new Date()
  const device = await prisma.$transaction(async (tx) => {
    // Rotation: one installation/provider owns one current token. The encrypted
    // previous token is erased, not merely disabled.
    await tx.officeCallDevice.deleteMany({
      where: {
        userId: args.userId,
        installationId,
        provider: args.provider,
        providerTokenHash: { not: providerTokenHash },
      },
    })
    return tx.officeCallDevice.upsert({
      where: { providerTokenHash },
      create: {
        userId: args.userId,
        businessId: args.businessId,
        installationId,
        platform: args.platform,
        environment: args.environment,
        provider: args.provider,
        providerTokenHash,
        providerTokenEnc,
        appBuild: args.appBuild?.slice(0, 80) || null,
        buildSha: args.buildSha?.slice(0, 80) || null,
        active: true,
        lastSeenAt: now,
      },
      update: {
        userId: args.userId,
        businessId: args.businessId,
        installationId,
        platform: args.platform,
        environment: args.environment,
        providerTokenEnc,
        appBuild: args.appBuild?.slice(0, 80) || null,
        buildSha: args.buildSha?.slice(0, 80) || null,
        active: true,
        invalidatedAt: null,
        lastSeenAt: now,
      },
      select: { id: true },
    })
  })
  return { ok: true, deviceId: device.id } as const
}

export async function unregisterOfficeCallInstallation(args: {
  userId: string
  installationId: string
}) {
  const result = await prisma.officeCallDevice.deleteMany({
    where: { userId: args.userId, installationId: args.installationId },
  })
  return result.count
}

export async function invalidateOfficeCallDeviceToken(provider: OfficeCallDeviceProvider, token: string) {
  const now = new Date()
  await prisma.officeCallDevice.updateMany({
    where: { providerTokenHash: tokenHash(provider, token) },
    data: { active: false, invalidatedAt: now, providerTokenEnc: null },
  })
}

export async function getOfficeCallDeliveryDevices(args: {
  userId: string
  businessId: string
}) {
  const rows = await prisma.officeCallDevice.findMany({
    where: {
      userId: args.userId,
      businessId: args.businessId,
      active: true,
      invalidatedAt: null,
      providerTokenEnc: { not: null },
    },
    select: {
      id: true,
      platform: true,
      environment: true,
      provider: true,
      providerTokenEnc: true,
      appBuild: true,
      buildSha: true,
    },
  })
  return rows.flatMap((row) => {
    try {
      return [{
        id: row.id,
        platform: row.platform as OfficeCallDevicePlatform,
        environment: row.environment as OfficeCallDeviceEnvironment,
        provider: row.provider as OfficeCallDeviceProvider,
        token: decryptOfficeCallDeviceToken(row.providerTokenEnc!),
        appBuild: row.appBuild,
        buildSha: row.buildSha,
      }]
    } catch {
      return []
    }
  })
}
