/** Phase V4 — multi-clip Veo chain against a mocked DB (family-chain pattern). */
import { describe, it, expect, vi, beforeEach } from 'vitest'

type Row = { id: string; type: string; payload: Record<string, unknown>; status: string }
const rows: Row[] = []
let n = 0

vi.mock('@/lib/prisma', () => ({
  prisma: {
    agentPendingAction: {
      create: async ({ data }: { data: Omit<Row, 'id'> }) => {
        const row = { id: `act-${++n}`, ...data } as Row
        rows.push(row)
        return row
      },
    },
  },
}))
vi.mock('@/lib/content-engine/video-brief', () => ({
  buildVideoBrief: () => ({ prompt: 'brief', aspect: '9:16', durationSec: 8 }),
  estimateReelCostUsd: (s: number) => s * 0.15,
}))
vi.mock('@/lib/tryon/scene-pool', () => ({
  pickScene: () => ({ adultPose: 'p', childPose: 'c', scene: { prompt: 'BD scene' } }),
}))

import { startVeoReelChain, advanceVeoChain, multiReelCostUsd } from '@/lib/creative-studio/veo-chain'

beforeEach(() => { rows.length = 0; n = 0 })

describe('veo multi-clip chain', () => {
  it('walks clip1 → clip2 → concat with accumulated paths', async () => {
    const start = await startVeoReelChain({ productImagePath: 'p.jpg', totalClips: 2, aspect: '9:16' })
    expect(rows).toHaveLength(1)
    expect(rows[0].type).toBe('video_gen')
    expect(rows[0].payload.veoChain).toBe(true)
    expect(start.costUsd).toBe(multiReelCostUsd(2))

    const next = await advanceVeoChain(rows[0], 'generated/c1.mp4')
    expect(next).toBe(rows[1].id)
    expect(rows[1].type).toBe('video_gen')
    expect((rows[1].payload as { index: number }).index).toBe(1)

    const concat = await advanceVeoChain(rows[1], 'generated/c2.mp4')
    expect(concat).toBe(rows[2].id)
    expect(rows[2].type).toBe('video_edit')
    expect(rows[2].payload.veoConcat).toBe(true)
    expect(rows[2].payload.concatPaths).toEqual(['generated/c1.mp4', 'generated/c2.mp4'])
    expect(rows[2].payload.videoEdit).toBe(true)
  })

  it('ignores non-chain actions and missing storagePath', async () => {
    expect(await advanceVeoChain({ payload: {} }, 'x.mp4')).toBeNull()
    const start = await startVeoReelChain({ productImagePath: 'p.jpg', totalClips: 3, aspect: '16:9' })
    expect(start.costUsd).toBe(multiReelCostUsd(3))
    expect(await advanceVeoChain(rows[0], undefined)).toBeNull()
  })
})
