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
    // Banglish imperatives (owner-approved fix 2026-07-14 — the pair-code
    // incident: "daw" was read as information-only)
    'amk pair code daw, live browse er jnne',
    'oi task ta Mustahid ke pathao',
    'ei chobi ta abar banao',
    'campaign ta chalu koro',
  ])('allows an explicit action or recordable fact: %s', (text) => {
    expect(deriveOwnerTurnAuthorization(text).allowMutations).toBe(true)
  })

  it('explicit no-action language wins even when mutation words appear', () => {
    const auth = deriveOwnerTurnAuthorization('শুধু বলো fix কীভাবে হবে, কিছু কোরো না')
    expect(auth).toEqual({ allowMutations: false, reason: 'explicit_no_action' })
    expect(deriveOwnerTurnAuthorization('kichu koro na, sudhu bolo ki obostha').allowMutations).toBe(false)
  })

  // Owner-approved policy (2026-07-14): a text-GUESSED read-only turn keeps
  // stage tools (a card is gated by the owner's Approve anyway) and the
  // owner-service tools (ask_user / memory / checkpoints / pairing). Only
  // direct writes are blocked. An EXPLICIT "কিছু কোরো না" stays strict.
  it('information-only guess blocks direct writes but keeps reads, stage and service tools', () => {
    const auth = deriveOwnerTurnAuthorization('Ajker office kemon jacche?')
    expect(auth.reason).toBe('information_only')
    const tools = [
      { name: 'get_shift_handover' },
      { name: 'prepare_staff_task_proposal' }, // stage → allowed
      { name: 'merge_into_proposal' }, // stage → allowed
      { name: 'save_memory' }, // service → allowed
      { name: 'ask_user' }, // service → allowed
      { name: 'live_browser_pair' }, // service → allowed (the incident tool)
      { name: 'update_staff_task_status' }, // direct write → blocked
      { name: 'mark_salah' }, // direct write → blocked
    ]
    expect(filterToolsForOwnerTurn(tools, auth).map((t) => t.name)).toEqual([
      'get_shift_handover',
      'prepare_staff_task_proposal',
      'merge_into_proposal',
      'save_memory',
      'ask_user',
      'live_browser_pair',
    ])
  })

  it('explicit no-action strips stage tools too, keeping reads + service', () => {
    const auth = deriveOwnerTurnAuthorization('শুধু বলো, কিছু কোরো না — আজ কী হলো?')
    expect(auth.reason).toBe('explicit_no_action')
    expect(isToolAllowedForOwnerTurn('prepare_staff_task_proposal', auth)).toBe(false)
    expect(isToolAllowedForOwnerTurn('merge_into_proposal', auth)).toBe(false)
    expect(isToolAllowedForOwnerTurn('get_staff_tasks', auth)).toBe(true)
    expect(isToolAllowedForOwnerTurn('ask_user', auth)).toBe(true)
    expect(isToolAllowedForOwnerTurn('save_memory', auth)).toBe(true)
  })

  it('workflow_continuation authorization allows everything (in-flight work)', () => {
    const auth = { allowMutations: true, reason: 'workflow_continuation' as const }
    expect(isToolAllowedForOwnerTurn('post_to_facebook', auth)).toBe(true)
    expect(filterToolsForOwnerTurn([{ name: 'mark_salah' }], auth)).toHaveLength(1)
  })
})

describe('banglish -aw imperative spellings (live miss 2026-07-22)', () => {
  it('"message pathaw" is an explicit action, not information-only', () => {
    const auth = deriveOwnerTurnAuthorization('Eyafi ke send_whatsapp tool diye message pathaw: "test"')
    expect(auth.allowMutations).toBe(true)
    expect(auth.reason).toBe('explicit_action')
  })

  it('other -aw variants the owner types are actions too', () => {
    for (const text of ['ekta post banaw', 'campaign chalaw', 'reminder lagaw', 'Mustahid ke sms pataw']) {
      expect(deriveOwnerTurnAuthorization(text).allowMutations).toBe(true)
    }
  })

  it('plain information asks stay information-only', () => {
    const auth = deriveOwnerTurnAuthorization('ajker sales koto?')
    expect(auth.allowMutations).toBe(false)
    expect(auth.reason).toBe('information_only')
  })
})
