import { describe, expect, it } from 'vitest'
import {
  detectSalahConfirmation,
  detectSalahQaza,
  isSpokenSalahDeclaration,
} from '@/agent/lib/salah-confirm-intent'

// Live salah call 2026-08-15: the native app now posts the owner's finalized
// spoken transcript to /api/assistant/salah/confirm-spoken, whose only brain is
// these detectors. Pin the spoken phrasings that path must recognize.
describe('spoken salah confirmations (live-call auto-mark path)', () => {
  it('detects the exact live-call phrase', () => {
    expect(detectSalahConfirmation('নামাজ পড়েছি')).toEqual({ dateHint: undefined })
  })

  it('detects waqt-specific spoken confirmations', () => {
    expect(detectSalahConfirmation('ইশার নামাজ পড়ে নিয়েছি')).toEqual({ waqt: 'isha', dateHint: undefined })
    expect(detectSalahConfirmation('fajr porechi')).toEqual({ waqt: 'fajr', dateHint: undefined })
  })

  it('detects spoken qaza / missed declarations', () => {
    expect(detectSalahQaza('আসরের কাযা পড়েছি')).toMatchObject({ waqt: 'asr', kind: 'qaza' })
    expect(detectSalahQaza('ফজর মিস হয়ে গেছে')).toMatchObject({ waqt: 'fajr', kind: 'missed' })
  })

  it('ignores status questions so a read never marks anything', () => {
    expect(detectSalahConfirmation('আজ নামাজ পড়েছেন কি?')).toBeNull()
    expect(detectSalahQaza('আজ নামাজ পড়েছেন কি?')).toBeNull()
  })

  // Codex P1 (PR #762): the raw detectors are too loose for every spoken
  // utterance — the strict route gate must reject requests/questions/future
  // intent that mention salah topics without declaring anything.
  it('strict spoken gate accepts real declarations', () => {
    expect(isSpokenSalahDeclaration('নামাজ পড়েছি')).toBe(true)
    expect(isSpokenSalahDeclaration('আসরের কাযা পড়েছি')).toBe(true)
    expect(isSpokenSalahDeclaration('ফজর মিস হয়ে গেছে')).toBe(true)
    // The client posts EVERY finalized transcript — server vocabulary is the
    // only gate, so English declarations must pass here (Codex P1 round 2).
    expect(isSpokenSalahDeclaration('I prayed Isha')).toBe(true)
  })

  it('strict spoken gate rejects requests, questions and future intent', () => {
    expect(isSpokenSalahDeclaration('কাযা নামাজের নিয়ম বলো')).toBe(false)
    expect(isSpokenSalahDeclaration('ইশার নামাজ আদায় করার জন্য reminder তৈরি করো')).toBe(false)
    expect(isSpokenSalahDeclaration('মাগরিবের পরে কাযা পড়ে নিব')).toBe(false)
    // Future-inflected completion stem: "পড়ে ফেলব" contains "পড়ে ফেল".
    expect(isSpokenSalahDeclaration('ইশার নামাজ পড়ে ফেলব')).toBe(false)
    expect(isSpokenSalahDeclaration('নামাজ কয়টায়?')).toBe(false)
  })
})
