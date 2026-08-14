import { describe, expect, it } from 'vitest'
import { detectSalahConfirmation, detectSalahQaza } from '@/agent/lib/salah-confirm-intent'

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
})
