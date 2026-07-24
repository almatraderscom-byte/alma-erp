import { describe, it, expect } from 'vitest'
import { wavDurationSeconds, audioDurationSeconds, estimateAudioDurationSeconds } from '@/agent/lib/pricing'

/**
 * WAV duration parsing (cost audit Phase 6). The office-camera listener uploads
 * WAV 16 kHz mono 16-bit; reading the header gives the EXACT duration instead of
 * the 16×-high bytes/2000 guess that billed ~$17/month of phantom OpenAI cost.
 */
function makeWav(opts: { sampleRate: number; channels: number; bitsPerSample: number; seconds: number }): Uint8Array {
  const { sampleRate, channels, bitsPerSample, seconds } = opts
  const byteRate = sampleRate * channels * (bitsPerSample / 8)
  const dataSize = Math.round(byteRate * seconds)
  const buf = new Uint8Array(44 + dataSize)
  const dv = new DataView(buf.buffer)
  const ascii = (o: number, s: string) => { for (let i = 0; i < s.length; i++) buf[o + i] = s.charCodeAt(i) }
  ascii(0, 'RIFF'); dv.setUint32(4, 36 + dataSize, true); ascii(8, 'WAVE')
  ascii(12, 'fmt '); dv.setUint32(16, 16, true)
  dv.setUint16(20, 1, true); dv.setUint16(22, channels, true)
  dv.setUint32(24, sampleRate, true); dv.setUint32(28, byteRate, true)
  dv.setUint16(32, channels * (bitsPerSample / 8), true); dv.setUint16(34, bitsPerSample, true)
  ascii(36, 'data'); dv.setUint32(40, dataSize, true)
  return buf
}

describe('wavDurationSeconds', () => {
  it('reads the exact duration from a 16 kHz mono 16-bit WAV', () => {
    const wav = makeWav({ sampleRate: 16000, channels: 1, bitsPerSample: 16, seconds: 6 })
    expect(wavDurationSeconds(wav)).toBeCloseTo(6, 5)
  })

  it('matches the real camera chunk size the audit found (~192 KB ⇒ ~6 s, NOT 97 s)', () => {
    // 192,000 data bytes at 32000 B/s = 6.0 s. The old estimate said 192000/2000 = 96 s.
    const wav = makeWav({ sampleRate: 16000, channels: 1, bitsPerSample: 16, seconds: 6 })
    expect(wav.length).toBeGreaterThan(190_000)
    const wavSec = wavDurationSeconds(wav)!
    expect(wavSec).toBeCloseTo(6, 3)
    expect(estimateAudioDurationSeconds(wav.length)).toBeGreaterThan(90) // the old, wrong number
    // So the correction factor is ~16×.
    expect(estimateAudioDurationSeconds(wav.length) / wavSec).toBeGreaterThan(14)
  })

  it('handles a stereo 44.1 kHz WAV', () => {
    const wav = makeWav({ sampleRate: 44100, channels: 2, bitsPerSample: 16, seconds: 3 })
    expect(wavDurationSeconds(wav)).toBeCloseTo(3, 3)
  })

  it('returns null for non-WAV bytes (compressed audio has no RIFF header)', () => {
    const ogg = new Uint8Array([0x4f, 0x67, 0x67, 0x53, 1, 2, 3, 4, 5, 6, 7, 8]) // "OggS"...
    expect(wavDurationSeconds(ogg)).toBeNull()
    expect(wavDurationSeconds(new Uint8Array(10))).toBeNull() // too short
  })

  it('audioDurationSeconds uses WAV when possible, byte estimate otherwise', () => {
    const wav = makeWav({ sampleRate: 16000, channels: 1, bitsPerSample: 16, seconds: 5 })
    expect(audioDurationSeconds(wav)).toBeCloseTo(5, 3)
    const opus = new Uint8Array(20000) // not WAV → falls back to bytes/2000 = 10
    expect(audioDurationSeconds(opus)).toBe(estimateAudioDurationSeconds(20000))
  })
})
