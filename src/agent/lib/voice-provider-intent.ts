/**
 * Which TTS voice a one-way call is spoken in — decided DETERMINISTICALLY from
 * Boss's own words, not guessed by the head model.
 *
 * Live evidence (prod `agent_pending_actions`, 2026-07-18 audit): of 12 outbound-call
 * drafts that carried a provider, **11 were elevenlabs and 1 was google** — the exact
 * opposite of the intended "google by default, ElevenLabs only when Boss asks". The
 * tool description said "google = default" but a description is a suggestion; the model
 * ignored it. ElevenLabs costs ~$0.048 per synthesis vs Google's ~$0.0027 (~18×), and
 * 8 of those 11 drafts were never dialed (5 expired, 3 rejected) — paid-for voice,
 * thrown away.
 *
 * So the provider is resolved here and injected through the tool's SERVER context,
 * which wins over model-supplied args (see runRegisteredTool). The model cannot
 * upgrade Boss to the expensive voice on its own.
 */
import { B_L, B_R } from './bangla-text'

/** Boss explicitly naming ElevenLabs — English, Banglish and Bangla spellings. */
const ELEVENLABS_RE = new RegExp(
  `(?<!${B_L})(?:` +
    `eleven\\s*-?\\s*labs?|11\\s*labs?|el\\s*labs?|` +
    `(?:এ|ই)লেভেন\\s*-?\\s*(?:ল্যাবস|ল্যাব|লাবস|লাব)|` +
    `(?:এ|ই)লিভেন\\s*-?\\s*(?:ল্যাবস|ল্যাব|লাবস|লাব)` +
  `)`,
  'i',
)

/** Boss explicitly asking for the normal/Google voice — same as the default, but
 * recorded as explicit so the card can say why. */
const GOOGLE_RE = new RegExp(
  `(?<!${B_L})(?:google\\s*(?:tts|voice)?|গুগল\\s*(?:ভয়েস|টিটিএস)?|charon|চ্যারন|` +
    `normal\\s*voice|সাধারণ\\s*ভয়েস|আগের\\s*ভয়েস|default\\s*voice)(?!${B_R})`,
  'i',
)

/** Boss explicitly naming Sarvam — English + Bangla spellings. */
const SARVAM_RE = new RegExp(
  `(?<!${B_L})(?:sarvam|সারভাম|সরভাম|সার্ভাম)(?!${B_R})`,
  'i',
)

/** Female voice request. Sarvam female = anushka, ElevenLabs female = River. */
const FEMALE_RE = new RegExp(
  `(?<!${B_L})(?:female|woman|girl|মহিলা|মেয়ে(?:দের)?|নারী|river|anushka|আনুশকা)(?!${B_R})`,
  'i',
)

/** Explicit male-voice request, so Boss can flip Sarvam to the male speaker (abhilash).
 * `\bmale\b` deliberately does NOT match inside "female" (no word boundary there). */
const MALE_RE = new RegExp(
  `\\bmale\\b|\\bman\\b|abhilash|hitesh|(?<!${B_L})(?:ছেলে|পুরুষ(?:ালি)?|অভিলাষ)(?!${B_R})`,
  'i',
)

export type VoiceProvider = 'google' | 'elevenlabs' | 'sarvam'

/**
 * Sarvam voice per gender — the SINGLE source of truth for both one-way and two-way
 * calls. Owner decision 2026-07-18 (heard on real telephony-quality samples):
 *   female = anushka  (bulbul:v2 — warm, clear, owner-confirmed on a live call)
 *   male   = ashutosh (bulbul:v3 — the latest model; owner-picked from the voice picker)
 * abhilash/karun/hitesh live only on v2; aditya/ashutosh only on v3 — so the model is
 * pinned per speaker here and must travel WITH the speaker to every TTS call.
 */
export const SARVAM_VOICE: Record<'male' | 'female', { speaker: string; model: string }> = {
  female: { speaker: 'anushka', model: 'bulbul:v2' },
  male: { speaker: 'ashutosh', model: 'bulbul:v3' },
}

/** Resolve the Sarvam speaker+model for a gender (defaults to female/anushka). */
export function sarvamVoiceFor(gender: 'male' | 'female' | undefined): { speaker: string; model: string } {
  return SARVAM_VOICE[gender === 'male' ? 'male' : 'female']
}

export interface OwnerVoicePref {
  provider: VoiceProvider
  gender: 'male' | 'female'
  /** true = Boss named the provider himself; false = nobody asked → safe default. */
  explicit: boolean
}

/**
 * Resolve the voice Boss asked for. `texts` should be his RECENT messages (newest
 * last) — the call flow is routinely two messages ("ElevenLabs ভয়েসে কল করবে…" then
 * the number), so a pref stated one message earlier must still count.
 *
 * Default is Sarvam Bulbul (owner decision 2026-07-18 — best Bangla): its default
 * voice is anushka (female). ElevenLabs still needs an explicit name (it is ~18× the
 * cost), and Google/Charon stays reachable when Boss asks for "আগের ভয়েস".
 */
export function detectVoiceProviderRequest(texts: string | string[]): OwnerVoicePref {
  const all = (Array.isArray(texts) ? texts : [texts]).filter(Boolean).join('\n')
  if (!all.trim()) return { provider: 'sarvam', gender: 'female', explicit: false }

  let provider: VoiceProvider
  let explicit: boolean
  if (ELEVENLABS_RE.test(all)) { provider = 'elevenlabs'; explicit = true }
  else if (GOOGLE_RE.test(all)) { provider = 'google'; explicit = true }
  else if (SARVAM_RE.test(all)) { provider = 'sarvam'; explicit = true }
  else { provider = 'sarvam'; explicit = false }

  // Female is checked first so "female" never trips the MALE match hiding inside it.
  // Sarvam's silent default is anushka (female); every other provider defaults male.
  const gender: 'male' | 'female' = FEMALE_RE.test(all)
    ? 'female'
    : MALE_RE.test(all)
      ? 'male'
      : provider === 'sarvam' ? 'female' : 'male'

  return { provider, gender, explicit }
}

/** Bangla label for the confirm card, so Boss SEES the voice before approving. */
export function voicePrefLabel(pref: OwnerVoicePref): string {
  if (pref.provider === 'elevenlabs') {
    return `ElevenLabs (${pref.gender === 'female' ? 'মহিলা' : 'পুরুষ'} — আপনি বলেছেন)`
  }
  if (pref.provider === 'sarvam') {
    const g = pref.gender === 'female' ? 'মেয়ে কণ্ঠ' : 'ছেলে কণ্ঠ'
    return pref.explicit ? `Sarvam (${g} — আপনি বলেছেন)` : `Sarvam (${g})`
  }
  return pref.explicit ? 'Google (আপনি বলেছেন)' : 'Google (ডিফল্ট)'
}
