import { describe, it, expect } from 'vitest'
import Ajv from 'ajv'
import {
  CAPABILITIES,
  exposedButUnexecutable,
  executableButUnroutable,
  orphanClassificationEntries,
  unclassifiedTools,
} from '../capability-manifest'

/**
 * Phase 2 exit gates, GENERATED from the capability manifest — every assertion
 * here re-derives from the live registries + TOOL_GROUPS + classification, so a
 * new tool cannot ship without a complete, strict, routable contract.
 */
describe('capability manifest coverage (Phase 2 exit gates)', () => {
  it('every executable tool has an authored classification', () => {
    expect(unclassifiedTools()).toEqual([])
  })

  it('no orphan classification entries (renamed/deleted tools)', () => {
    expect(orphanClassificationEntries()).toEqual([])
  })

  it('exposed-but-unexecutable = 0 (every TOOL_GROUPS tool is executable)', () => {
    expect(exposedButUnexecutable()).toEqual([])
  })

  it('executable-but-unroutable = 0 (every tool reachable via a group or a declared surface)', () => {
    expect(executableButUnroutable()).toEqual([])
  })

  it('dedicated-surface tools (mcp/customer) never leak into head groups', () => {
    const leaked = CAPABILITIES.filter((c) => c.routing !== 'group' && c.groups.length > 0)
    expect(leaked.map((c) => `${c.name} (${c.routing} → ${c.groups.join(',')})`)).toEqual([])
  })

  it('customer-routing tools live only in the customer pool', () => {
    const wrong = CAPABILITIES.filter(
      (c) => c.routing === 'customer' && c.pools.some((p) => p !== 'customer'),
    )
    expect(wrong.map((c) => c.name)).toEqual([])
  })
})

describe('strict input contracts (Phase 2)', () => {
  it('every input schema compiles under Ajv (Draft-7)', () => {
    const ajv = new Ajv({ coerceTypes: 'array', useDefaults: true, strict: false, allErrors: true })
    const broken: string[] = []
    for (const c of CAPABILITIES) {
      try {
        ajv.compile(c.inputSchema as object)
      } catch (err) {
        broken.push(`${c.name}: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
    expect(broken).toEqual([])
  })

  it('every schema root rejects unknown fields and declares explicit required', () => {
    const loose = CAPABILITIES.filter((c) => {
      const s = c.inputSchema as { additionalProperties?: unknown; required?: unknown; properties?: unknown }
      return s.additionalProperties !== false || !Array.isArray(s.required) || typeof s.properties !== 'object'
    })
    expect(loose.map((c) => c.name)).toEqual([])
  })

  it('required entries reference declared properties (no typos)', () => {
    const bad: string[] = []
    for (const c of CAPABILITIES) {
      const s = c.inputSchema as { properties?: Record<string, unknown>; required?: string[] }
      const props = new Set(Object.keys(s.properties ?? {}))
      for (const r of s.required ?? []) {
        if (!props.has(r)) bad.push(`${c.name}.required → "${r}"`)
      }
    }
    expect(bad).toEqual([])
  })

  it('every parameter has a description (was 183/695 missing at Phase 2 start)', () => {
    const missing: string[] = []
    for (const c of CAPABILITIES) {
      const props = (c.inputSchema as { properties?: Record<string, { description?: string }> }).properties ?? {}
      for (const [name, p] of Object.entries(props)) {
        if (!p || typeof p !== 'object' || !String(p.description ?? '').trim()) {
          missing.push(`${c.name}.${name}`)
        }
      }
    }
    expect(missing).toEqual([])
  })
})

describe('classification sanity', () => {
  it('reads are parallel-safe with no approval; stage tools carry a staged_card gate', () => {
    const wrong = CAPABILITIES.filter(
      (c) =>
        (c.mode === 'read' && (c.approval !== 'none' || c.concurrency !== 'parallel_read')) ||
        (c.mode === 'stage' && c.approval === 'none'),
    )
    expect(wrong.map((c) => `${c.name} (${c.mode}/${c.approval}/${c.concurrency})`)).toEqual([])
  })

  it('high-risk capabilities are never plain unclassified writes without idempotency', () => {
    const wrong = CAPABILITIES.filter((c) => c.risk === 'high' && c.idempotency !== 'required')
    expect(wrong.map((c) => c.name)).toEqual([])
  })
})
