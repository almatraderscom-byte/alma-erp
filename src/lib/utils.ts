import type { OrderStatus, CustomerSegment, RiskLevel } from '@/types'

export function cn(...classes: (string | undefined | null | false)[]): string {
  return classes.filter(Boolean).join(' ')
}

export { formatBDT as fmt, fmtNum, formatBDTk, BDT_SYMBOL, MONEY_CLASS } from '@/lib/currency'

export function pct(n: number): string {
  return Math.round(n) + '%'
}

export const STATUS_COLORS: Record<OrderStatus, { text: string; bg: string; border: string; dot: string }> = {
  Pending:   { text:'text-amber-700',  bg:'bg-amber-50',  border:'border-amber-200',  dot:'bg-amber-500'  },
  Confirmed: { text:'text-purple-700', bg:'bg-purple-50', border:'border-purple-200', dot:'bg-purple-500' },
  Packed:    { text:'text-cyan-700',   bg:'bg-cyan-50',   border:'border-cyan-200',   dot:'bg-cyan-500'   },
  Shipped:   { text:'text-blue-700',   bg:'bg-blue-50',   border:'border-blue-200',   dot:'bg-blue-500'   },
  Delivered: { text:'text-green-700',  bg:'bg-green-50',  border:'border-green-200',  dot:'bg-green-500'  },
  Returned:  { text:'text-red-700',    bg:'bg-red-50',    border:'border-red-200',    dot:'bg-red-500'    },
  Cancelled: { text:'text-slate-600',  bg:'bg-slate-50',  border:'border-slate-200',  dot:'bg-slate-400'  },
  RETURNED:  { text:'text-red-700',    bg:'bg-red-50',    border:'border-red-200',    dot:'bg-red-500'    },
  RETURNED_PAID: { text:'text-amber-700', bg:'bg-amber-50', border:'border-amber-200', dot:'bg-amber-500' },
  RETURNED_UNPAID: { text:'text-red-700', bg:'bg-red-50', border:'border-red-200', dot:'bg-red-500' },
  CANCELLED: { text:'text-slate-600',  bg:'bg-slate-50',  border:'border-slate-200',  dot:'bg-slate-400'  },
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
  VIP:       { text:'text-gold-dim',   bg:'bg-gold/10',       border:'border-gold/30'         },
  REGULAR:   { text:'text-green-700',  bg:'bg-green-50',      border:'border-green-200'       },
  NEW:       { text:'text-blue-700',   bg:'bg-blue-50',       border:'border-blue-200'        },
  RISKY:     { text:'text-amber-700',  bg:'bg-amber-50',      border:'border-amber-200'       },
  BLACKLIST: { text:'text-red-700',    bg:'bg-red-50',        border:'border-red-200'         },
  COLD:      { text:'text-slate-600',  bg:'bg-slate-50',      border:'border-slate-200'       },
}

export const RISK_COLORS: Record<RiskLevel, { text: string; bg: string }> = {
  LOW:    { text:'text-green-700', bg:'bg-green-50' },
  MEDIUM: { text:'text-amber-700', bg:'bg-amber-50' },
  HIGH:   { text:'text-red-700',   bg:'bg-red-50'   },
}

export const PAYMENT_COLORS: Record<string, string> = {
  bKash: 'text-pink-700 bg-pink-50 border-pink-200',
  Nagad: 'text-orange-700 bg-orange-50 border-orange-200',
  COD:   'text-amber-700 bg-amber-50 border-amber-200',
  'Bank Transfer': 'text-blue-700 bg-blue-50 border-blue-200',
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
