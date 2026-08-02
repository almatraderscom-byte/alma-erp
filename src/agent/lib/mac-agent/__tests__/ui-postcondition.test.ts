/**
 * P0-5 — "done" has to be shown, not said (foundation audit §G.4, C.6).
 *
 * The audit caught the head narrating a save that never happened. The daemon
 * had returned the evidence to contradict it; nothing read the evidence. These
 * tests pin the three-way verdict, and especially the middle one: an act that
 * cannot be CONFIRMED is reported as unconfirmed, never as done.
 */
import { describe, it, expect } from 'vitest'
import { verifyUiOutcome, isVerifiableUiAction } from '@/agent/lib/mac-agent/ui-postcondition'

// Shaped like a REAL daemon reply (read off a live run 2026-08-02): `typed` is
// the character count, not a boolean — the first version of this checked for
// `=== true` and would have called every successful type a failure.
const typed = (fieldValue: string, ok = true) =>
  JSON.stringify({ ok: true, typed: ok ? fieldValue.length : 0, fieldValue })

describe('verifyUiOutcome — type', () => {
  it('verified when the field really contains what was typed', () => {
    const v = verifyUiOutcome({
      uiAction: 'ui_type',
      text: 'ALMA agent test - salam',
      stdout: typed('ALMA agent test - salam'),
      status: 'done',
    })
    expect(v.verdict).toBe('verified')
    expect(v.evidence.fieldValue).toBe('ALMA agent test - salam')
  })

  it('tolerates whitespace and case — the app re-renders the same text differently', () => {
    const v = verifyUiOutcome({ uiAction: 'ui_type', text: 'salam  Boss', stdout: typed('Salam Boss'), status: 'done' })
    expect(v.verdict).toBe('verified')
  })

  it('UNVERIFIED — it says it typed, but the field holds something else', () => {
    const v = verifyUiOutcome({ uiAction: 'ui_type', text: 'salam', stdout: typed('purano lekha'), status: 'done' })
    expect(v.verdict).toBe('unverified')
    expect(v.reasonBn).toContain('নিশ্চিত করে বলছি না')
  })

  it('accepts the boolean shape too, in case a verb ever reports it that way', () => {
    const v = verifyUiOutcome({
      uiAction: 'ui_type',
      text: 'salam',
      stdout: JSON.stringify({ ok: true, typed: true, fieldValue: 'salam' }),
      status: 'done',
    })
    expect(v.verdict).toBe('verified')
  })

  it('failed when the text never landed', () => {
    const v = verifyUiOutcome({ uiAction: 'ui_type', text: 'salam', stdout: typed('', false), status: 'done' })
    expect(v.verdict).toBe('failed')
  })
})

describe('verifyUiOutcome — click and new_chat', () => {
  it('a click is verified only when the app acknowledged the press', () => {
    expect(verifyUiOutcome({ uiAction: 'ui_click', elementLabel: 'New chat', stdout: '{"ok":true,"clicked":true}', status: 'done' }).verdict)
      .toBe('verified')
    expect(verifyUiOutcome({ uiAction: 'ui_click', elementLabel: 'New chat', stdout: '{"ok":true,"clicked":false}', status: 'done' }).verdict)
      .toBe('failed')
  })

  it('new_chat needs BOTH the press and an empty composer', () => {
    const good = JSON.stringify({ ok: true, clicked: 'New chat', session: { composerEmpty: true, articles: 0 } })
    const stale = JSON.stringify({ ok: true, clicked: 'New chat', session: { composerEmpty: false, articles: 7 } })
    expect(verifyUiOutcome({ uiAction: 'ui_new_chat', stdout: good, status: 'done' }).verdict).toBe('verified')
    expect(verifyUiOutcome({ uiAction: 'ui_new_chat', stdout: stale, status: 'done' }).verdict).toBe('failed')
  })
})

describe('verifyUiOutcome — evidence we cannot read', () => {
  it('unverified when the Mac returned nothing parseable — never a silent success', () => {
    const v = verifyUiOutcome({ uiAction: 'ui_type', text: 'salam', stdout: 'segmentation fault', status: 'done' })
    expect(v.verdict).toBe('unverified')
  })

  it('a non-done command is a failure whatever it printed', () => {
    const v = verifyUiOutcome({ uiAction: 'ui_type', text: 'salam', stdout: typed('salam'), status: 'error' })
    expect(v.verdict).toBe('failed')
  })

  it('reads still have nothing to prove', () => {
    expect(isVerifiableUiAction('ui_tree')).toBe(false)
    expect(verifyUiOutcome({ uiAction: 'ui_tree', stdout: 'anything', status: 'done' }).verdict).toBe('verified')
  })
})
