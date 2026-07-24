import { describe, expect, it } from 'vitest'
import {
  checkStudioCostConfirmation,
  classifyStudioAsset,
  isStudioAssetPublishable,
  studioActionBlockReason,
} from '../studio-policy'

describe('Studio asset action policy', () => {
  it('separates ready, QC failed, processing, failed and draft states', () => {
    expect(classifyStudioAsset({ status: 'executed', result: { qc: { pass: true } } })).toBe('ready')
    expect(classifyStudioAsset({ status: 'executed', result: { qc: { pass: false } } })).toBe('qc_failed')
    expect(classifyStudioAsset({ status: 'approved' })).toBe('processing')
    expect(classifyStudioAsset({ status: 'failed' })).toBe('failed')
    expect(classifyStudioAsset({ status: 'unknown' })).toBe('draft')
  })

  it('blocks publish-like actions after explicit image or video QC failure', () => {
    const image = { status: 'executed', result: { qc: { pass: false } } }
    const video = { status: 'executed', result: { videoQc: { pass: false } } }
    expect(isStudioAssetPublishable(image)).toBe(false)
    expect(studioActionBlockReason(video, 'video_finish')).toContain('QC ফেল')
    expect(isStudioAssetPublishable({ status: 'executed', result: {} })).toBe(true)
  })
})

describe('Studio pre-run cost gate', () => {
  it('requires exact confirmation before queueing', () => {
    expect(checkStudioCostConfirmation({ estimateBdt: 69 })).toMatchObject({
      ok: false,
      reason: 'confirmation_required',
      estimateBdt: 69,
    })
    expect(checkStudioCostConfirmation({ estimateBdt: 69, confirmedCostBdt: 68 })).toMatchObject({
      ok: false,
      reason: 'estimate_changed',
    })
    expect(checkStudioCostConfirmation({ estimateBdt: 69, confirmedCostBdt: 69 })).toMatchObject({ ok: true })
  })

  it('hard-blocks runs above the per-run cap', () => {
    expect(checkStudioCostConfirmation({ estimateBdt: 120, confirmedCostBdt: 120, capBdt: 100 })).toEqual({
      ok: false,
      reason: 'cap_exceeded',
      estimateBdt: 120,
      capBdt: 100,
    })
  })
})
