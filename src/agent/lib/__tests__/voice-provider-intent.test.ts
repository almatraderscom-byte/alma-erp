import { describe, it, expect } from 'vitest'
import { detectVoiceProviderRequest, voicePrefLabel } from '@/agent/lib/voice-provider-intent'

describe('detectVoiceProviderRequest — Google unless Boss names ElevenLabs', () => {
  it('defaults to google when no voice is mentioned (the 11-of-12 bug)', () => {
    for (const t of [
      '01949489548 এ কল করে বলো আমি আসছি',
      'oi nambare call kore bolo dokan bondho',
      'আম্মুকে কল দিয়ে বলো ওষুধ খেতে',
    ]) {
      const p = detectVoiceProviderRequest(t)
      expect(p.provider, t).toBe('google')
      expect(p.explicit, t).toBe(false)
    }
  })

  it('picks elevenlabs ONLY when Boss says so — every spelling he uses', () => {
    for (const t of [
      'Elevenlabs er voice use korbe',
      'eleven labs voice diye call dao',
      '11labs voice',
      'ইলেভেন লাবস ভয়েস ইউজ করবে',
      'এলেভেনল্যাবস ভয়েসে কল করো',
      'এলিভেন ল্যাব দিয়ে বলবে',
    ]) {
      const p = detectVoiceProviderRequest(t)
      expect(p.provider, t).toBe('elevenlabs')
      expect(p.explicit, t).toBe(true)
    }
  })

  it('female voice only when asked; male otherwise', () => {
    expect(detectVoiceProviderRequest('elevenlabs female voice e call dao').gender).toBe('female')
    expect(detectVoiceProviderRequest('elevenlabs এ মহিলা ভয়েসে বলো').gender).toBe('female')
    expect(detectVoiceProviderRequest('elevenlabs voice e call dao').gender).toBe('male')
  })

  it('explicit google is honoured and marked explicit', () => {
    const p = detectVoiceProviderRequest('google voice diye call dao')
    expect(p.provider).toBe('google')
    expect(p.explicit).toBe(true)
  })

  it('spans the recent messages (voice said first, number after)', () => {
    const p = detectVoiceProviderRequest([
      'তুমি একটা নাম্বারে কল দিবে, ইলেভেন লাবস ভয়েস ইউজ করবে',
      'নাম্বার দিচ্ছি',
      '01949489548 — বলবে আমি মারুফ বসের এজেন্ট',
    ])
    expect(p.provider).toBe('elevenlabs')
  })

  it('does not fire on unrelated words containing the letters', () => {
    expect(detectVoiceProviderRequest('eleven ta order hoyeche').provider).toBe('google')
    expect(detectVoiceProviderRequest('আজ ১১টা অর্ডার').provider).toBe('google')
  })
})

describe('voicePrefLabel', () => {
  it('says WHY the voice was chosen so the card is honest', () => {
    expect(voicePrefLabel({ provider: 'google', gender: 'male', explicit: false })).toBe('Google (ডিফল্ট)')
    expect(voicePrefLabel({ provider: 'google', gender: 'male', explicit: true })).toBe('Google (আপনি বলেছেন)')
    expect(voicePrefLabel({ provider: 'elevenlabs', gender: 'male', explicit: true })).toContain('ElevenLabs')
    expect(voicePrefLabel({ provider: 'elevenlabs', gender: 'female', explicit: true })).toContain('মহিলা')
  })
})
