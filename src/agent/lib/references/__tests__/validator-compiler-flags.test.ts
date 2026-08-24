import { afterEach, describe, expect, it } from 'vitest'
import { compileAgentReferenceText, verifiedHrefSet } from '../compiler'
import {
  agentReferenceRollout,
  exposedAgentReferences,
  shouldCollectAgentReferences,
  shouldRenderAgentReferences,
  toolResultForReferenceRollout,
} from '../flags'
import {
  buildInternalEntityReference,
  buildInternalSectionReference,
} from '../internal-registry'
import { buildExternalReference } from '../external-url'
import {
  canonicalizeAgentReference,
  filterAgentReferencesForContext,
  mergeAgentReferences,
} from '../validator'

const originalRollout = process.env.AGENT_REFERENCES_ROLLOUT
const originalKill = process.env.AGENT_REFERENCES_KILL_SWITCH

afterEach(() => {
  if (originalRollout == null) delete process.env.AGENT_REFERENCES_ROLLOUT
  else process.env.AGENT_REFERENCES_ROLLOUT = originalRollout
  if (originalKill == null) delete process.env.AGENT_REFERENCES_KILL_SWITCH
  else process.env.AGENT_REFERENCES_KILL_SWITCH = originalKill
})

function order(id = 'ord_42', label = 'AL-42') {
  return buildInternalEntityReference({
    namespace: 'order',
    id,
    label,
    aliases: [label, id],
    sourceTool: 'get_orders',
    outputPath: 'data.orders[0].id',
    context: {
      businessId: 'ALMA_LIFESTYLE',
      roles: ['SUPER_ADMIN'],
      observedAt: '2026-08-23T00:00:00.000Z',
    },
  })!
}

describe('rollout and kill-switch semantics', () => {
  it.each([
    [{}, 'shadow', true, false],
    [{ AGENT_REFERENCES_ROLLOUT: 'off' }, 'off', false, false],
    [{ AGENT_REFERENCES_ROLLOUT: 'shadow' }, 'shadow', true, false],
    [{ AGENT_REFERENCES_ROLLOUT: 'on' }, 'on', true, true],
    [{ AGENT_REFERENCES_ROLLOUT: 'TRUE' }, 'on', true, true],
    [{ AGENT_REFERENCES_ROLLOUT: 'on', AGENT_REFERENCES_KILL_SWITCH: ' Enabled ' }, 'off', false, false],
  ] as const)('resolves %o', (env, expected, collect, render) => {
    expect(agentReferenceRollout(env)).toBe(expected)
    expect(shouldCollectAgentReferences(env)).toBe(collect)
    expect(shouldRenderAgentReferences(env)).toBe(render)
    expect(exposedAgentReferences([1, 2], env)).toEqual(render ? [1, 2] : [])
  })

  it('keeps shadow metadata out of provider-visible tool envelopes', () => {
    const result = { success: true, data: { id: 1 }, references: [order()] }
    expect(toolResultForReferenceRollout(result, { AGENT_REFERENCES_ROLLOUT: 'shadow' }))
      .toEqual({ success: true, data: { id: 1 } })
    expect(toolResultForReferenceRollout(result, { AGENT_REFERENCES_ROLLOUT: 'on' })).toBe(result)
  })
})

