import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  assertStudioRunConfirmation,
  assertStudioRunJobPayload,
  assertUnsignedStudioJobCompatibility,
  issueStudioRunEstimate,
  signStudioRunEstimateClaims,
  signStudioRunJobPayload,
  verifyStudioRunEstimateReceipt,
  type StudioRunEstimateReceiptClaims,
  type StudioRunResolvedSelection,
  type StudioRunScope,
} from '@/lib/creative-studio/studio-run-authorization'

const NOW = new Date('2026-07-26T06:00:00.000Z')
const SCOPE: StudioRunScope = {
  actorUserId: 'user-1',
  ownerId: 'owner-1',
  role: 'creator',
  brandProfileId: 'brand-1',
  projectId: 'project-1',
  productId: 'AL-101',
  sourceAssetIds: ['asset-2', 'asset-1'],
}
const SELECTION: StudioRunResolvedSelection = {
  mode: 'try_on',
  architecture: 'advanced',
  provider: 'fal',
  model: 'fal-ai/fashn/tryon/v1.6',
  providers: ['fal'],
  models: ['fal-ai/fashn/tryon/v1.6'],
  plan: ['single_vton'],
  paidAttemptLimit: 2,
}
const REQUEST = {
  mode: 'try_on',
  productImagePath: 'products/al-101.jpg',
  modelImagePath: 'models/owner.jpg',
}

beforeEach(() => {
  process.env.CREATIVE_STUDIO_RUN_CONFIRMATION_SECRET =
    'test-only-studio-run-confirmation-secret'
})

afterEach(() => {
  delete process.env.CREATIVE_STUDIO_RUN_CONFIRMATION_SECRET
})

describe('signed Creative Studio paid-run authorization', () => {
  it('allows unsigned paid jobs only before the immutable server cutoff', () => {
    expect(assertUnsignedStudioJobCompatibility({
      type: 'image_gen',
      createdAt: '2026-07-25T23:59:59.999Z',
      payload: { provider: 'gemini' },
    })).toEqual({
      compatibilityReason: 'pre_receipt_job_before_cutoff',
    })
    for (const type of ['image_gen', 'video_gen']) {
      expect(() => assertUnsignedStudioJobCompatibility({
        type,
        createdAt: '2026-07-26T00:00:00.000Z',
        payload: { provider: 'gemini' },
      })).toThrowError(expect.objectContaining({
        code: 'unsigned_generation_authorization_required',
      }))
      expect(() => assertUnsignedStudioJobCompatibility({
        type,
        createdAt: NOW,
        payload: { provider: 'gemini' },
      })).toThrowError(expect.objectContaining({
        code: 'unsigned_generation_authorization_required',
      }))
    }
  })

  it('normalizes estimate and cap to whole taka before signing and confirming', () => {
    const estimate = issueStudioRunEstimate({
      scope: SCOPE,
      request: REQUEST,
      selection: SELECTION,
      estimateBdt: 12.51,
      requestedCapBdt: 13.4,
      now: NOW,
    })

    expect(estimate.estimateBdt).toBe(13)
    expect(estimate.maxCostBdt).toBe(13)
    expect(Number.isInteger(estimate.estimateBdt)).toBe(true)
    expect(Number.isInteger(estimate.maxCostBdt)).toBe(true)
    expect(assertStudioRunConfirmation({
      receipt: estimate.receipt,
      request: REQUEST,
      scope: SCOPE,
      selection: SELECTION,
      estimateBdt: 12.51,
      confirmation: true,
      idempotencyKey: 'studio:receipt-whole-taka',
      maxCostBdt: 13.4,
      now: NOW,
    })).toMatchObject({
      estimateBdt: 13,
      maxCostBdt: 13,
    })
  })

  it('cannot use decimal rounding to bypass the whole-taka cap', () => {
    expect(() => issueStudioRunEstimate({
      scope: SCOPE,
      request: REQUEST,
      selection: SELECTION,
      estimateBdt: 13.51,
      requestedCapBdt: 13.49,
      now: NOW,
    })).toThrowError(expect.objectContaining({
      code: 'run_cost_cap_exceeded',
    }))
  })

  it('rejects missing confirmation, changed inputs, cap tampering, stale and tampered receipts', () => {
    const estimate = issueStudioRunEstimate({
      scope: SCOPE,
      request: REQUEST,
      selection: SELECTION,
      estimateBdt: 25,
      requestedCapBdt: 50,
      now: NOW,
    })
    const confirm = (overrides: Record<string, unknown> = {}) =>
      assertStudioRunConfirmation({
        receipt: estimate.receipt,
        request: REQUEST,
        scope: SCOPE,
        selection: SELECTION,
        estimateBdt: 25,
        confirmation: true,
        idempotencyKey: 'studio:receipt-confirmation',
        maxCostBdt: 50,
        now: NOW,
        ...overrides,
      })

    expect(() => confirm({ confirmation: false })).toThrowError(
      expect.objectContaining({ code: 'explicit_confirmation_required' }),
    )
    expect(() => confirm({ request: { ...REQUEST, mode: 'edit' } })).toThrowError(
      expect.objectContaining({ code: 'run_estimate_changed' }),
    )
    expect(() => confirm({ maxCostBdt: 51 })).toThrowError(
      expect.objectContaining({ code: 'run_cost_cap_tampered' }),
    )
    expect(() => verifyStudioRunEstimateReceipt(estimate.receipt, {
      phase: 'confirm',
      now: new Date(NOW.getTime() + 6 * 60_000),
    })).toThrowError(expect.objectContaining({ code: 'run_estimate_stale' }))
    expect(() => verifyStudioRunEstimateReceipt(
      `${estimate.receipt.slice(0, -1)}x`,
      { phase: 'confirm', now: NOW },
    )).toThrowError(expect.objectContaining({ code: 'run_receipt_tampered' }))
  })

  it('rejects even correctly signed receipts containing fractional BDT claims', () => {
    const claims: StudioRunEstimateReceiptClaims = {
      version: 1,
      receiptId: 'fractional-receipt',
      issuedAt: NOW.toISOString(),
      confirmBy: new Date(NOW.getTime() + 60_000).toISOString(),
      executeBy: new Date(NOW.getTime() + 120_000).toISOString(),
      requestFingerprint: 'request',
      selectionFingerprint: 'selection',
      estimateBdt: 12.5,
      maxCostBdt: 50,
      scope: SCOPE,
      selection: SELECTION,
    }
    expect(() => verifyStudioRunEstimateReceipt(
      signStudioRunEstimateClaims(claims),
      { phase: 'confirm', now: NOW },
    )).toThrowError(expect.objectContaining({ code: 'run_receipt_invalid' }))
  })

  it('binds the worker payload and detects changed job fields or signatures', () => {
    const payload = {
      provider: 'fal',
      studioSurface: 'v3',
      studioRunScope: SCOPE,
      studioPaidAttemptLimit: 2,
    }
    const signed = signStudioRunJobPayload('receipt-1', payload)
    expect(() => assertStudioRunJobPayload({
      receiptId: 'receipt-1',
      payload,
      jobFingerprint: signed.jobFingerprint,
      providedSignature: signed.jobSignature,
    })).not.toThrow()
    expect(() => assertStudioRunJobPayload({
      receiptId: 'receipt-1',
      payload: { ...payload, provider: 'gemini' },
      jobFingerprint: signed.jobFingerprint,
      providedSignature: signed.jobSignature,
    })).toThrowError(expect.objectContaining({ code: 'run_job_payload_tampered' }))
  })
})
