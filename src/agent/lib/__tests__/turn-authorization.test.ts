import { describe, expect, it } from 'vitest'
import {
  deriveOwnerTurnAuthorization,
  filterToolsForOwnerTurn,
  isToolAllowedForOwnerTurn,
} from '../turn-authorization'

describe('owner turn authorization — model cannot widen owner intent', () => {
  it.each([
    'Ajker office kemon jacche?',
    'শুধু বলো (কিছু কোরো না): এখন কোন কাজ কোন ধাপে অপেক্ষায়?',
    'আজ staff দের কোন task দেওয়া হয়েছে?',
    'আমার website-এর সমস্যা কোথায়?',
    'SEO audit report-এ কী আছে?',
    'hello',
  ])('keeps information-only text read-only: %s', (text) => {
    expect(deriveOwnerTurnAuthorization(text).allowMutations).toBe(false)
  })

  it.each([
    'Eyafi কে আজ 2টা task দাও',
    'website title fix করো',
    'continue',
    'এই ছবি বানাও',
    'Fajr poreci',
    'আজ 500 টাকা খরচ করেছি',
    'মনে রাখো আমি simple design পছন্দ করি',
  ])('allows an explicit action or recordable fact: %s', (text) => {
    expect(deriveOwnerTurnAuthorization(text).allowMutations).toBe(true)
  })

  it('explicit no-action language wins even when mutation words appear', () => {
    const auth = deriveOwnerTurnAuthorization('শুধু বলো fix কীভাবে হবে, কিছু কোরো না')
    expect(auth).toEqual({ allowMutations: false, reason: 'explicit_no_action' })
  })

  it('removes every stage/write tool while retaining reads', () => {
    const auth = deriveOwnerTurnAuthorization('Ajker office kemon jacche?')
    const tools = [
      { name: 'get_shift_handover' },
      { name: 'get_staff_tasks' },
      { name: 'prepare_staff_task_proposal' },
      { name: 'merge_into_proposal' },
      { name: 'save_memory' },
    ]
    expect(filterToolsForOwnerTurn(tools, auth).map((t) => t.name)).toEqual([
      'get_shift_handover',
      'get_staff_tasks',
    ])
    expect(isToolAllowedForOwnerTurn('merge_into_proposal', auth)).toBe(false)
  })
})
