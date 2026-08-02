/**
 * P0-4 — a correction outranks everything (foundation audit §B.1.4, §I).
 *
 * The detection regex is the risky half of this feature: a false positive
 * shouts an irrelevant instruction over every later turn, which is worse than
 * missing one. These tests pin BOTH sides — the shapes that must be caught
 * (the ones Boss actually types) and the ordinary messages that must not be.
 */
import { describe, it, expect } from 'vitest'
import { isOwnerCorrection, readCorrections, buildCorrectionNote } from '@/agent/lib/owner-corrections'

describe('isOwnerCorrection', () => {
  it('catches the shapes Boss actually types', () => {
    for (const t of [
      'na, oita na — ami notun chat er kotha bolechi',
      'না, এটা না',
      'bhul hoyeche, ekhane na',
      'ভুল জায়গায় লিখেছ',
      'age to bollam notun chat e pathao',
      'আগেই বলেছি ওটা করতে হবে না',
      'ami eta chai ni',
      'abar oi same bhul korle',
      'evabe na',
      'ami bolini to',
    ]) {
      expect(isOwnerCorrection(t), t).toBe(true)
    }
  })

  it('leaves ordinary messages alone — a false positive is worse than a miss', () => {
    for (const t of [
      'na',                                   // a bare answer to a yes/no question
      'না',
      'aj koto sale holo',
      'ChatGPT app e notun chat khule ekta kotha pathaw',
      'ok koro',
      'thanks, valo hoyeche',
      'ei product er caption lekho',
      'kalke abar mone koriye dio',           // "abar" without "same/oi"
    ]) {
      expect(isOwnerCorrection(t), t).toBe(false)
    }
  })

  it('ignores empty and essay-length input', () => {
    expect(isOwnerCorrection('')).toBe(false)
    expect(isOwnerCorrection(null)).toBe(false)
    expect(isOwnerCorrection(`bhul hoyeche ${'x'.repeat(700)}`)).toBe(false)
  })
})

describe('correction storage + note', () => {
  it('reads newest-first and caps the list', () => {
    const list = readCorrections([
      { text: 'old', at: '2026-08-01T10:00:00.000Z' },
      { text: 'newest', at: '2026-08-02T10:00:00.000Z' },
      { text: 'middle', at: '2026-08-02T09:00:00.000Z' },
      'junk',
      { text: 'no timestamp' },
    ])
    expect(list.map((c) => c.text)).toEqual(['newest', 'middle', 'old'])
  })

  it('the note leads with the newest correction and forbids repeating the mistake', () => {
    const note = buildCorrectionNote([
      { text: 'na, notun chat e pathao', at: '2026-08-02T10:00:00.000Z' },
      { text: 'age bollam oi file ta na', at: '2026-08-01T10:00:00.000Z' },
    ])
    expect(note).toContain('সবার উপরে')
    expect(note.indexOf('na, notun chat e pathao')).toBeLessThan(note.indexOf('age bollam oi file ta na'))
    expect(note).toContain('একই ভুল দ্বিতীয়বার')
  })

  it('is empty when there is nothing to say', () => {
    expect(buildCorrectionNote([])).toBe('')
  })
})
