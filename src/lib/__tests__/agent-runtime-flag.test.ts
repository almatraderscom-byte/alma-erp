import { describe, it, expect, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { isAgentEnabled } from '@/lib/agent-runtime-flag'

// Audit #7: the AGENT_ENABLED kill switch must have a NEUTRAL home in src/lib so
// ERP code can honor it without importing from src/agent (the import that the
// codebase itself says "makes the kill-switch unreliable").

describe('agent-runtime-flag (audit #7 kill-switch home)', () => {
  const original = process.env.AGENT_ENABLED
  afterEach(() => {
    if (original === undefined) delete process.env.AGENT_ENABLED
    else process.env.AGENT_ENABLED = original
  })

  it('reflects AGENT_ENABLED=true', () => {
    process.env.AGENT_ENABLED = 'true'
    expect(isAgentEnabled()).toBe(true)
  })

  it('is OFF for any non-"true" value (fail-safe)', () => {
    process.env.AGENT_ENABLED = 'false'
    expect(isAgentEnabled()).toBe(false)
    process.env.AGENT_ENABLED = '1'
    expect(isAgentEnabled()).toBe(false)
    delete process.env.AGENT_ENABLED
    expect(isAgentEnabled()).toBe(false)
  })

  it('the neutral flag module does NOT import from src/agent', () => {
    const src = readFileSync(join(process.cwd(), 'src/lib/agent-runtime-flag.ts'), 'utf8')
    expect(/from ['"]@\/agent/.test(src)).toBe(false)
  })

  it('financial-intelligence (ERP /api/insights path) no longer imports from src/agent', () => {
    const src = readFileSync(join(process.cwd(), 'src/lib/financial-intelligence.ts'), 'utf8')
    expect(/from ['"]@\/agent/.test(src)).toBe(false)
  })
})
