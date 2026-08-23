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

  const inlineHtmlReport = `\`\`\`html
<!doctype html>
<html lang="bn">
<head>
  <style>
    .bar-container { display: grid; gap: 8px; }
    .bar { width: 75%; background: green; }
  </style>
</head>
<body>
  <main>
    <div class="kpi"><strong>মোট স্টক</strong><span>১১৪</span></div>
    <div class="bar-container"><div class="bar">৭৫%</div></div>
    <table>
      <thead><tr><th>SKU</th><th>স্টক</th><th>অবস্থা</th></tr></thead>
      <tbody>
${Array.from({ length: 18 }, (_, index) => `        <tr><td>SKU-${index + 1}</td><td>${20 + index}</td><td>যাচাই করা হয়েছে</td></tr>`).join('\n')}
      </tbody>
    </table>
  </main>
</body>
</html>
\`\`\``

  it('rejects an explicit long report delivered as flat prose', async () => {
    const detect = await loadReportDetector()
    expect(detect(flatReport, 'এই সপ্তাহের একটা বিস্তারিত business report দাও'))
      .toEqual([expect.objectContaining({ ruleId: 'professional_report_structure' })])
  })

  it('rejects a terse stock answer when the owner requested a complete management report shape', async () => {
    const detect = await loadReportDetector()
    const ownerRequest =
      'একটা professional management report দাও: bottom line, executive summary, KPI, findings, risks, recommendations এবং next steps সহ।'

    expect(detect('স্টক এখন ১১৪টি। সবকিছু মোটামুটি ঠিক আছে।', ownerRequest))
      .toEqual([expect.objectContaining({ ruleId: 'professional_report_structure' })])
  })

  it('accepts a scannable professional report', async () => {
    const detect = await loadReportDetector()
    expect(detect(structuredReport, 'এই সপ্তাহের একটা বিস্তারিত business report দাও')).toEqual([])
  })

  it('rejects a full inline HTML document for a normal management report', async () => {
    const detect = await loadReportDetector()
    expect(detect(inlineHtmlReport, 'বর্তমান inventory নিয়ে একটা professional management report দাও'))
      .toEqual([expect.objectContaining({ ruleId: 'professional_report_inline_html' })])
  })

  it('preserves explicit HTML source and artifact requests', async () => {
    const detect = await loadReportDetector()
    expect(detect(inlineHtmlReport, 'inventory report-এর HTML source/code দাও')).toEqual([])
    expect(detect(inlineHtmlReport, 'inventory report-টা আলাদা HTML artifact হিসেবে বানাও')).toEqual([])
  })

  it('does not force report chrome onto short or voice answers', async () => {
    const detect = await loadReportDetector()
    expect(detect('বস, রিপোর্টে বিক্রি স্থিতিশীল আছে।', 'এক লাইনে report দাও')).toEqual([])
    expect(detect('বস, রিপোর্টে বিক্রি স্থিতিশীল আছে।', 'short professional management report দাও')).toEqual([])
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

describe('round-budget wrap-up holds the complete-report contract', () => {
  // Live failure 2026-08-24: an explicit "professional inventory health
  // management report … bottom line, executive summary, KPI table, findings,
  // risks, recommendations and next steps" settled as a progress list ending
  // "Boss, \"continue\" বললে…". The turn had exhausted its ROUND budget, and
  // that final round both (a) receives a "tell Boss what you did so far" nudge
  // and (b) skips the verification block — there is no round left to retry
  // into. So on that round the nudge is the only thing holding the contract.
  async function loadRequiresCompleteReport() {
    return (await import('../claim-verifier')).requiresCompleteReport
  }

  it('recognises the request the live turn failed on', async () => {
    const requires = await loadRequiresCompleteReport()
    expect(requires(
      'FINAL-LIVE-PROOF-20260824-0236 - Create a professional inventory health management '
      + 'report using live ERP data. Include bottom line, executive summary, KPI table, '
      + 'findings, risks, recommendations and next steps.',
    )).toBe(true)
    // two named sections are enough, even without the word "professional"
    expect(requires('give me the KPI table and the next steps')).toBe(true)
    // ordinary work is untouched
    expect(requires('আজকের অর্ডারগুলো দেখাও')).toBe(false)
    expect(requires('stock koto ache?')).toBe(false)
  })

  it('the final-round nudge asks for the report itself, not a progress list', async () => {
    const { readFileSync } = await import('node:fs')
    const source = readFileSync(
      new URL('../models/run-owner-turn.ts', import.meta.url), 'utf8')
    const start = source.indexOf('const lastBudgetRound =')
    const nudge = source.slice(start, start + 2400)
    expect(nudge).toContain('requiresCompleteReport(currentOwnerInstructions)')
    expect(nudge).toContain('পূর্ণ report-টা লিখে দাও')
    expect(nudge).toContain('progress list দিও না')
    // the honest-gap rule must survive: no invented numbers for missing data
    expect(nudge).toContain('সংখ্যা বানাবে না')
    // and the ordinary wrap-up is still there for non-report turns
    expect(nudge).toContain('এ পর্যন্ত কী কী করেছ, কী পেলে')
  })
})

describe('one-shot report repair round', () => {
  // Second layer behind the nudge: if the wrap-up round still comes back as a
  // progress list, the turn spends exactly ONE extra tool-free round writing
  // the report from data it already holds, rather than settling the wrong
  // deliverable. Source assertions — the branch lives inside the streaming
  // generator, which needs a provider and a database to drive.
  async function source() {
    const { readFileSync } = await import('node:fs')
    return readFileSync(new URL('../models/run-owner-turn.ts', import.meta.url), 'utf8')
  }

  it('is gated on an explicit complete-report request and a real violation', async () => {
    const s = await source()
    const start = s.indexOf('roundBudgetWrapSent\n          && !reportRepairUsed')
    expect(start).toBeGreaterThan(0)
    const block = s.slice(start, start + 2200)
    expect(block).toContain('requiresCompleteReport(currentOwnerInstructions)')
    expect(block).toContain('detectProfessionalReportStyleViolations(')
    expect(block).toContain('!signal?.aborted')
  })

  it('spends exactly one extra round and never loops', async () => {
    const s = await source()
    // one flag, set once, declared once
    expect(s.match(/reportRepairUsed/g)?.length).toBe(3)
    expect(s).toContain('reportRepairUsed = true')
    expect(s).toContain('maxIterations = iteration + 2')
    // the retry counter stays inside the owner-visible budget
    expect(s).toContain('verifyRetries = Math.min(verifyRetries + 1, MAX_VERIFY_RETRIES)')
  })

  it('the repair prompt forbids invented numbers', async () => {
    const s = await source()
    const anchor = s.indexOf('উপরের উত্তরটি progress list, report নয়')
    expect(anchor).toBeGreaterThan(0)
    const prompt = s.slice(anchor - 300, anchor + 700)
    expect(prompt).toContain('যাচাই করা যায়নি')
    expect(prompt).toContain('কোনো সংখ্যা বানাবে না')
    expect(prompt).toContain('INTERNAL CONTROL')
  })
})
