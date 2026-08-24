import { describe, it, expect, vi, afterEach } from 'vitest'

afterEach(() => {
  vi.unstubAllEnvs()
  vi.resetModules()
})

const STYLE_MARKER = 'কথা বলার ধরন'
const PROFESSIONAL_REPORT_MARKER = 'Final answer-এর professional shape'

describe('COMMUNICATION_STYLE (BP5 — how it talks, model-agnostic)', () => {
  it('always ships the adaptive professional-report contract', async () => {
    const { buildSystemPrompt } = await import('../system-prompt')
    const business = buildSystemPrompt().map((b) => b.text ?? '').join('\n')
    const personal = buildSystemPrompt(null, undefined, undefined, undefined, false, false, false, undefined, false, true)
      .map((b) => b.text ?? '')
      .join('\n')

    for (const text of [business, personal]) {
      expect(text).toContain(PROFESSIONAL_REPORT_MARKER)
      expect(text).toContain('Long report / audit / review / analysis')
      expect(text).toContain('Simple reply')
      expect(text).toContain('Voice/TTS reply-তে emoji ও Markdown একদম নয়')
    }
  })

  it('delivers a normal management report in chat and reserves HTML for explicit requests', async () => {
    const { buildSystemPrompt } = await import('../system-prompt')
    const text = buildSystemPrompt().map((b) => b.text ?? '').join('\n')

    expect(text).toContain('প্রথম final chat reply-তেই **সম্পূর্ণ structured Markdown report**')
    expect(text).toContain('complete report এই প্রথম final reply-তেই দিন')
    expect(text).toContain('Boss স্পষ্টভাবে HTML source/code চাইলে')
    expect(text).toContain('আলাদা HTML artifact/file/live dashboard চাইলে')
    expect(text).not.toContain('একটা পূর্ণ HTML ডকুমেন্ট লিখুন একটা html fenced code-block-এ')
    expect(text).not.toContain('অ্যাপ এই html ব্লককে চ্যাটের ভেতরেই live render করবে')
    expect(text).not.toContain('save_artifact\` type:"html" লাইভ ড্যাশবোর্ড + ডাউনলোড লিংক')
  })

  it('advertises native rich-output grammar without allowing fabricated media', async () => {
    const { buildSystemPrompt } = await import('../system-prompt')
    const text = buildSystemPrompt().map((b) => b.text ?? '').join('\n')

    expect(text).toContain('## Native rich-output contract')
    expect(text).toContain('```latex')
    expect(text).toContain('```mermaid')
    expect(text).toContain('```form')
    expect(text).toContain('URL বানাবে না')
    expect(text).toContain('raw private reasoning কখনো output করবে না')
  })

  it('is absent by default (exact current prompt)', async () => {
    vi.resetModules()
    const { buildSystemPrompt } = await import('../system-prompt')
    const text = buildSystemPrompt().map((b) => b.text ?? '').join('\n')
    expect(text).not.toContain(STYLE_MARKER)
  })

  it('is present in BUSINESS and PERSONAL modes when AGENT_STYLE=on', async () => {
    vi.stubEnv('AGENT_STYLE', 'on')
    vi.resetModules()
    const { buildSystemPrompt } = await import('../system-prompt')
    const biz = buildSystemPrompt().map((b) => b.text ?? '').join('\n')
    expect(biz).toContain(STYLE_MARKER)
    expect(biz).toContain('আসল উত্তর আগে') // the answer-first example survived
    const personal = buildSystemPrompt(null, undefined, undefined, undefined, false, false, false, undefined, false, true)
      .map((b) => b.text ?? '')
      .join('\n')
    expect(personal).toContain(STYLE_MARKER)
  })

  it('auto-enables on Vercel preview', async () => {
    vi.stubEnv('VERCEL_ENV', 'preview')
    vi.resetModules()
    const { buildSystemPrompt } = await import('../system-prompt')
    const text = buildSystemPrompt().map((b) => b.text ?? '').join('\n')
    expect(text).toContain(STYLE_MARKER)
  })
})
