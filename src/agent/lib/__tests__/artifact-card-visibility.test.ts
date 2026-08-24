import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { liveArtifactCard } from '@/agent/lib/artifact-card-visibility'

const canonicalCard = {
  id: 'artifact-1',
  title: 'SEO report',
  type: 'html',
  canonicalMessageDelivered: true,
  canonicalMessageId: 'message-1',
}

describe.each(['native', 'alternate'] as const)(
  'artifact card visibility — %s runner',
  (runtime) => {
    it('keeps the native live card when it is the only delivery path', () => {
      expect(liveArtifactCard({ id: 'artifact-live', title: 'Draft', type: 'markdown' })).toEqual({
        id: 'artifact-live',
        title: 'Draft',
        type: 'markdown',
      })
    })

    it('repeated check callbacks cannot add a second visible card after canonical background delivery', () => {
      const alreadyVisibleCanonicalCards = [canonicalCard]
      const repeatedLiveEvents = [canonicalCard, canonicalCard]
        .map(liveArtifactCard)
        .filter((card) => card !== null)

      expect([...alreadyVisibleCanonicalCards, ...repeatedLiveEvents]).toHaveLength(1)
    })

    it(`wires ${runtime} runner artifact emission through the shared visibility boundary`, () => {
      const file = runtime === 'native'
        ? 'src/agent/lib/core.ts'
        : 'src/agent/lib/models/run-owner-turn.ts'
      const source = readFileSync(join(process.cwd(), file), 'utf8')
      expect(source, `${file} must filter before timeline and SSE emission`).toContain('liveArtifactCard(cardRaw)')
    })
  },
)
