/**
 * Bangla output gate for cheap-model paths — customer-facing copy must pass before send.
 */
import { enforceIslamicGreeting } from '@/agent/lib/islamic-greeting'

const CUSTOMER_FACING_HARAM = [
  /\b(wine|beer|vodka|whiskey|alcohol)\b/i,
  /\b(মদ|মদিরা|বিয়ার)\b/u,
  /নমস্কার|namaste|namaskar/i,
]

export type BanglaGateOptions = {
  /** Content may reach customers (captions, CS drafts). */
  customerFacing?: boolean
}

/**
 * Apply brand/QC checks to cheap-model Bangla. Throws if output fails hard checks.
 */
export function gateCheapModelBanglaOutput(text: string, opts: BanglaGateOptions = {}): string {
  let out = enforceIslamicGreeting(text.trim())
  if (!opts.customerFacing) return out

  for (const pattern of CUSTOMER_FACING_HARAM) {
    if (pattern.test(out)) {
      throw new Error('cheap_model_bangla_qc_failed: output failed brand/QC gate')
    }
  }
  if (out.length < 8) {
    throw new Error('cheap_model_bangla_qc_failed: output too short for customer-facing send')
  }
  return out
}

export function needsCustomerFacingBanglaGate(role: string, tier: string): boolean {
  return role === 'content' && tier !== 'critical'
}
