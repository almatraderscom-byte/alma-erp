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

/** Female voice request (ElevenLabs River); male (Charlie) is the default. */
const FEMALE_RE = new RegExp(
  `(?<!${B_L})(?:female|woman|girl|মহিলা|মেয়ে(?:দের)?|নারী|river)(?!${B_R})`,
  'i',
)

export type VoiceProvider = 'google' | 'elevenlabs'

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
 * Default is ALWAYS google: silence never buys the expensive voice.
 */
export function detectVoiceProviderRequest(texts: string | string[]): OwnerVoicePref {
  const all = (Array.isArray(texts) ? texts : [texts]).filter(Boolean).join('\n')
  if (!all.trim()) return { provider: 'google', gender: 'male', explicit: false }

  const gender: 'male' | 'female' = FEMALE_RE.test(all) ? 'female' : 'male'
  if (ELEVENLABS_RE.test(all)) return { provider: 'elevenlabs', gender, explicit: true }
  if (GOOGLE_RE.test(all)) return { provider: 'google', gender, explicit: true }
  return { provider: 'google', gender, explicit: false }
}

/** Bangla label for the confirm card, so Boss SEES the voice before approving. */
export function voicePrefLabel(pref: OwnerVoicePref): string {
  if (pref.provider === 'elevenlabs') {
    return `ElevenLabs (${pref.gender === 'female' ? 'মহিলা' : 'পুরুষ'} — আপনি বলেছেন)`
  }
  return pref.explicit ? 'Google (আপনি বলেছেন)' : 'Google (ডিফল্ট)'
}
