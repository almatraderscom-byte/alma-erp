/**
 * Phase E1 — Audio Lab (ElevenLabs). Pure builders only: hard style presets,
 * template lyric sheets the owner fills (name/occasion — never LLM-written),
 * and cost estimates shown BEFORE any run. The worker executes verbatim.
 *
 * GUARDRAIL: the owner's cloned voice is usable ONLY from owner-initiated
 * Audio Lab jobs — never in autonomous or customer-facing flows.
 */

export type AudioLabKind = 'voice_clone' | 'music' | 'wish_song' | 'owner_voice' | 'clean_voice' | 'sfx'

export const MUSIC_STYLES = [
  {
    id: 'celebration',
    labelBn: 'উৎসব',
    prompt:
      'Joyful South-Asian celebration instrumental, warm dhol and tabla groove, uplifting melody, festive but tasteful, no vocals.',
  },
  {
    id: 'calm',
    labelBn: 'শান্ত',
    prompt:
      'Calm serene instrumental, soft bansuri flute and gentle strings, peaceful South-Asian ambience, slow tempo, no vocals.',
  },
  {
    id: 'nasheed',
    labelBn: 'নাশিদ (ভোকাল-only)',
    prompt:
      'Nasheed style — male vocal harmonies ONLY, absolutely no musical instruments, no percussion, a cappella spiritual melody, warm and uplifting.',
  },
] as const
export type MusicStyleId = (typeof MUSIC_STYLES)[number]['id']

export const WISH_OCCASIONS = [
  { id: 'birthday', labelBn: 'জন্মদিন' },
  { id: 'anniversary', labelBn: 'বিবাহবার্ষিকী' },
  { id: 'eid', labelBn: 'ঈদ' },
] as const
export type WishOccasionId = (typeof WISH_OCCASIONS)[number]['id']

/** Fixed lyric sheets — the owner supplies ONLY the name. */
const WISH_LYRICS: Record<WishOccasionId, (name: string) => string> = {
  birthday: (name) =>
    `শুভ জন্মদিন ${name}, শুভ জন্মদিন তোমায়।\nআজকের এই দিনে, দোয়া রইল প্রাণ ভরে।\nহাসি-খুশি থেকো তুমি, সারাটা জীবন জুড়ে।\nশুভ জন্মদিন ${name}, শুভ জন্মদিন তোমায়।`,
  anniversary: (name) =>
    `শুভ বিবাহবার্ষিকী ${name}, ভালোবাসায় ভরা দিন।\nদুজনের এই পথচলা, হোক আরো রঙিন।\nদোয়া রইল অন্তরে, সুখে থেকো চিরদিন।\nশুভ বিবাহবার্ষিকী ${name}।`,
  eid: (name) =>
    `ঈদ মোবারক ${name}, ঈদ মোবারক তোমায়।\nখুশির এই দিনে, রহমত ঝরে পড়ুক তোমার আঙিনায়।\nঈদ মোবারক ${name}।`,
}

export function buildMusicPrompt(styleId: string, ownerLine?: string): string {
  const style = MUSIC_STYLES.find((s) => s.id === styleId) ?? MUSIC_STYLES[0]
  const line = (ownerLine ?? '').trim().slice(0, 200)
  return [style.prompt, line ? `Mood/theme requested: ${line}.` : ''].filter(Boolean).join(' ')
}

export function buildWishSong(occasionId: string, name: string): { lyrics: string; prompt: string } {
  const occ = WISH_OCCASIONS.find((o) => o.id === occasionId) ?? WISH_OCCASIONS[0]
  const safeName = name.trim().slice(0, 40) || 'প্রিয়জন'
  const lyrics = WISH_LYRICS[occ.id](safeName)
  return {
    lyrics,
    prompt:
      `A short warm Bengali ${occ.id} greeting song, gentle melody, clear Bengali vocals singing EXACTLY these lyrics:\n${lyrics}`,
  }
}

/** Honest ballpark estimates (ElevenLabs credits → USD), shown before run. */
export function audioCostBdt(kind: AudioLabKind, seconds = 30, usdToBdt = 125): number {
  const usd =
    kind === 'music' || kind === 'wish_song' ? (seconds / 60) * 0.55
    : kind === 'sfx' ? 0.08
    : kind === 'clean_voice' ? 0.1
    : kind === 'owner_voice' ? 0.15
    : 0 // voice_clone itself
  return Math.max(1, Math.round(usd * usdToBdt))
}

export const AUDIO_UPLOAD_EXTENSIONS = ['mp3', 'm4a', 'wav', 'aac', 'ogg', 'webm'] as const
export const AUDIO_UPLOAD_MAX_BYTES = 25 * 1024 * 1024
