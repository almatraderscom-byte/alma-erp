import { describe, expect, it } from 'vitest'
import {
  browserWatchControlAction,
  classifyWatchActionResponse,
  hasExecutingBrowserStep,
} from '../LiveBrowserWatchPanel'

describe('live browser watch Stop truthfulness', () => {
  it('does not classify a 202 executing response as fully stopped', () => {
    expect(classifyWatchActionResponse('stop', 202, {
      stopping: true,
      inFlightEffects: 1,
    })).toEqual({
      kind: 'stopping',
      message: expect.stringContaining('নতুন ধাপ চলবে না'),
    })
  })

  it('never offers Resume while an already-authorized step is executing', () => {
    expect(hasExecutingBrowserStep([{ status: 'done' }, { status: 'executing' }])).toBe(true)
    expect(hasExecutingBrowserStep([{ status: 'done' }, { status: 'failed' }])).toBe(false)
    expect(browserWatchControlAction(false, true)).toBe('stop')
    expect(browserWatchControlAction(false, false)).toBe('resume')
  })

  it('treats only a terminal 2xx Stop as fully stopped', () => {
    expect(classifyWatchActionResponse('stop', 200, { inFlightEffects: 0 })).toMatchObject({
      kind: 'done',
      message: expect.stringContaining('থামিয়ে দিলাম'),
    })
  })
})
