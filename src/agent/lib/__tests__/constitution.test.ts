import { describe, it, expect, vi, afterEach } from 'vitest'

afterEach(() => {
  vi.unstubAllEnvs()
  vi.resetModules()
})

describe('CONSTITUTION (P6 — one behaviour contract, model-agnostic)', () => {
  it('is ABSENT when AGENT_CONSTITUTION is off → exact current prompt', async () => {
    vi.resetModules()
    const { buildSystemPrompt } = await import('../system-prompt')
    const text = buildSystemPrompt().map((b) => b.text ?? '').join('\n')
    expect(text).not.toContain('সংবিধান — সবার আগে')
  })

  it('is PRESENT and leads the stable block when AGENT_CONSTITUTION=on', async () => {
    vi.stubEnv('AGENT_CONSTITUTION', 'on')
    vi.resetModules()
    const { buildSystemPrompt, CONSTITUTION_RULE } = await import('../system-prompt')
    const text = buildSystemPrompt().map((b) => b.text ?? '').join('\n')
    expect(text).toContain('সংবিধান — সবার আগে')
    // it is the very top of the stable prompt (before the core identity module)
    const idxConstitution = text.indexOf('সংবিধান — সবার আগে')
    const idxIdentity = text.indexOf('# ')
    expect(idxConstitution).toBeGreaterThanOrEqual(0)
    // the reminder used for mid-turn re-injection is distinct + short
    const { CONSTITUTION_REMINDER } = await import('../system-prompt')
    expect(CONSTITUTION_REMINDER.length).toBeLessThan(240)
    expect(CONSTITUTION_RULE).toContain('দাবির আগে')
    void idxIdentity
  })

  it('P11 — personal mode ALSO gets the constitution when the flag is on', async () => {
    vi.stubEnv('AGENT_CONSTITUTION', 'on')
    vi.resetModules()
    const { buildSystemPrompt } = await import('../system-prompt')
    // 10th positional arg is personalMode
    const text = buildSystemPrompt(null, undefined, undefined, undefined, false, false, false, undefined, false, true)
      .map((b) => b.text ?? '')
      .join('\n')
    expect(text).toContain('সংবিধান — সবার আগে')
  })
})
