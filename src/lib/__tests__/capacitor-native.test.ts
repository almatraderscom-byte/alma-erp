import { createHash } from 'node:crypto'
import sharp from 'sharp'
import { describe, expect, it } from 'vitest'
import { fetchStudioDownloadFile } from '@/lib/capacitor-native'

describe('Creative Studio full-resolution download', () => {
  it('copies signed response bytes without resize or recompression', async () => {
    const stored = await sharp({
      create: {
        width: 2048,
        height: 1152,
        channels: 3,
        background: { r: 12, g: 34, b: 56 },
      },
    }).png().toBuffer()
    const file = await fetchStudioDownloadFile(
      'https://signed.example/full-resolution',
      'alma-verified-2k.png',
      async () => new Response(stored, {
        status: 200,
        headers: { 'Content-Type': 'image/png' },
      }),
    )
    const downloaded = Buffer.from(await file.arrayBuffer())
    const metadata = await sharp(downloaded).metadata()

    expect(file.name).toBe('alma-verified-2k.png')
    expect(file.type).toBe('image/png')
    expect(metadata.width).toBe(2048)
    expect(metadata.height).toBe(1152)
    expect(createHash('sha256').update(downloaded).digest('hex'))
      .toBe(createHash('sha256').update(stored).digest('hex'))
  })
})
