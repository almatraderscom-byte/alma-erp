/**
 * ElevenLabs voice profiles (eleven_v3).
 *
 * staff  — Charlie: staff announcements, dispatch, nudges
 * male   — Charlie: owner-requested male / ElevenLabs calls
 * female — River: owner-requested female only
 */

/** @typedef {'staff' | 'male' | 'female'} VoiceProfile */

export const VOICE_IDS = {
  charlie: 'IKne3meq5aSn9XLyUdCD',
  river: 'SAz9YHcvj6GT2YYXdXww',
}

export function staffVoiceId() {
  return process.env.ELEVENLABS_VOICE_STAFF ?? VOICE_IDS.charlie
}

export function maleVoiceId() {
  return process.env.ELEVENLABS_VOICE_MALE ?? staffVoiceId()
}

export function femaleVoiceId() {
  return process.env.ELEVENLABS_VOICE_FEMALE ?? VOICE_IDS.river
}

/** @param {VoiceProfile} [profile] */
export function resolveVoiceId(profile = 'staff') {
  if (profile === 'female') return femaleVoiceId()
  if (profile === 'male') return maleVoiceId()
  return staffVoiceId()
}

/**
 * Owner message → female vs male (default male when ElevenLabs voice requested).
 * @returns {'female' | 'male' | null}
 */
export function detectVoiceGenderFromText(text) {
  const raw = String(text ?? '')
  const female =
    /\b(female|river)\b/i.test(raw)
    || /(?:মেয়ে|নারী|মহিলা|মেয়েলি).{0,25}(?:voice|ভয়েস|কণ্ঠ|শুন)/iu.test(raw)
    || /(?:voice|ভয়েস|কণ্ঠ).{0,25}(?:মেয়ে|নারী|মহিলা)/iu.test(raw)
  if (female) return 'female'

  const male =
    /\b(male|charlie)\b/i.test(raw)
    || /(?:পুরুষ|ছেলে).{0,25}(?:voice|ভয়েস|কণ্ঠ)/iu.test(raw)
    || /(?:voice|ভয়েস).{0,25}(?:পুরুষ|ছেলে)/iu.test(raw)
  if (male) return 'male'

  return null
}

/** Owner explicitly asked for ElevenLabs TTS (voice reply or call audio). */
export function wantsElevenLabsFromText(text) {
  const raw = String(text ?? '')
  return (
    /eleven\s*labs?|ইলেভেন\s*ল্যাব/i.test(raw)
    || detectVoiceGenderFromText(raw) !== null
  )
}

/**
 * Parse owner Telegram text for optional voice reply to owner (not staff outbound).
 * @returns {{ wantsVoice: boolean, voiceProfile: VoiceProfile, useElevenLabs: boolean }}
 */
export function parseOwnerVoiceIntent(text) {
  const raw = String(text ?? '').trim()
  const gender = detectVoiceGenderFromText(raw)
  const useElevenLabs = wantsElevenLabsFromText(raw)

  const hasVoiceKeyword =
    /\b(voice|audio|read aloud|voice note|shuniye|shunao)\b/i.test(raw)
    || /শুনান|শুনতে|শোনাও|শুনিয়ে|কণ্ঠে|কথায় বল|ভয়েস/i.test(raw)

  const outboundVoice =
    /(?:স্টাফ|staff|তাকে|take|কাউকে|কারো|জনকে|কর্মচারী|কর্মী|মুস্তাহিদ|mustahid|ইয়াফি|eyafi|employee).{0,50}(?:voice|ভয়েস|শুনান|শুনিয়ে|audio)/iu.test(raw)
    || /(?:voice|ভয়েস|শুনান|শুনিয়ে|audio).{0,50}(?:স্টাফ|staff|তাকে|take|কাউকে|কারো|জনকে|পাঠাও|জানাও|দাও|দিতে|message|মেসেজ|বার্তা)/iu.test(raw)
    || /(?:message|মেসেজ|বার্তা|নোটিস).{0,40}(?:voice|ভয়েস|শুনান)/iu.test(raw)
    || /(?:voice|ভয়েস).{0,30}(?:ও\s*)?(?:take|তাকে|জেনো|যেনো).{0,15}(?:দে|দাও|দিতে|পাঠ)/iu.test(raw)
    || /(?:voice|ভয়েস|শুনিয়ে).{0,20}(?:ও\s*)(?:take|তাকে)/iu.test(raw)

  const wantsVoice =
    hasVoiceKeyword
    && !outboundVoice
    && (
      /\b(voice|audio|read aloud|voice note|shuniye|shunao)\b/i.test(raw)
      || /শুনিয়ে দাও|বলে শোনাও|কথায় উত্তর|শুনান|শুনতে|শোনাও|কণ্ঠে|কথায় বল/i.test(raw)
      || /(?:আমাকে|amake|amk|amke|আমার|amr|amar|my).{0,25}(?:voice|ভয়েস|শুনান|শোনাও|কণ্ঠ)/iu.test(raw)
      || /(?:voice|ভয়েস).{0,25}(?:এ|e)?\s*(?:বল|bolo|উত্তর|reply|জবাব)/iu.test(raw)
      || useElevenLabs
    )

  const voiceProfile = gender === 'female' ? 'female' : 'male'

  return { wantsVoice, voiceProfile, useElevenLabs: useElevenLabs || wantsVoice }
}
