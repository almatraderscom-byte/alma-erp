/**
 * CSE5 owner-voice boundary. The cloned owner voice is deliberately unusable
 * outside an explicit, owner-authenticated Creative Studio request.
 */

export const OWNER_STUDIO_USAGE_CONTEXT = 'owner_studio' as const
export const OWNER_VOICE_PROVIDER = 'elevenlabs' as const

export type OwnerVoiceUsageInput = {
  authenticatedOwnerId?: string | null
  voiceOwnerId?: string | null
  ownerOnly?: boolean
  usageContext?: string | null
  autonomous?: boolean
  customerFacing?: boolean
  status?: string | null
  activeVersionId?: string | null
  requestedVersionId?: string | null
}

export type OwnerVoicePolicyReason =
  | 'owner_auth_required'
  | 'owner_mismatch'
  | 'owner_only_required'
  | 'owner_studio_context_required'
  | 'autonomous_use_forbidden'
  | 'customer_facing_use_forbidden'
  | 'voice_not_active'
  | 'active_version_mismatch'

export function ownerVoicePolicyBlockReason(input: OwnerVoiceUsageInput): OwnerVoicePolicyReason | null {
  if (!input.authenticatedOwnerId) return 'owner_auth_required'
  if (!input.voiceOwnerId || input.voiceOwnerId !== input.authenticatedOwnerId) return 'owner_mismatch'
  if (input.ownerOnly !== true) return 'owner_only_required'
  if (input.usageContext !== OWNER_STUDIO_USAGE_CONTEXT) return 'owner_studio_context_required'
  if (input.autonomous === true) return 'autonomous_use_forbidden'
  if (input.customerFacing === true) return 'customer_facing_use_forbidden'
  if (input.status !== 'active') return 'voice_not_active'
  if (!input.activeVersionId || input.activeVersionId !== input.requestedVersionId) return 'active_version_mismatch'
  return null
}

export function assertOwnerVoiceUsage(input: OwnerVoiceUsageInput): void {
  const blocked = ownerVoicePolicyBlockReason(input)
  if (blocked) throw new Error(blocked)
}

export function canActivateVoiceVersion(status: string | null | undefined, providerVoiceId: string | null | undefined): boolean {
  return Boolean(providerVoiceId && (status === 'ready' || status === 'active'))
}

export function providerEstimateUsd(costBdt: number, usdToBdt = 125): number {
  const safeRate = Number.isFinite(usdToBdt) && usdToBdt > 0 ? usdToBdt : 125
  return Math.round((Math.max(0, Math.round(costBdt)) / safeRate) * 10_000) / 10_000
}

export function isWithinPaidPreviewCeiling(costBdt: number, ceilingUsd = 1, usdToBdt = 125): boolean {
  return providerEstimateUsd(costBdt, usdToBdt) <= ceilingUsd
}
