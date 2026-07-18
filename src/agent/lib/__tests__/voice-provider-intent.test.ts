import { describe, it, expect } from 'vitest'
import { detectVoiceProviderRequest, voicePrefLabel } from '@/agent/lib/voice-provider-intent'

describe('detectVoiceProviderRequest — Sarvam default unless Boss names another', () => {
  it('defaults to Sarvam (female/anushka) when no voice is mentioned', () => {
    for (const t of [
      '01949489548 এ কল করে বলো আমি আসছি',
      'oi nambare call kore bolo dokan bondho',
      'আম্মুকে কল দিয়ে বলো ওষুধ খেতে',
    ]) {
      const p = detectVoiceProviderRequest(t)
      expect(p.provider, t).toBe('sarvam')
      expect(p.gender, t).toBe('female')
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

  it('explicit Sarvam is honoured and marked explicit', () => {
    for (const t of ['sarvam voice diye call dao', 'সারভাম দিয়ে বলো']) {
      const p = detectVoiceProviderRequest(t)
      expect(p.provider, t).toBe('sarvam')
      expect(p.explicit, t).toBe(true)
    }
  })

  it('gender: female default for Sarvam; male only when Boss asks', () => {
    // Sarvam (default) → female
    expect(detectVoiceProviderRequest('01711111111 e call dao').gender).toBe('female')
    // explicit male request → male (abhilash)
    expect(detectVoiceProviderRequest('sarvam male voice e call dao').gender).toBe('male')
    expect(detectVoiceProviderRequest('ছেলে কণ্ঠে কল দাও').gender).toBe('male')
    // "female" must NOT trip the "male" match hiding inside it
    expect(detectVoiceProviderRequest('female voice e call dao').gender).toBe('female')
    // ElevenLabs keeps its own male default
    expect(detectVoiceProviderRequest('elevenlabs voice e call dao').gender).toBe('male')
    expect(detectVoiceProviderRequest('elevenlabs এ মহিলা ভয়েসে বলো').gender).toBe('female')
  })

  it('explicit google (Charon / আগের ভয়েস) is honoured and marked explicit', () => {
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

  it('does not fire on unrelated words containing the letters (falls to Sarvam default)', () => {
    expect(detectVoiceProviderRequest('eleven ta order hoyeche').provider).toBe('sarvam')
    expect(detectVoiceProviderRequest('আজ ১১টা অর্ডার').provider).toBe('sarvam')
  })
})

describe('voicePrefLabel', () => {
  it('says WHY the voice was chosen so the card is honest', () => {
    expect(voicePrefLabel({ provider: 'sarvam', gender: 'female', explicit: false })).toBe('Sarvam (মেয়ে কণ্ঠ)')
    expect(voicePrefLabel({ provider: 'sarvam', gender: 'male', explicit: true })).toBe('Sarvam (ছেলে কণ্ঠ — আপনি বলেছেন)')
    expect(voicePrefLabel({ provider: 'google', gender: 'male', explicit: false })).toBe('Google (ডিফল্ট)')
    expect(voicePrefLabel({ provider: 'google', gender: 'male', explicit: true })).toBe('Google (আপনি বলেছেন)')
    expect(voicePrefLabel({ provider: 'elevenlabs', gender: 'male', explicit: true })).toContain('ElevenLabs')
    expect(voicePrefLabel({ provider: 'elevenlabs', gender: 'female', explicit: true })).toContain('মহিলা')
  })
})
