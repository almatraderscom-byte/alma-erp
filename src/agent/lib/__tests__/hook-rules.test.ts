import { describe, it, expect, afterEach } from 'vitest'
import { parseHookRules, ruleMatchesTool } from '../hook-rules'
import { clearTurnHooks, registerPreToolHook, runPreToolHooks } from '../turn-hooks'

describe('owner hook rules (harness round 2)', () => {
  afterEach(() => clearTurnHooks())

  it('parses valid rules and drops junk (fail-open)', () => {
    const rules = parseHookRules(JSON.stringify([
      { tool: 'send_whatsapp', action: 'block', message: 'বন্ধ' },
      { tool: 'wa_*', action: 'notify' },
      { tool: '', action: 'block' },
      { tool: 'x', action: 'allow' },
      { tool: 'y', action: 'block', enabled: false },
      'garbage',
    ]))
    expect(rules).toHaveLength(2)
    expect(rules[0]).toMatchObject({ tool: 'send_whatsapp', action: 'block' })
    expect(rules[1]).toMatchObject({ tool: 'wa_*', action: 'notify' })
  })

  it('broken JSON parses to zero rules, never throws', () => {
    expect(parseHookRules('{oops')).toEqual([])
    expect(parseHookRules(undefined)).toEqual([])
    expect(parseHookRules(42)).toEqual([])
  })

  it('there is NO allow action — rules can only restrict or observe', () => {
    const rules = parseHookRules(JSON.stringify([{ tool: 'send_whatsapp', action: 'allow' }]))
    expect(rules).toEqual([])
  })

  it('glob prefix matching works, exact otherwise', () => {
    expect(ruleMatchesTool({ tool: 'wa_*', action: 'block' }, 'wa_send')).toBe(true)
    expect(ruleMatchesTool({ tool: 'wa_*', action: 'block' }, 'send_whatsapp')).toBe(false)
    expect(ruleMatchesTool({ tool: 'send_whatsapp', action: 'block' }, 'SEND_WHATSAPP')).toBe(true)
    expect(ruleMatchesTool({ tool: 'send_whatsapp', action: 'block' }, 'send_whatsapp_v2')).toBe(false)
  })

  it('caps at 50 rules', () => {
    const many = Array.from({ length: 80 }, (_, i) => ({ tool: `t${i}`, action: 'block' }))
    expect(parseHookRules(JSON.stringify(many))).toHaveLength(50)
  })

  it('a registered block rule actually blocks via the turn-hooks runner', () => {
    registerPreToolHook({
      name: 'kv:0:block:send_whatsapp',
      run: (ctx) => ctx.toolName === 'send_whatsapp'
        ? { action: 'block', message: 'নিয়মে বন্ধ' }
        : { action: 'allow' },
    })
    const blocked = runPreToolHooks({
      toolName: 'send_whatsapp', input: {}, model: 'm', personalMode: false, businessId: 'ALMA_LIFESTYLE',
    })
    expect(blocked).toEqual({ action: 'block', message: 'নিয়মে বন্ধ' })
    const allowed = runPreToolHooks({
      toolName: 'get_orders', input: {}, model: 'm', personalMode: false, businessId: 'ALMA_LIFESTYLE',
    })
    expect(allowed).toEqual({ action: 'allow' })
  })
})
