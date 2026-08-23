import { describe, it, expect, vi, afterEach } from 'vitest'

afterEach(() => {
  vi.unstubAllEnvs()
  vi.resetModules()
})

async function loadDetector() {
  return (await import('../claim-verifier')).detectRoboticStyleViolations
}

async function loadReportDetector() {
  return (await import('../claim-verifier')).detectProfessionalReportStyleViolations
}

describe('detectRoboticStyleViolations (BP6 — robotic-filler hard gate)', () => {
  it('is active by default', async () => {
    vi.resetModules()
    const detect = await loadDetector()
    expect(detect('অবশ্যই! আপনার প্রশ্নের উত্তর হলো ৫টা।')).toHaveLength(1)
  })

  it('has an instant rollback when AGENT_STYLE_GATE=off', async () => {
    vi.stubEnv('AGENT_STYLE_GATE', 'off')
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

  // Owner rule 2026-07-25: he compared two live replies — DeepSeek's
  // "বস, গত ৭ দিনের অ্যাড পারফরম্যান্স …" (good) against Grok's
  // "ঠিক আছে Boss — …" (contentless) — and banned the second shape.
  it('flags a contentless "ঠিক আছে Boss" opener', async () => {
    vi.stubEnv('AGENT_STYLE_GATE', 'on')
    vi.resetModules()
    const detect = await loadDetector()
    expect(detect('ঠিক আছে Boss — গত ৭ দিনের live ad performance: মোট খরচ $15.22।')).toHaveLength(1)
    expect(detect('ঠিক আছে বস, দেখছি।')).toHaveLength(1)
    expect(detect('Thik ache boss — ekhon dekhchi.')).toHaveLength(1)
    expect(detect('Ok boss, ads report ready.')).toHaveLength(1)
  })

  it('accepts the shape Boss asked for, and leaves mid-reply "ঠিক আছে" alone', async () => {
    vi.stubEnv('AGENT_STYLE_GATE', 'on')
    vi.resetModules()
    const detect = await loadDetector()
    expect(detect('বস, গত ৭ দিনের অ্যাড পারফরম্যান্স (Meta থেকে): মোট খরচ $15.22, CTR ~৬.৯%।')).toEqual([])
    expect(detect('স্টক ১২টা — সব ঠিক আছে বস।')).toEqual([])
  })
})

describe('professional long-report hard gate', () => {
  const flatReport = Array.from({ length: 18 }, (_, index) =>
    `সপ্তাহের পর্যবেক্ষণ ${index + 1}: বিক্রি, স্টক এবং অর্ডার পরিচালনার তথ্য যাচাই করে এই বিস্তারিত ফলাফল পাওয়া গেছে।`,
  ).join(' ')

  const structuredReport = `**Bottom line: বিক্রি স্থিতিশীল, কিন্তু stock coverage এখন প্রধান ঝুঁকি।**

## নির্বাহী সারাংশ

${Array.from({ length: 7 }, () => 'যাচাই করা সাপ্তাহিক তথ্য অনুযায়ী মূল ব্যবসায়িক অবস্থাটি স্থিতিশীল আছে।').join(' ')}

## মূল পর্যবেক্ষণ

- বিক্রি আগের সপ্তাহের কাছাকাছি আছে।
- তিনটি SKU-তে stock coverage কম।
- unavailable data আলাদা করে চিহ্নিত করা হয়েছে।

## আগামী অগ্রাধিকার

1. কম stock-এর SKU reorder করুন।
2. pending order প্রতিদিন review করুন।
3. সপ্তাহ শেষে ফলাফল আবার মাপুন।`

  it('rejects an explicit long report delivered as flat prose', async () => {
    const detect = await loadReportDetector()
    expect(detect(flatReport, 'এই সপ্তাহের একটা বিস্তারিত business report দাও'))
      .toEqual([expect.objectContaining({ ruleId: 'professional_report_structure' })])
  })

  it('accepts a scannable professional report', async () => {
    const detect = await loadReportDetector()
    expect(detect(structuredReport, 'এই সপ্তাহের একটা বিস্তারিত business report দাও')).toEqual([])
  })

  it('does not force report chrome onto short or voice answers', async () => {
    const detect = await loadReportDetector()
    expect(detect('বস, রিপোর্টে বিক্রি স্থিতিশীল আছে।', 'এক লাইনে report দাও')).toEqual([])
    expect(detect(flatReport, 'voice reply-তে weekly report বলে দাও')).toEqual([])
    expect(detect(flatReport, 'সাপ্তাহিক report বলো', { voiceTurn: true })).toEqual([])
  })

  it('obeys the rollback switch', async () => {
    vi.stubEnv('AGENT_STYLE_GATE', 'off')
    vi.resetModules()
    const detect = await loadReportDetector()
    expect(detect(flatReport, 'weekly report দাও')).toEqual([])
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
