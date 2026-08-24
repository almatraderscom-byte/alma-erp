/**
 * Long jobs off serverless (2026-08-24). CLAUDE.md rule: >30s agentic work
 * belongs on the VPS worker queue. These tests pin the DECISION — which owner
 * turns hand execution to the worker lane and which stay inline.
 */
import { afterEach, describe, expect, it } from 'vitest'

import {
  classifyLongJobOwnerMessage,
  longTurnWorkerLaneEnabled,
  shouldRouteOwnerTurnToWorker,
} from '@/agent/lib/long-turn-lane'

const baseInput = {
  message: 'আজকের inventory-র একটা সম্পূর্ণ রিপোর্ট বানিয়ে দাও',
  rememberedLongRun: false,
  isInternalCall: false,
  internalControl: false,
  resume: false,
  autoContinue: false,
  voiceTurn: false,
  streamMode: true,
}

afterEach(() => {
  delete process.env.AGENT_LONG_TURN_WORKER_LANE
})

describe('classifyLongJobOwnerMessage', () => {
  it('routes the exact runaway class: an imperative report ask', () => {
    // The 2026-08-24 production runaway prompt class.
    expect(classifyLongJobOwnerMessage('আজকের inventory-র একটা রিপোর্ট বানিয়ে দাও')).toBe(true)
    expect(classifyLongJobOwnerMessage('স্টকের সম্পূর্ণ রিপোর্ট দাও')).toBe(true)
    expect(classifyLongJobOwnerMessage('run a full stock audit and write the report')).toBe(true)
  })

  it('routes site audits (client deliverable class)', () => {
    expect(classifyLongJobOwnerMessage('almatraders.com এর SEO অডিট করো')).toBe(true)
  })

  it('keeps ordinary chat and lookups inline', () => {
    expect(classifyLongJobOwnerMessage('আজ কয়টা অর্ডার আসছে?')).toBe(false)
    expect(classifyLongJobOwnerMessage('হাই, কেমন আছো')).toBe(false)
    expect(classifyLongJobOwnerMessage('ঠিক আছে')).toBe(false)
    expect(classifyLongJobOwnerMessage('')).toBe(false)
  })

  it('a QUESTION about a report is not a report order', () => {
    expect(classifyLongJobOwnerMessage('কেন রিপোর্ট খুলতে পারছি না?')).toBe(false)
  })
})

describe('shouldRouteOwnerTurnToWorker', () => {
  it('routes a report-class owner turn', () => {
    expect(shouldRouteOwnerTurnToWorker(baseInput)).toBe(true)
  })

  it('routes any turn of a conversation already remembered as long_run', () => {
    expect(shouldRouteOwnerTurnToWorker({
      ...baseInput,
      message: 'হ্যাঁ, শুরু করো',
      rememberedLongRun: true,
    })).toBe(true)
  })

  it('never routes the worker callback itself (no enqueue loop)', () => {
    expect(shouldRouteOwnerTurnToWorker({ ...baseInput, isInternalCall: true })).toBe(false)
    expect(shouldRouteOwnerTurnToWorker({ ...baseInput, internalControl: true })).toBe(false)
  })

  it('keeps resume / auto-continue / voice / JSON mode inline', () => {
    expect(shouldRouteOwnerTurnToWorker({ ...baseInput, resume: true })).toBe(false)
    expect(shouldRouteOwnerTurnToWorker({ ...baseInput, autoContinue: true })).toBe(false)
    expect(shouldRouteOwnerTurnToWorker({ ...baseInput, voiceTurn: true })).toBe(false)
    expect(shouldRouteOwnerTurnToWorker({ ...baseInput, streamMode: false })).toBe(false)
  })

  it('respects the kill switch', () => {
    process.env.AGENT_LONG_TURN_WORKER_LANE = 'off'
    expect(longTurnWorkerLaneEnabled()).toBe(false)
    expect(shouldRouteOwnerTurnToWorker(baseInput)).toBe(false)
  })
})
