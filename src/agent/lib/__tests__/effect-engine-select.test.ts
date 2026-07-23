import { describe, it, expect, afterEach } from 'vitest'
import { effectEngineSelection, effectEngineSelectionFromEnv } from '@/agent/lib/effects/action-run'

/**
 * Phase 65 — the effect engine is no longer an all-or-nothing flip. A master
 * switch keeps back-compat; a `canary` mode enables the exactly-once engine for
 * exactly the task classes the owner lists, so ONE internal R1 class can pilot
 * it without touching every write.
 */

describe('effectEngineSelection — master switch + per-class canary', () => {
  it('never engages for reads or stages', () => {
    expect(effectEngineSelection({ toolMode: 'read', flag: 'on' }).use).toBe(false)
    expect(effectEngineSelection({ toolMode: 'stage', flag: 'on' }).use).toBe(false)
  })

  it('is ON by default (audit P0-4: mandatory for mutations); off/false is the explicit opt-out', () => {
    expect(effectEngineSelection({ toolMode: 'write' }).use).toBe(true)
    expect(effectEngineSelection({ toolMode: 'write' }).reason).toBe('master_on')
    expect(effectEngineSelection({ toolMode: 'write', flag: 'off' }).use).toBe(false)
    expect(effectEngineSelection({ toolMode: 'write', flag: '0' }).use).toBe(false)
    expect(effectEngineSelection({ toolMode: 'write', flag: 'false' }).use).toBe(false)
  })

  it('master on/true engages every write (back-compat with the old flag)', () => {
    expect(effectEngineSelection({ toolMode: 'write', flag: 'true' }).use).toBe(true)
    expect(effectEngineSelection({ toolMode: 'write', flag: 'on' }).reason).toBe('master_on')
  })

  it('canary engages ONLY the listed task classes', () => {
    const base = { toolMode: 'write' as const, flag: 'canary', canaryClasses: 'internal-reminders, memory-notes' }
    expect(effectEngineSelection({ ...base, taskClass: 'internal-reminders' }).use).toBe(true)
    expect(effectEngineSelection({ ...base, taskClass: 'memory-notes' }).use).toBe(true)
    expect(effectEngineSelection({ ...base, taskClass: 'public-publish' }).use).toBe(false)
    expect(effectEngineSelection({ ...base }).use).toBe(false) // no class → not selected
  })

  it('canary with an empty class list engages nothing', () => {
    expect(effectEngineSelection({ toolMode: 'write', flag: 'canary', canaryClasses: '', taskClass: 'x' }).use).toBe(false)
  })
})

describe('effectEngineSelectionFromEnv', () => {
  const ORIG = { flag: process.env.AGENT_EFFECT_ENGINE, classes: process.env.AGENT_EFFECT_ENGINE_CLASSES }
  afterEach(() => {
    process.env.AGENT_EFFECT_ENGINE = ORIG.flag
    process.env.AGENT_EFFECT_ENGINE_CLASSES = ORIG.classes
    if (ORIG.flag === undefined) delete process.env.AGENT_EFFECT_ENGINE
    if (ORIG.classes === undefined) delete process.env.AGENT_EFFECT_ENGINE_CLASSES
  })

  it('reads the live env', () => {
    process.env.AGENT_EFFECT_ENGINE = 'canary'
    process.env.AGENT_EFFECT_ENGINE_CLASSES = 'internal-reminders'
    expect(effectEngineSelectionFromEnv('write', 'internal-reminders').use).toBe(true)
    expect(effectEngineSelectionFromEnv('write', 'ads-budget').use).toBe(false)
    delete process.env.AGENT_EFFECT_ENGINE
    // Unset env under vitest ⇒ OFF (no DB in unit tests); production unset ⇒ ON
    // (P0-4 mandatory default, asserted on the pure function above).
    expect(effectEngineSelectionFromEnv('write', 'internal-reminders').use).toBe(false)
    process.env.AGENT_EFFECT_ENGINE = 'on'
    expect(effectEngineSelectionFromEnv('write', 'internal-reminders').use).toBe(true)
  })
})
