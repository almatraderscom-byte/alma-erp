import { describe, it, expect, vi, afterEach } from 'vitest'

afterEach(() => {
  vi.unstubAllEnvs()
  vi.resetModules()
})

async function loadDetector() {
  return (await import('../claim-verifier')).detectRoboticStyleViolations
}

describe('detectRoboticStyleViolations (BP6 — robotic-filler hard gate)', () => {
  it('is a no-op when AGENT_STYLE_GATE is off (default)', async () => {
    vi.resetModules()
    const detect = await loadDetector()
    expect(detect('অবশ্যই! আপনার প্রশ্নের উত্তর হলো ৫টা।')).toEqual([])
  })

  it('flags unambiguous robotic filler when on', async () => {
    vi.stubEnv('AGENT_STYLE_GATE', 'on')
    vi.resetModules()
    const detect = await loadDetector()
    expect(detect('অবশ্যই! এখনই দেখছি বস।')).toHaveLength(1)
    expect(detect('চমৎকার প্রশ্ন বস! আজ ৫টা অর্ডার।')).toHaveLength(1)
    expect(detect('আপনার প্রশ্নের উত্তর হলো: স্টক ১২টা।')).toHaveLength(1)
    expect(detect('স্টক ১২টা। আশা করি এই তথ্য সহায়ক হবে।')).toHaveLength(1)
    expect(detect('একজন AI হিসেবে আমি বলতে পারি...')).toHaveLength(1)
  })

  it('flags emoji overload but allows 0-2 emoji', async () => {
    vi.stubEnv('AGENT_STYLE_GATE', 'on')
    vi.resetModules()
    const detect = await loadDetector()
    expect(detect('দারুণ খবর বস! 🎉🎉🔥🔥💪✨ সব হয়ে গেছে!')).toHaveLength(1)
    expect(detect('দারুণ খবর বস 🎉 — সেল বেড়েছে।')).toEqual([])
  })

  it('does NOT flag a normal sharp human reply', async () => {
    vi.stubEnv('AGENT_STYLE_GATE', 'on')
    vi.resetModules()
    const detect = await loadDetector()
    expect(detect('বস, আমার পরামর্শ — এখনই না, রবিবার করুন। কারণ স্টক কম।')).toEqual([])
    expect(detect('দেখছি বস, এক মিনিট।')).toEqual([])
    // "অবশ্যই" mid-sentence (not a canned opener) stays fine
    expect(detect('এটা অবশ্যই ভালো আইডিয়া বস।')).toEqual([])
  })
})

describe('STYLE_EXEMPLARS (BP6 — few-shot bank)', () => {
  it('exemplars ship with the style module when AGENT_STYLE=on', async () => {
    vi.stubEnv('AGENT_STYLE', 'on')
    vi.resetModules()
    const { buildSystemPrompt } = await import('../system-prompt')
    const text = buildSystemPrompt().map((b) => b.text ?? '').join('\n')
    expect(text).toContain('নমুনা উত্তর')
    expect(text).toContain('পরিস্থিতি অনুযায়ী উত্তরের আকার')
    expect(text).toContain('কখনোই নয়')
  })

  it('absent by default', async () => {
    vi.resetModules()
    const { buildSystemPrompt } = await import('../system-prompt')
    const text = buildSystemPrompt().map((b) => b.text ?? '').join('\n')
    expect(text).not.toContain('নমুনা উত্তর')
  })
})
