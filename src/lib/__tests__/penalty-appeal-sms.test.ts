import { describe, expect, it, vi } from 'vitest'

const { queueSmsAndFlush } = vi.hoisted(() => ({ queueSmsAndFlush: vi.fn() }))

vi.mock('@/lib/sms/queue', () => ({
  queueSmsAndFlush,
  flushQueuedSms: vi.fn(),
}))

vi.mock('@/lib/prisma', () => ({ prisma: {} }))

import { penaltyAppealReviewedSms } from '@/lib/sms/templates'
import { enqueuePenaltyAppealReviewedSms } from '@/services/sms/events'

describe('penalty appeal result SMS', () => {
  it('uses the waiver id as the durable SMS idempotency key', () => {
    enqueuePenaltyAppealReviewedSms({
      businessId: 'ALMA_LIFESTYLE',
      phone: '01700000000',
      waiverId: 'waiver-exact-1',
      action: 'APPROVE',
      originalPenalty: 500,
      requestedReduction: 500,
      approvedReduction: 250,
      remainingPenalty: 250,
    })

    expect(queueSmsAndFlush).toHaveBeenCalledWith(expect.objectContaining({
      contentId: 'penalty-appeal-reviewed:waiver-exact-1',
      cooldownMinutes: 0,
    }))
  })

  it('makes a custom partial approval unambiguous to the staff member', () => {
    const message = penaltyAppealReviewedSms({
      action: 'APPROVE',
      partial: true,
      originalPenalty: 500,
      requestedReduction: 500,
      approvedReduction: 250,
      remainingPenalty: 250,
      fineLabel: 'No check-out penalty',
      fineDate: '2026-08-08',
    })

    expect(message).toContain('আংশিকভাবে অনুমোদিত')
    expect(message).toContain('চেয়েছিলেন ৳500')
    expect(message).toContain('wallet credit ৳250')
    expect(message).toContain('বাকি penalty ৳250')
  })

  it('labels a full approval separately and reports zero remaining penalty', () => {
    const message = penaltyAppealReviewedSms({
      action: 'APPROVE',
      partial: false,
      originalPenalty: 500,
      requestedReduction: 500,
      approvedReduction: 500,
      remainingPenalty: 0,
    })

    expect(message).toContain('সম্পূর্ণ অনুমোদিত')
    expect(message).toContain('wallet credit ৳500')
    expect(message).toContain('বাকি penalty ৳0')
  })

  it('includes the required rejection reason and retained penalty', () => {
    const message = penaltyAppealReviewedSms({
      action: 'REJECT',
      originalPenalty: 500,
      requestedReduction: 500,
      reason: 'Approved leave was not found for this date',
    })

    expect(message).toContain('প্রত্যাখ্যাত')
    expect(message).toContain('আসল penalty ৳500 বহাল')
    expect(message).toContain('Approved leave was not found')
  })
})
