import type { OrderStatus, CustomerSegment, RiskLevel } from '@/types'

export function cn(...classes: (string | undefined | null | false)[]): string {
  return classes.filter(Boolean).join(' ')
}

export { formatBDT as fmt, fmtNum, formatBDTk, BDT_SYMBOL, MONEY_CLASS } from '@/lib/currency'

export function pct(n: number): string {
  return Math.round(n) + '%'
}

// Theme-aware semantic tone classes (defined in globals.css). The single tone
// class on `text` carries fg + bg + border-color for BOTH light and dark; bg /
// border are kept empty so the badge's own `border` width utility still applies.
// `dot` uses `.tone-dot`, which reads the inherited --tone-dot channel.
export const STATUS_COLORS: Record<OrderStatus, { text: string; bg: string; border: string; dot: string }> = {
  Pending:   { text:'tone-amber',  bg:'', border:'', dot:'tone-dot' },
  Confirmed: { text:'tone-purple', bg:'', border:'', dot:'tone-dot' },
  Packed:    { text:'tone-cyan',   bg:'', border:'', dot:'tone-dot' },
  Shipped:   { text:'tone-blue',   bg:'', border:'', dot:'tone-dot' },
  Delivered: { text:'tone-green',  bg:'', border:'', dot:'tone-dot' },
  Returned:  { text:'tone-red',    bg:'', border:'', dot:'tone-dot' },
  Cancelled: { text:'tone-slate',  bg:'', border:'', dot:'tone-dot' },
  RETURNED:  { text:'tone-red',    bg:'', border:'', dot:'tone-dot' },
  RETURNED_PAID: { text:'tone-amber', bg:'', border:'', dot:'tone-dot' },
  RETURNED_UNPAID: { text:'tone-red', bg:'', border:'', dot:'tone-dot' },
  CANCELLED: { text:'tone-slate',  bg:'', border:'', dot:'tone-dot' },
}

/** Human-readable order status for badges and lists. */
export function orderStatusLabel(status: OrderStatus | string): string {
  const key = String(status).trim().toUpperCase().replace(/\s+/g, '_')
  if (key === 'RETURNED_PAID') return 'Returned (paid)'
  if (key === 'RETURNED_UNPAID' || key === 'FAILED_DELIVERY') return 'Returned (refused)'
  if (key === 'RETURNED') return 'Returned'
  if (key === 'CANCELLED' || key === 'CANCELED') return 'Cancelled'
  return String(status)
}

export const SEG_COLORS: Record<CustomerSegment, { text: string; bg: string; border: string }> = {
  VIP:       { text:'tone-gold',  bg:'', border:'' },
  REGULAR:   { text:'tone-green', bg:'', border:'' },
  NEW:       { text:'tone-blue',  bg:'', border:'' },
  RISKY:     { text:'tone-amber', bg:'', border:'' },
  BLACKLIST: { text:'tone-red',   bg:'', border:'' },
  COLD:      { text:'tone-slate', bg:'', border:'' },
}

export const RISK_COLORS: Record<RiskLevel, { text: string; bg: string }> = {
  LOW:    { text:'tone-green', bg:'' },
  MEDIUM: { text:'tone-amber', bg:'' },
  HIGH:   { text:'tone-red',   bg:'' },
}

export const PAYMENT_COLORS: Record<string, string> = {
  bKash: 'tone-pink',
  Nagad: 'tone-orange',
  COD:   'tone-amber',
  'Bank Transfer': 'tone-blue',
}

export const COURIER_STEPS: Partial<Record<OrderStatus, Array<{ label: string; done: boolean; active: boolean }>>> = {
  Pending:   [{ label:'Placed',    done:true,  active:false }, { label:'Confirmed', done:false, active:true  }, { label:'Packed', done:false, active:false }, { label:'Shipped', done:false, active:false }, { label:'Delivered', done:false, active:false }],
  Confirmed: [{ label:'Placed',    done:true,  active:false }, { label:'Confirmed', done:true,  active:false }, { label:'Packed', done:false, active:true  }, { label:'Shipped', done:false, active:false }, { label:'Delivered', done:false, active:false }],
  Packed:    [{ label:'Placed',    done:true,  active:false }, { label:'Confirmed', done:true,  active:false }, { label:'Packed', done:true,  active:false }, { label:'Shipped', done:false, active:true  }, { label:'Delivered', done:false, active:false }],
  Shipped:   [{ label:'Placed',    done:true,  active:false }, { label:'Confirmed', done:true,  active:false }, { label:'Packed', done:true,  active:false }, { label:'Shipped', done:true,  active:true  }, { label:'Delivered', done:false, active:false }],
  Delivered: [{ label:'Placed',    done:true,  active:false }, { label:'Confirmed', done:true,  active:false }, { label:'Packed', done:true,  active:false }, { label:'Shipped', done:true,  active:false }, { label:'Delivered', done:true,  active:false }],
  Returned:  [{ label:'Placed',    done:true,  active:false }, { label:'Shipped',   done:true,  active:false }, { label:'Returned', done:true, active:false }],
  RETURNED:  [{ label:'Placed',    done:true,  active:false }, { label:'Shipped',   done:true,  active:false }, { label:'Returned', done:true, active:false }],
  RETURNED_PAID: [{ label:'Placed', done:true, active:false }, { label:'Shipped', done:true, active:false }, { label:'Returned (paid)', done:true, active:false }],
  RETURNED_UNPAID: [{ label:'Placed', done:true, active:false }, { label:'Shipped', done:true, active:false }, { label:'Returned (refused)', done:true, active:false }],
  CANCELLED: [{ label:'Placed',    done:true,  active:false }, { label:'Cancelled', done:true, active:false }],
}
