import { describe, it, expect, vi, afterEach } from 'vitest'
import type { ToolLedgerEntry } from '../claim-verifier'

afterEach(() => {
  vi.unstubAllEnvs()
  vi.resetModules()
})

async function loadDetector() {
  return (await import('../claim-verifier')).detectFabricatedStatViolations
}

const noTools: ToolLedgerEntry[] = []

describe('detectFabricatedStatViolations (P1 — fact gate)', () => {
  it('is a no-op when AGENT_FACT_GATE is off (default)', async () => {
    vi.resetModules()
    const detect = await loadDetector()
    expect(detect('আজ ৫টি অর্ডার হয়েছে', noTools)).toEqual([])
  })

  it('flags a live-data figure stated with no successful read', async () => {
    vi.stubEnv('AGENT_FACT_GATE', 'on')
    vi.resetModules()
    const detect = await loadDetector()
    expect(detect('আজ ৫টি অর্ডার হয়েছে', noTools)).toHaveLength(1)
    expect(detect('stock 12 আছে', noTools)).toHaveLength(1)
    expect(detect('আজকের বিক্রি ৩০০০ টাকা', noTools)).toHaveLength(1)
  })

  it('does NOT flag when a read tool succeeded (figure is grounded)', async () => {
    vi.stubEnv('AGENT_FACT_GATE', 'on')
    vi.resetModules()
    const detect = await loadDetector()
    const ledger: ToolLedgerEntry[] = [{ toolName: 'get_orders_today', success: true }]
    expect(detect('আজ ৫টি অর্ডার হয়েছে', ledger)).toEqual([])
  })

  it('does NOT flag when the reply already hedges', async () => {
    vi.stubEnv('AGENT_FACT_GATE', 'on')
    vi.resetModules()
    const detect = await loadDetector()
    expect(detect('আনুমানিক ৫টি অর্ডার হতে পারে, যাচাই করে দেখিনি', noTools)).toEqual([])
  })

  it('does NOT flag a non-data number or a greeting', async () => {
    vi.stubEnv('AGENT_FACT_GATE', 'on')
    vi.resetModules()
    const detect = await loadDetector()
    expect(detect('৫ মিনিট পরে কথা হবে', noTools)).toEqual([])
    expect(detect('শুভ সকাল বস', noTools)).toEqual([])
  })
})
