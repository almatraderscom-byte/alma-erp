import { describe, expect, it } from 'vitest'
import { createVisibleProgressContract } from '@/agent/lib/models/visible-progress'
import agentEventSchema from '@/agent/protocol/agent-event.schema.json'

describe('provider-independent visible progress', () => {
  it('keeps progress_update in the canonical SSE schema', () => {
    const refs = agentEventSchema.oneOf.map((entry) => entry.$ref)
    expect(refs).toContain('#/$defs/progress_update')
    expect(agentEventSchema.$defs.progress_update).toMatchObject({
      properties: {
        type: { const: 'progress_update' },
        label: { type: 'string' },
      },
      required: ['type', 'label'],
    })
  })

  it('uses the canonical SSE shape and reports only observable lifecycle facts', () => {
    const progress = createVisibleProgressContract()

    expect(progress.roundStarted(1)).toEqual({
      type: 'progress_update',
      label: 'ধাপ ১ · পরের পদক্ষেপ প্রস্তুত হচ্ছে',
    })
    expect(progress.toolSelected(1, 'ERP অর্ডার চেক করছি')).toEqual({
      type: 'progress_update',
      label: 'ধাপ ১ · ERP অর্ডার চেক করছি',
    })
    expect(progress.responseStarted(1)).toEqual({
      type: 'progress_update',
      label: 'ধাপ ১ · ফল যাচাই করে উত্তর প্রস্তুত হচ্ছে',
    })
  })

  it('deduplicates provider tool announcements and response chunks per round', () => {
    const progress = createVisibleProgressContract()

    expect(progress.toolSelected(2, 'স্টক দেখছি')).not.toBeNull()
    expect(progress.toolSelected(2, 'স্টক দেখছি')).toBeNull()
    expect(progress.responseStarted(2)).not.toBeNull()
    expect(progress.responseStarted(2)).toBeNull()

    // The same real tool in a later model round is a new lifecycle step.
    expect(progress.toolSelected(3, 'স্টক দেখছি')).toEqual({
      type: 'progress_update',
      label: 'ধাপ ৩ · স্টক দেখছি',
    })
  })

  it('normalizes untrusted labels without inventing reasoning text', () => {
    const progress = createVisibleProgressContract()
    const event = progress.toolSelected(1, '  orders\n\tদেখছি  ')

    expect(event?.label).toBe('ধাপ ১ · orders দেখছি')
    expect(event?.label).not.toMatch(/ভাব|reason|think/i)
    expect(progress.toolSelected(1, '   ')).toBeNull()
  })
})
