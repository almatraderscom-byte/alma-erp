import { describe, it, expect } from 'vitest'
import {
  detectClaimViolations,
  detectLedgerViolations,
  verifyClaimsAgainstLedger,
  type ToolLedgerEntry,
} from '@/agent/lib/claim-verifier'

// ═══════════════════════════════════════════════════════════════════════════
// Layer 1: Original regex claim detection
// ═══════════════════════════════════════════════════════════════════════════
describe('detectClaimViolations (Layer 1 — regex)', () => {
  it('salah mark claim with no tool call → violation', () => {
    const v = detectClaimViolations(
      'আলহামদুলিল্লাহ! মাগরিব mark করে দিয়েছি।',
      [],
    )
    expect(v.length).toBeGreaterThan(0)
    expect(v[0].category).toBe('salah_mark')
  })

  it('salah mark claim WITH mark_salah → no violation', () => {
    const v = detectClaimViolations(
      'আলহামদুলিল্লাহ! মাগরিব mark করে দিয়েছি।',
      ['mark_salah'],
    )
    expect(v).toHaveLength(0)
  })

  it('memory save claim with no tool → violation', () => {
    const v = detectClaimViolations(
      'ঠিক আছে বস, মনে রাখলাম।',
      [],
    )
    expect(v.length).toBeGreaterThan(0)
    expect(v[0].category).toBe('memory_save')
  })

  it('future intent is not a violation', () => {
    const v = detectClaimViolations(
      'আমি মনে রাখবো এটা।',
      [],
    )
    expect(v).toHaveLength(0)
  })

  it('question form is not a violation', () => {
    const v = detectClaimViolations(
      'মাগরিব পড়েছেন কি?',
      [],
    )
    expect(v).toHaveLength(0)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// Layer 2: Ledger-based general verification
// ═══════════════════════════════════════════════════════════════════════════
describe('detectLedgerViolations (Layer 2 — general)', () => {
  it('completion claim with empty ledger → violation', () => {
    const v = detectLedgerViolations(
      'ঠিক আছে, update করে দিয়েছি।',
      [],
    )
    expect(v.length).toBeGreaterThan(0)
    expect(v[0].category).toBe('general_write')
  })

  it('completion claim with successful write tool → no violation', () => {
    const ledger: ToolLedgerEntry[] = [
      { toolName: 'update_setting', success: true },
    ]
    const v = detectLedgerViolations(
      'ঠিক আছে, update করে দিয়েছি।',
      ledger,
    )
    expect(v).toHaveLength(0)
  })

  it('completion claim with failed write tool → violation', () => {
    const ledger: ToolLedgerEntry[] = [
      { toolName: 'update_setting', success: false, error: 'DB error' },
    ]
    const v = detectLedgerViolations(
      'ঠিক আছে, update করে দিয়েছি।',
      ledger,
    )
    expect(v.length).toBeGreaterThan(0)
    expect(v[0].ruleId).toContain('failed')
  })

  it('completion claim with only read tools → violation', () => {
    const ledger: ToolLedgerEntry[] = [
      { toolName: 'get_sales_summary', success: true },
    ]
    const v = detectLedgerViolations(
      'save করেছি বস, মেমোরিতে সেভ হয়ে গেছে।',
      ledger,
    )
    expect(v.length).toBeGreaterThan(0)
  })

  it('no completion claim → no violation', () => {
    const v = detectLedgerViolations(
      'আজকের sales ১৫,০০০ টাকা।',
      [],
    )
    expect(v).toHaveLength(0)
  })

  it('short text is ignored', () => {
    const v = detectLedgerViolations('ok done', [])
    expect(v).toHaveLength(0)
  })

  it('future intent is not flagged', () => {
    const v = detectLedgerViolations(
      'আমি এটা করার চেষ্টা করব, save করব পরে।',
      [],
    )
    expect(v).toHaveLength(0)
  })

  // Regression: benign read/analysis verbs must NOT trigger a verification
  // rewrite — that re-ran the whole turn for nothing and wasted tokens.
  it('benign "চেক করেছি" read reply with read tool → no violation', () => {
    const v = detectLedgerViolations(
      'চেক করেছি বস — এখন ৩টা pending order আছে, কোনোটাই এখনো confirm হয়নি।',
      [{ toolName: 'get_orders', success: true }],
    )
    expect(v).toHaveLength(0)
  })

  it('benign "যাচাই করেছি" analysis reply → no violation', () => {
    const v = detectLedgerViolations(
      'হিসাব যাচাই করেছি — গত ৭ দিনের গড় বিক্রি প্রায় ৮০ টাকা/দিন।',
      [{ toolName: 'get_sales_summary', success: true }],
    )
    expect(v).toHaveLength(0)
  })

  it('passive "পুরোনো হয়ে গেছে" state report → no violation', () => {
    const v = detectLedgerViolations(
      'অর্ডারটা প্রায় ৬ দিন পুরোনো হয়ে গেছে, এখনো confirm হয়নি।',
      [{ toolName: 'get_orders', success: true }],
    )
    expect(v).toHaveLength(0)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// Combined: verifyClaimsAgainstLedger
// ═══════════════════════════════════════════════════════════════════════════
describe('verifyClaimsAgainstLedger (combined)', () => {
  it('regex violation takes priority over ledger check', () => {
    const v = verifyClaimsAgainstLedger(
      'মাগরিব mark করে দিয়েছি।',
      [],
    )
    expect(v.length).toBeGreaterThan(0)
    expect(v[0].category).toBe('salah_mark')
  })

  it('general claim caught when no regex matches', () => {
    const v = verifyClaimsAgainstLedger(
      'ঠিক আছে বস, সব update করে দিয়েছি settings e।',
      [],
    )
    expect(v.length).toBeGreaterThan(0)
    expect(v[0].category).toBe('general_write')
  })

  it('honest reply with matching tools → no violations', () => {
    const v = verifyClaimsAgainstLedger(
      'আলহামদুলিল্লাহ! মাগরিব mark করে দিয়েছি।',
      [{ toolName: 'mark_salah', success: true }],
    )
    expect(v).toHaveLength(0)
  })
})
