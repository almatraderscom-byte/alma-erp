/**
 * CS auto-reply hard stops — always escalate to human, never auto-send.
 */
export type HardStopCategory =
  | 'refund'
  | 'complaint'
  | 'price_negotiation'
  | 'abuse'
  | null

const REFUND = [
  /refund|return|money\s*back|chargeback/i,
  /রিফান্ড|ফেরত|টাকা\s*ফের|মানি\s*ব্যাক/i,
]
const COMPLAINT = [
  /complain|scam|fraud|cheat|worst|disappoint/i,
  /অভিযোগ|প্রতারণ|ঠক|বাজে|খারাপ\s*সার্ভিস|scam/i,
]
const PRICE_NEG = [
  /discount|cheaper|less\s*price|lowest|best\s*price|offer\s*me/i,
  /কম\s*দাম|ডিসকাউন্ট|ছাড়|কম\s*কর|সস্তা|দাম\s*কম/i,
]

export function detectHardStopCategory(text: string): HardStopCategory {
  const t = text.trim()
  if (!t) return null
  if (REFUND.some((r) => r.test(t))) return 'refund'
  if (COMPLAINT.some((r) => r.test(t))) return 'complaint'
  if (PRICE_NEG.some((r) => r.test(t))) return 'price_negotiation'
  return null
}

export function hardStopBlocksAuto(category: HardStopCategory): boolean {
  return category !== null
}

export function hardStopLabel(category: HardStopCategory): string {
  switch (category) {
    case 'refund': return 'refund/return'
    case 'complaint': return 'complaint'
    case 'price_negotiation': return 'price negotiation'
    case 'abuse': return 'abuse'
    default: return 'unknown'
  }
}
