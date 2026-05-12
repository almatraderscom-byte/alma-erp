import type { OrderStatus, CustomerSegment, RiskLevel } from '@/types'

export function cn(...classes: (string | undefined | null | false)[]): string {
  return classes.filter(Boolean).join(' ')
}

export function fmt(n: number): string {
  return '৳' + Math.round(n).toLocaleString('en-IN')
}

export function fmtNum(n: number): string {
  return Math.round(n).toLocaleString('en-IN')
}

export function pct(n: number): string {
  return Math.round(n) + '%'
}

export const STATUS_COLORS: Record<OrderStatus, { text: string; bg: string; border: string; dot: string }> = {
  Pending:   { text:'text-amber-400',  bg:'bg-amber-400/10',  border:'border-amber-400/30',  dot:'bg-amber-400'  },
  Confirmed: { text:'text-purple-400', bg:'bg-purple-400/10', border:'border-purple-400/30', dot:'bg-purple-400' },
  Packed:    { text:'text-cyan-400',   bg:'bg-cyan-400/10',   border:'border-cyan-400/30',   dot:'bg-cyan-400'   },
  Shipped:   { text:'text-blue-400',   bg:'bg-blue-400/10',   border:'border-blue-400/30',   dot:'bg-blue-400'   },
  Delivered: { text:'text-green-400',  bg:'bg-green-400/10',  border:'border-green-400/30',  dot:'bg-green-400'  },
  Returned:  { text:'text-red-400',    bg:'bg-red-400/10',    border:'border-red-400/30',    dot:'bg-red-400'    },
  Cancelled: { text:'text-zinc-500',   bg:'bg-zinc-500/10',   border:'border-zinc-500/30',   dot:'bg-zinc-500'   },
}

export const SEG_COLORS: Record<CustomerSegment, { text: string; bg: string; border: string }> = {
  VIP:       { text:'text-gold-lt',   bg:'bg-gold/10',       border:'border-gold-dim/50'     },
  REGULAR:   { text:'text-green-400', bg:'bg-green-400/10',  border:'border-green-400/30'    },
  NEW:       { text:'text-blue-400',  bg:'bg-blue-400/10',   border:'border-blue-400/30'     },
  RISKY:     { text:'text-amber-400', bg:'bg-amber-400/10',  border:'border-amber-400/30'    },
  BLACKLIST: { text:'text-red-400',   bg:'bg-red-400/10',    border:'border-red-400/30'      },
  COLD:      { text:'text-zinc-500',  bg:'bg-zinc-500/10',   border:'border-zinc-500/30'     },
}

export const RISK_COLORS: Record<RiskLevel, { text: string; bg: string }> = {
  LOW:    { text:'text-green-400', bg:'bg-green-400/10' },
  MEDIUM: { text:'text-amber-400', bg:'bg-amber-400/10' },
  HIGH:   { text:'text-red-400',   bg:'bg-red-400/10'   },
}

export const PAYMENT_COLORS: Record<string, string> = {
  bKash: 'text-pink-400 bg-pink-400/10 border-pink-400/30',
  Nagad: 'text-orange-400 bg-orange-400/10 border-orange-400/30',
  COD:   'text-amber-400 bg-amber-400/10 border-amber-400/30',
  'Bank Transfer': 'text-blue-400 bg-blue-400/10 border-blue-400/30',
}

export const COURIER_STEPS: Partial<Record<OrderStatus, Array<{ label: string; done: boolean; active: boolean }>>> = {
  Pending:   [{ label:'Placed',    done:true,  active:false }, { label:'Confirmed', done:false, active:true  }, { label:'Packed', done:false, active:false }, { label:'Shipped', done:false, active:false }, { label:'Delivered', done:false, active:false }],
  Confirmed: [{ label:'Placed',    done:true,  active:false }, { label:'Confirmed', done:true,  active:false }, { label:'Packed', done:false, active:true  }, { label:'Shipped', done:false, active:false }, { label:'Delivered', done:false, active:false }],
  Packed:    [{ label:'Placed',    done:true,  active:false }, { label:'Confirmed', done:true,  active:false }, { label:'Packed', done:true,  active:false }, { label:'Shipped', done:false, active:true  }, { label:'Delivered', done:false, active:false }],
  Shipped:   [{ label:'Placed',    done:true,  active:false }, { label:'Confirmed', done:true,  active:false }, { label:'Packed', done:true,  active:false }, { label:'Shipped', done:true,  active:true  }, { label:'Delivered', done:false, active:false }],
  Delivered: [{ label:'Placed',    done:true,  active:false }, { label:'Confirmed', done:true,  active:false }, { label:'Packed', done:true,  active:false }, { label:'Shipped', done:true,  active:false }, { label:'Delivered', done:true,  active:false }],
  Returned:  [{ label:'Placed',    done:true,  active:false }, { label:'Shipped',   done:true,  active:false }, { label:'Returned', done:true, active:false }],
}
