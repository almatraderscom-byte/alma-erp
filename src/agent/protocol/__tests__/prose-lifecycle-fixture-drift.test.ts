import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * The prose-lifecycle v2 golden fixture is consumed by the server/web tests
 * (this tree) AND by the native unit-test bundle (a copy under
 * ios/App/AppParityV2Tests/Fixtures). The two files must stay byte-identical —
 * same guard pattern as the G08 inventory snapshot drift test.
 */
describe('prose lifecycle v2 golden fixture — iOS copy drift guard', () => {
  it('the iOS bundle copy is byte-identical to the shared fixture', () => {
    const root = resolve(__dirname, '../../../..')
    const shared = readFileSync(resolve(root, 'src/agent/protocol/fixtures/prose-lifecycle-v2/golden-lead-progress-final.json'), 'utf8')
    const ios = readFileSync(resolve(root, 'ios/App/AppParityV2Tests/Fixtures/prose-lifecycle-v2-golden.json'), 'utf8')
    expect(ios).toBe(shared)
  })

  it('the fixture groups the v2 output per input step (what the native test replays)', () => {
    const root = resolve(__dirname, '../../../..')
    const fx = JSON.parse(readFileSync(resolve(root, 'src/agent/protocol/fixtures/prose-lifecycle-v2/golden-lead-progress-final.json'), 'utf8')) as {
      script: Array<{ emit?: unknown; v2?: unknown[] }>
      expectedV2Events: unknown[]
    }
    const grouped = fx.script.flatMap((s) => s.v2 ?? [])
    expect(grouped).toEqual(fx.expectedV2Events)
    expect(fx.script.filter((s) => s.emit && !s.v2)).toHaveLength(0)
  })
})
