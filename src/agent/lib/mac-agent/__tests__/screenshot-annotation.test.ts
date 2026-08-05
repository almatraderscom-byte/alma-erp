import { describe, expect, it } from 'vitest'
import sharp from 'sharp'
import { annotateScreenshot } from '@/agent/lib/mac-agent/screenshot-share'

describe('Mac screenshot action marker', () => {
  it('returns a real labelled JPEG without changing the canvas size', async () => {
    const input = await sharp({
      create: { width: 800, height: 500, channels: 3, background: '#dbeafe' },
    }).jpeg().toBuffer()
    const annotated = await annotateScreenshot(`data:image/jpeg;base64,${input.toString('base64')}`, {
      phase: 'after', actionLabel: 'Click — New chat', detail: 'VERIFIED — empty chat opened',
    })
    expect(annotated).toMatch(/^data:image\/jpeg;base64,/)
    const bytes = Buffer.from(annotated!.split(',')[1], 'base64')
    const metadata = await sharp(bytes).metadata()
    expect(metadata.width).toBe(800)
    expect(metadata.height).toBe(500)
    // The top-left banner darkens the otherwise light-blue test image.
    const pixel = await sharp(bytes).extract({ left: 20, top: 20, width: 1, height: 1 }).raw().toBuffer()
    expect(pixel[0]).toBeLessThan(80)
  })

  it('refuses malformed/non-image evidence instead of inventing a proof', async () => {
    await expect(annotateScreenshot('not an image', {
      phase: 'before', actionLabel: 'Type — Message',
    })).resolves.toBeNull()
  })
})
