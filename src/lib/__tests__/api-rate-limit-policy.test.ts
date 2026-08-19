import { describe, expect, it } from 'vitest'
import { apiRateLimitPolicy } from '../api-rate-limit-policy'

describe('computer preview API rate buckets', () => {
  it('isolates each high-frequency paired-device path from a shared NAT bucket', () => {
    const browserFrames = apiRateLimitPolicy('/api/assistant/live-browser/frames')
    const browserPoll = apiRateLimitPolicy('/api/assistant/live-browser/poll')
    const macFrames = apiRateLimitPolicy('/api/assistant/mac-agent/frames')

    expect(browserFrames).toEqual({
      bucket: 'device-api:/api/assistant/live-browser/frames', limit: 720,
    })
    expect(browserPoll.bucket).not.toBe(browserFrames.bucket)
    expect(macFrames.bucket).not.toBe(browserFrames.bucket)
    // Four Macs at the shipped ~100 frame POSTs/min and four Browsers at
    // ~60/min can share one office NAT without reaching either path bucket.
    expect(macFrames.limit).toBeGreaterThanOrEqual(4 * 100)
    expect(browserFrames.limit).toBeGreaterThanOrEqual(4 * 60)
  })

  it('keeps pair-code and owner-session routes in the generic API bucket', () => {
    expect(apiRateLimitPolicy('/api/assistant/live-browser/pair'))
      .toEqual({ bucket: 'api', limit: 180 })
    expect(apiRateLimitPolicy('/api/assistant/live-browser/preview-lease'))
      .toEqual({ bucket: 'api', limit: 180 })
    expect(apiRateLimitPolicy('/api/assistant/mac-agent/stream'))
      .toEqual({ bucket: 'api', limit: 180 })
    expect(apiRateLimitPolicy('/api/assistant/live-activity'))
      .toEqual({ bucket: 'api', limit: 180 })
  })
})
