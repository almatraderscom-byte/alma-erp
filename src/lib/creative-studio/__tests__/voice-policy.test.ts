import { describe, expect, it } from 'vitest'
import {
  OWNER_STUDIO_USAGE_CONTEXT,
  assertOwnerVoiceUsage,
  canActivateVoiceVersion,
  isWithinPaidPreviewCeiling,
  ownerVoicePolicyBlockReason,
  providerEstimateUsd,
} from '@/lib/creative-studio/voice-policy'
import { audioCostBdt, audioProviderLabel } from '@/lib/creative-studio/audio-lab'

const allowed = {
  authenticatedOwnerId: 'owner-1',
  voiceOwnerId: 'owner-1',
  ownerOnly: true,
  usageContext: OWNER_STUDIO_USAGE_CONTEXT,
  autonomous: false,
  customerFacing: false,
  status: 'active',
  activeVersionId: 'version-2',
  requestedVersionId: 'version-2',
}

describe('owner voice policy', () => {
  it('allows only the active owner version in owner Studio', () => {
    expect(ownerVoicePolicyBlockReason(allowed)).toBeNull()
    expect(() => assertOwnerVoiceUsage(allowed)).not.toThrow()
  })

  it('blocks direct autonomous and customer-facing attempts', () => {
    expect(ownerVoicePolicyBlockReason({ ...allowed, usageContext: 'assistant' })).toBe('owner_studio_context_required')
    expect(ownerVoicePolicyBlockReason({ ...allowed, autonomous: true })).toBe('autonomous_use_forbidden')
    expect(ownerVoicePolicyBlockReason({ ...allowed, customerFacing: true })).toBe('customer_facing_use_forbidden')
  })

  it('blocks other owners, revoked versions and stale active ids', () => {
    expect(ownerVoicePolicyBlockReason({ ...allowed, authenticatedOwnerId: 'owner-2' })).toBe('owner_mismatch')
    expect(ownerVoicePolicyBlockReason({ ...allowed, status: 'revoked' })).toBe('voice_not_active')
    expect(ownerVoicePolicyBlockReason({ ...allowed, requestedVersionId: 'version-1' })).toBe('active_version_mismatch')
  })

  it('activates only provider-ready immutable versions', () => {
    expect(canActivateVoiceVersion('ready', 'provider-id')).toBe(true)
    expect(canActivateVoiceVersion('active', 'provider-id')).toBe(true)
    expect(canActivateVoiceVersion('pending', 'provider-id')).toBe(false)
    expect(canActivateVoiceVersion('ready', null)).toBe(false)
  })

  it('uses whole-taka estimates and enforces the one-dollar preview ceiling', () => {
    expect(providerEstimateUsd(125)).toBe(1)
    expect(isWithinPaidPreviewCeiling(125)).toBe(true)
    expect(isWithinPaidPreviewCeiling(126)).toBe(false)
    expect(audioCostBdt('dub', 60)).toBe(38)
    expect(audioCostBdt('voice_change', 30)).toBe(19)
    expect(audioProviderLabel('voice_change')).toContain('Voice Changer')
  })
})
