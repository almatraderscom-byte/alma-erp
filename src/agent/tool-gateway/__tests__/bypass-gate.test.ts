/**
 * G13 / SPEC-130 — Direct external-call bypass gate tests.
 */
import { describe, it, expect } from 'vitest'
import {
  scanFileForBypass,
  isInsideGateway,
  isAdapterStage,
  importsGateway,
  extractImports,
  NETWORK_CALL_RE,
} from '../bypass-gate'

describe('SPEC-130 scan primitives', () => {
  it('classifies gateway files + adapter stage', () => {
    expect(isInsideGateway('src/agent/tool-gateway/stages/policy-decision.ts')).toBe(true)
    expect(isInsideGateway('src/agent/finance/tools.ts')).toBe(false)
    expect(isAdapterStage('src/agent/tool-gateway/stages/execution-adapter.ts')).toBe(true)
  })
  it('detects gateway imports', () => {
    expect(importsGateway(extractImports("import { invokeTool } from '@/agent/tool-gateway'"))).toBe(true)
    expect(importsGateway(extractImports("import x from '@/agent/finance'"))).toBe(false)
  })
  it('network-call regex matches real call sites, not the bare word', () => {
    expect(NETWORK_CALL_RE.test('const r = await fetch(url)')).toBe(true)
    expect(NETWORK_CALL_RE.test('axios.post(u, b)')).toBe(true)
    // requires an actual call — the bare word "fetch" (e.g. "git fetch") does not match
    expect(NETWORK_CALL_RE.test('// we do not fetch here')).toBe(false)
    expect(NETWORK_CALL_RE.test('return advance(ctx)')).toBe(false)
  })
})

describe('SPEC-130 Rule A — gateway core purity', () => {
  it('FLAGS a gateway-core file that calls fetch directly', () => {
    const v = scanFileForBypass('src/agent/tool-gateway/stages/policy-decision.ts', 'const r = await fetch("https://x")')
    expect(v.some((x) => x.kind === 'gateway-core-network-call')).toBe(true)
  })
  it('does NOT flag the adapter stage (sanctioned seam)', () => {
    expect(scanFileForBypass('src/agent/tool-gateway/stages/execution-adapter.ts', 'const r = await fetch("https://x")')).toEqual([])
  })
  it('does NOT flag a commented / opt-out line', () => {
    expect(scanFileForBypass('src/agent/tool-gateway/stages/x.ts', '// await fetch(url)')).toEqual([])
    expect(scanFileForBypass('src/agent/tool-gateway/stages/x.ts', 'await fetch(url) // gateway-adapter-ok')).toEqual([])
  })
  it('does NOT flag a clean gateway file', () => {
    expect(scanFileForBypass('src/agent/tool-gateway/stages/policy-decision.ts', 'return advance(ctx)')).toEqual([])
  })
})

describe('SPEC-130 Rule B — gateway-aware bypass (false-positive-free)', () => {
  it('FLAGS a gateway importer that also fetches directly', () => {
    const src = "import { invokeTool } from '@/agent/tool-gateway'\nawait fetch('https://x')"
    const v = scanFileForBypass('src/agent/some/caller.ts', src)
    expect(v.some((x) => x.kind === 'gateway-aware-bypass')).toBe(true)
  })
  it('does NOT flag legacy code that fetches but never imports the gateway (out of scope)', () => {
    expect(scanFileForBypass('src/agent/finance/legacy.ts', 'await fetch("https://provider")')).toEqual([])
  })
  it('does NOT flag test files', () => {
    expect(scanFileForBypass('src/agent/tool-gateway/__tests__/x.test.ts', 'await fetch("https://x")')).toEqual([])
  })
})
