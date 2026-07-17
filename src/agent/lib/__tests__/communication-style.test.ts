import { describe, it, expect, vi, afterEach } from 'vitest'

afterEach(() => {
  vi.unstubAllEnvs()
  vi.resetModules()
})

const STYLE_MARKER = 'কথা বলার ধরন'

describe('COMMUNICATION_STYLE (BP5 — how it talks, model-agnostic)', () => {
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
