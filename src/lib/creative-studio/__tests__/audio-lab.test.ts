/** E1 — pure builder tests (templates, prompts, costs). */
import { describe, it, expect } from 'vitest'
import { buildMusicPrompt, buildWishSong, audioCostBdt, MUSIC_STYLES } from '@/lib/creative-studio/audio-lab'

describe('audio lab builders', () => {
  it('nasheed preset stays vocals-only', () => {
    const p = buildMusicPrompt('nasheed', 'ঈদের আনন্দ')
    expect(p).toContain('no musical instruments')
    expect(p).toContain('ঈদের আনন্দ')
  })

  it('unknown style falls back to the first preset', () => {
    expect(buildMusicPrompt('zzz')).toContain(MUSIC_STYLES[0].prompt.slice(0, 20))
  })

  it('wish song fills the owner-given name into the fixed template', () => {
    const { lyrics, prompt } = buildWishSong('birthday', 'রাহিম')
    expect(lyrics).toContain('শুভ জন্মদিন রাহিম')
    expect(prompt).toContain(lyrics)
    expect(buildWishSong('birthday', '  ').lyrics).toContain('প্রিয়জন')
  })

  it('is deterministic and clamps long names', () => {
    expect(buildWishSong('eid', 'ক'.repeat(100)).lyrics.length).toBeLessThan(400)
    expect(buildWishSong('eid', 'করিম')).toEqual(buildWishSong('eid', 'করিম'))
  })

  it('cost estimates scale with length and never go below ৳1', () => {
    expect(audioCostBdt('music', 60)).toBeGreaterThan(audioCostBdt('music', 30))
    expect(audioCostBdt('voice_clone')).toBe(1)
  })
})
