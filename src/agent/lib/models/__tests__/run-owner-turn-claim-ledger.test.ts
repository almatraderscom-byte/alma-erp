import { describe, it, expect } from 'vitest'
import {
  detectClaimViolations,
  verifyClaimsAgainstLedger,
  type ToolLedgerEntry,
} from '@/agent/lib/claim-verifier'

// Audit #6: runOwnerTurn (the head loop, incl. the cheap DeepSeek/Qwen heads)
// used to verify completion claims with detectClaimViolations(text, toolNames) —
// the Layer-1, name-ONLY check. That path only asks "was a tool of the right
// name called this turn?" and is blind to whether the call SUCCEEDED. So a reply
// that claims "save করেছি" right after save_memory THREW was treated as honest.
//
// The fix builds a ToolLedgerEntry[] from toolRecords (carrying status + error)
// and runs verifyClaimsAgainstLedger, which adds the Layer-2 ledger check. These
// tests pin the exact mapping the head loop now performs and prove the failure
// case is caught.

type ToolRecord = { toolName: string; status: 'success' | 'error'; error: string | null }

// Mirror of the mapping inside runOwnerTurn after the fix.
function ledgerFromRecords(records: ToolRecord[]): ToolLedgerEntry[] {
  return records.map((r) => ({
    toolName: r.toolName,
    success: r.status === 'success',
    error: r.error ?? undefined,
  }))
}

describe('runOwnerTurn claim verification — honors tool failure (audit #6)', () => {
  const claim = 'আলহামদুলিল্লাহ বস, মনে রেখেছি — save করেছি।'

  it('OLD name-only path is fooled: a failed save_memory still looks satisfied', () => {
    // Reproduces the bug: Layer-1 sees the tool name present → no violation,
    // even though the call failed. (Regression guard for what we moved away from.)
    const records: ToolRecord[] = [{ toolName: 'save_memory', status: 'error', error: 'DB write failed' }]
    const names = records.map((r) => r.toolName)
    const v = detectClaimViolations(claim, names)
    expect(v).toHaveLength(0)
  })

  it('NEW ledger path catches the false "done" after a FAILED tool', () => {
    const records: ToolRecord[] = [{ toolName: 'save_memory', status: 'error', error: 'DB write failed' }]
    const v = verifyClaimsAgainstLedger(claim, ledgerFromRecords(records))
    expect(v.length).toBeGreaterThan(0)
  })

  it('ledger path stays quiet when the tool actually SUCCEEDED', () => {
    const records: ToolRecord[] = [{ toolName: 'save_memory', status: 'success', error: null }]
    const v = verifyClaimsAgainstLedger(claim, ledgerFromRecords(records))
    expect(v).toHaveLength(0)
  })

  it('a generic completion claim with NO write tool at all is flagged', () => {
    const v = verifyClaimsAgainstLedger('কাজটা সম্পন্ন হয়েছে বস।', ledgerFromRecords([]))
    expect(v.length).toBeGreaterThan(0)
  })
})
