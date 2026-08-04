import { describe, expect, it } from 'vitest'
import {
  DEFAULT_STUDIO_RETENTION_POLICY,
  normalizeStudioRetentionPolicy,
  retentionDeletionEligibility,
} from '@/lib/creative-studio/retention-policy'

describe('CSE7 retention safety', () => {
  it('uses a 30-day default plus a durable 24-hour verification grace', () => {
    expect(DEFAULT_STUDIO_RETENTION_POLICY).toEqual({
      archiveEnabled: true,
      deleteOriginalsEnabled: true,
      retentionDays: 30,
      verificationGraceHours: 24,
    })
    expect(normalizeStudioRetentionPolicy({ retentionDays: 90 }))
      .toMatchObject({ retentionDays: 90, verificationGraceHours: 24 })
    expect(() => normalizeStudioRetentionPolicy({ retentionDays: 1 }))
      .toThrow('invalid_retention_days')
  })

  it('never deletes before both retention and durable Drive verification pass', () => {
    const now = new Date('2026-08-31T00:00:00.000Z')
    const common = {
      policy: DEFAULT_STUDIO_RETENTION_POLICY,
      createdAt: new Date('2026-07-01T00:00:00.000Z'),
      now,
    }
    expect(retentionDeletionEligibility({
      ...common,
      verifiedAt: null,
    })).toEqual({ eligible: false, reason: 'durable_verification_required' })
    expect(retentionDeletionEligibility({
      ...common,
      verifiedAt: new Date('2026-08-30T12:00:00.000Z'),
    })).toEqual({ eligible: false, reason: 'verification_grace_active' })
    expect(retentionDeletionEligibility({
      ...common,
      verifiedAt: new Date('2026-08-29T00:00:00.000Z'),
    })).toEqual({ eligible: true, reason: 'verified_archive_retention_elapsed' })
  })

  it('honors the owner deletion kill switch even with a verified receipt', () => {
    expect(retentionDeletionEligibility({
      policy: { ...DEFAULT_STUDIO_RETENTION_POLICY, deleteOriginalsEnabled: false },
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      verifiedAt: new Date('2026-01-02T00:00:00.000Z'),
      now: new Date('2026-07-25T00:00:00.000Z'),
    })).toEqual({ eligible: false, reason: 'deletion_disabled' })
  })
})