describe('canonical registry and authorization boundary', () => {
  it('rebuilds internal references and rejects route, role, and business tampering', () => {
    const reference = order()
    expect(canonicalizeAgentReference(reference)).toEqual(reference)

    const tampered = structuredClone(reference)
    if (tampered.destination.type !== 'internal_entity') throw new Error('fixture')
    tampered.destination.webPath = '/agent/growth'
    expect(canonicalizeAgentReference(tampered)).toBeNull()

    expect(filterAgentReferencesForContext([reference], {
      businessId: 'ALMA_TRADING', roles: ['SUPER_ADMIN'],
    })).toEqual([])
    expect(filterAgentReferencesForContext([reference], {
      businessId: 'ALMA_LIFESTYLE', roles: ['VIEWER'],
    })).toEqual([])
  })

  it('fails closed for prototype keys and malformed ids without throwing', () => {
    const section = buildInternalSectionReference('dashboard', {}, { label: 'Home' })!
    const attack = structuredClone(section) as unknown as Record<string, unknown>
    ;(attack.destination as Record<string, unknown>).sectionId = '__proto__'
    expect(() => canonicalizeAgentReference(attack)).not.toThrow()
    expect(canonicalizeAgentReference(attack)).toBeNull()
    expect(buildInternalEntityReference({
      namespace: 'order', id: '../secret', sourceTool: 'get_orders', outputPath: 'data.id',
    })).toBeNull()
  })

  it('rejects a Meta-looking external object without exact Meta entity proof', () => {
    const generic = buildExternalReference({
      rawUrl: 'https://www.facebook.com/adsmanager/manage/campaigns?act=123&selected_campaign_ids=456',
      kind: 'external_object',
      purpose: 'navigate',
      source: 'tool_output',
      sourceTool: 'fixture',
      outputPath: 'data.url',
    })!
    expect(canonicalizeAgentReference(generic)).toBeNull()
  })

  it('deduplicates deterministically and caps metadata at 50 references', () => {
    const refs = Array.from({ length: 65 }, (_, index) => buildExternalReference({
      rawUrl: `https://example.com/source/${index}`,
      source: 'browser_observed',
    })!)
    const merged = mergeAgentReferences(refs, [refs[0], refs[1]])
    expect(merged).toHaveLength(50)
    expect(merged.map((ref) => ref.refId)).toEqual(refs.slice(0, 50).map((ref) => ref.refId))
  })
})

describe('deterministic final response compiler', () => {
  it('links only unambiguous aliases outside code and is idempotent', () => {
    process.env.AGENT_REFERENCES_ROLLOUT = 'on'
    const reference = order()
    const input = 'AL-42 দেখুন। `AL-42` literal।\n```text\nAL-42\n```'
    const once = compileAgentReferenceText(input, [reference])
    expect(once).toContain('[AL-42](</orders/ord_42?business_id=ALMA_LIFESTYLE>) দেখুন')
    expect(once).toContain('`AL-42` literal')
    expect(once).toContain('```text\nAL-42\n```')
    expect(compileAgentReferenceText(once, [reference])).toBe(once)
  })

  it('does not pick a winner for colliding aliases', () => {
    process.env.AGENT_REFERENCES_ROLLOUT = 'on'
    const one = order('ord_1', 'Shared')
    const two = order('ord_2', 'Shared')
    expect(compileAgentReferenceText('Shared order', [one, two])).toBe('Shared order')
  })

  it('angle-wraps parentheses, appends only verified references, and preserves guessed URLs', () => {
    process.env.AGENT_REFERENCES_ROLLOUT = 'on'
    const ref = buildExternalReference({
      rawUrl: 'https://en.wikipedia.org/wiki/Function_(mathematics)',
      label: 'Function',
      source: 'tool_output',
    })!
    expect(compileAgentReferenceText('Function', [ref]))
      .toBe('[Function](<https://en.wikipedia.org/wiki/Function_(mathematics)>)')
    expect(compileAgentReferenceText('কোনো alias নেই', [ref], { appendUnmentioned: true }))
      .toContain('[Function](<https://en.wikipedia.org/wiki/Function_(mathematics)>)')
    expect(compileAgentReferenceText('[invented](https://evil.example)', [ref]))
      .toBe('[invented](https://evil.example)')
    expect(verifiedHrefSet([ref])).toEqual(new Set(['https://en.wikipedia.org/wiki/Function_(mathematics)']))
  })

  it('keeps visible Markdown unchanged in off and shadow modes', () => {
    const reference = order()
    for (const mode of ['off', 'shadow'] as const) {
      process.env.AGENT_REFERENCES_ROLLOUT = mode
      expect(compileAgentReferenceText('AL-42', [reference])).toBe('AL-42')
    }
  })
})
