import { describe, it, expect, beforeEach } from 'vitest'
import { TOOLS } from '@/agent/tools/registry'
import { TOOL_GROUPS } from '@/agent/tools/tool-groups'
import { clearServiceAdapters, getServiceAdapter } from '@/agent/lib/integrations/service-registry'
import { bootstrapServiceAdapters, resetBootstrapFlag } from '@/agent/lib/integrations/bootstrap'

/**
 * Phase 66 — the Personal/Business OS tool families are now REACHABLE (GAP-06:
 * they had 0 references in the registry/groups). These are the golden routing
 * proofs the roadmap asks for.
 */

const OS_TOOLS = ['personal_os_read', 'personal_os_stage', 'business_os_read', 'business_os_stage']

describe('OS tools reachable from the head', () => {
  it('every OS tool is in the executable TOOLS pool', () => {
    const names = new Set(TOOLS.map((t) => t.name))
    for (const t of OS_TOOLS) expect(names.has(t), t).toBe(true)
  })

  it('the personal group exposes the personal-OS tools', () => {
    const names = new Set(TOOL_GROUPS.personal.map((t) => t.name))
    expect(names.has('personal_os_read')).toBe(true)
    expect(names.has('personal_os_stage')).toBe(true)
  })

  it('the erp group exposes the business-OS tools', () => {
    const names = new Set(TOOL_GROUPS.erp.map((t) => t.name))
    expect(names.has('business_os_read')).toBe(true)
    expect(names.has('business_os_stage')).toBe(true)
  })
})

describe('bootstrap registers the internal adapters (idempotent)', () => {
  beforeEach(() => {
    clearServiceAdapters()
    resetBootstrapFlag()
  })

  it('registers personal-records + erp-orders with memory stores in dev/test', async () => {
    const r = await bootstrapServiceAdapters({ allowMemory: true })
    expect(r.registered).toContain('personal-records')
    expect(r.registered).toContain('erp-orders')
    expect(getServiceAdapter('personal-records')?.scope).toBe('personal')
    expect(getServiceAdapter('erp-orders')?.scope).toBe('business')
  })

  it('is idempotent — a second bootstrap registers nothing new', async () => {
    await bootstrapServiceAdapters({ allowMemory: true })
    const second = await bootstrapServiceAdapters({ allowMemory: true })
    expect(second.registered).toEqual([])
  })
})
