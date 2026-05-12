'use client'
import { motion } from 'framer-motion'
import { cn } from '@/lib/utils'
import type { OrderStatus, CustomerSegment, RiskLevel } from '@/types'
import { STATUS_COLORS, SEG_COLORS, RISK_COLORS, PAYMENT_COLORS } from '@/lib/utils'

// ── Skeleton ─────────────────────────────────────────────────────────────
export function Skeleton({ className }: { className?: string }) {
  return <div className={cn('skeleton rounded-lg', className)} />
}

// ── Card ─────────────────────────────────────────────────────────────────
export function Card({ children, className, gold }: { children: React.ReactNode; className?: string; gold?: boolean }) {
  return (
    <div className={cn('bg-card rounded-2xl border', gold ? 'border-gold-dim/50' : 'border-border', className)}>
      {children}
    </div>
  )
}

// ── KPI Card ──────────────────────────────────────────────────────────────
export function KpiCard({ label, value, sub, delta, color, loading }: {
  label: string; value: string | number; sub?: string; delta?: number; color?: string; loading?: boolean
}) {
  return (
    <Card className="p-5">
      {loading ? (
        <><Skeleton className="h-3 w-20 mb-4" /><Skeleton className="h-8 w-24 mb-2" /><Skeleton className="h-3 w-28" /></>
      ) : (
        <>
          <p className="text-[10px] font-bold tracking-[0.12em] uppercase text-muted mb-2">{label}</p>
          <p className={cn('text-2xl font-bold tracking-tight', color ?? 'text-cream')}>{value}</p>
          {sub && <p className="text-[11px] text-zinc-500 mt-1">{sub}</p>}
          {delta !== undefined && (
            <p className={cn('text-[11px] font-semibold mt-1.5', delta > 0 ? 'text-green-400' : 'text-red-400')}>
              {delta > 0 ? '▲' : '▼'} {Math.abs(delta)}% vs last month
            </p>
          )}
        </>
      )}
    </Card>
  )
}

// ── Status Badge ──────────────────────────────────────────────────────────
export function StatusBadge({ status }: { status: OrderStatus }) {
  const c = STATUS_COLORS[status] ?? STATUS_COLORS.Cancelled
  return (
    <span className={cn('inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[10px] font-bold border', c.text, c.bg, c.border)}>
      <span className={cn('w-1.5 h-1.5 rounded-full', c.dot)} />
      {status}
    </span>
  )
}

// ── Segment Badge ─────────────────────────────────────────────────────────
export function SegmentBadge({ segment }: { segment: CustomerSegment }) {
  const c = SEG_COLORS[segment] ?? SEG_COLORS.COLD
  return (
    <span className={cn('inline-flex items-center px-2.5 py-1 rounded-full text-[10px] font-bold border', c.text, c.bg, c.border)}>
      {segment === 'VIP' ? '✦ ' : ''}{segment}
    </span>
  )
}

// ── Risk Badge ────────────────────────────────────────────────────────────
export function RiskBadge({ level }: { level: RiskLevel }) {
  const c = RISK_COLORS[level] ?? RISK_COLORS.LOW
  return (
    <span className={cn('inline-flex items-center px-2.5 py-1 rounded-full text-[10px] font-bold', c.text, c.bg)}>
      {level}
    </span>
  )
}

// ── Payment Tag ───────────────────────────────────────────────────────────
export function PaymentTag({ method }: { method: string }) {
  const cls = PAYMENT_COLORS[method] ?? 'text-zinc-400 bg-zinc-400/10 border-zinc-400/20'
  return <span className={cn('inline-flex items-center px-2 py-0.5 rounded-md text-[10px] font-bold border', cls)}>{method}</span>
}

// ── Progress Bar ──────────────────────────────────────────────────────────
export function Progress({ value, max = 100, color = 'bg-gold', className }: { value: number; max?: number; color?: string; className?: string }) {
  const pct = Math.min(100, Math.round(value / max * 100))
  return (
    <div className={cn('h-1 bg-border rounded-full overflow-hidden', className)}>
      <motion.div className={cn('h-full rounded-full', color)} initial={{ width: 0 }} animate={{ width: `${pct}%` }} transition={{ duration: 0.6, ease: 'easeOut' }} />
    </div>
  )
}

// ── Gold Divider ──────────────────────────────────────────────────────────
export function GoldDivider({ className }: { className?: string }) {
  return <div className={cn('h-px bg-gradient-to-r from-transparent via-gold-dim to-transparent', className)} />
}

// ── Page Header ───────────────────────────────────────────────────────────
export function PageHeader({ title, subtitle, actions }: { title: string; subtitle?: string; actions?: React.ReactNode }) {
  return (
    <div className="sticky top-0 z-20 bg-surface/95 backdrop-blur border-b border-border px-4 md:px-8 py-4 flex items-center justify-between gap-4">
      <div>
        <h1 className="text-base md:text-lg font-bold text-cream tracking-tight">{title}</h1>
        {subtitle && <p className="text-[11px] text-zinc-500 mt-0.5">{subtitle}</p>}
      </div>
      {actions && <div className="flex items-center gap-2 shrink-0">{actions}</div>}
    </div>
  )
}

// ── Button ────────────────────────────────────────────────────────────────
export function Button({ children, onClick, variant = 'ghost', size = 'sm', disabled, className, type = 'button' }: {
  children: React.ReactNode; onClick?: () => void; variant?: 'gold' | 'ghost' | 'danger'; size?: 'xs' | 'sm' | 'md'; disabled?: boolean; className?: string; type?: 'button' | 'submit'
}) {
  const base = 'inline-flex items-center gap-2 font-semibold rounded-xl transition-all duration-150 disabled:opacity-40 active:scale-[0.97]'
  const sizes = { xs: 'px-2.5 py-1.5 text-[11px]', sm: 'px-3.5 py-2 text-xs', md: 'px-5 py-2.5 text-sm' }
  const variants = {
    gold:  'bg-gold/10 border border-gold-dim/50 text-gold-lt hover:bg-gold/20',
    ghost: 'bg-transparent border border-border text-zinc-400 hover:bg-white/[0.04] hover:text-cream',
    danger:'bg-red-400/10 border border-red-400/30 text-red-400 hover:bg-red-400/20',
  }
  return (
    <button type={type} onClick={onClick} disabled={disabled} className={cn(base, sizes[size], variants[variant], className)}>
      {children}
    </button>
  )
}

// ── Search Input ──────────────────────────────────────────────────────────
export function SearchInput({ value, onChange, placeholder }: { value: string; onChange: (v: string) => void; placeholder?: string }) {
  return (
    <div className="relative">
      <span className="absolute left-3 top-1/2 -translate-y-1/2 text-zinc-500 text-sm">⌕</span>
      <input
        value={value} onChange={e => onChange(e.target.value)} placeholder={placeholder ?? 'Search…'}
        className="w-full bg-card border border-border rounded-xl pl-9 pr-4 py-2.5 text-sm text-cream placeholder-zinc-600 focus:outline-none focus:border-gold-dim/60 transition-colors"
      />
    </div>
  )
}

// ── Select ────────────────────────────────────────────────────────────────
export function Select({ value, onChange, options, className }: {
  value: string; onChange: (v: string) => void; options: { label: string; value: string }[]; className?: string
}) {
  return (
    <select value={value} onChange={e => onChange(e.target.value)}
      className={cn('bg-card border border-border rounded-xl px-3 py-2.5 text-sm text-cream focus:outline-none focus:border-gold-dim/60 transition-colors cursor-pointer', className)}>
      {options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
    </select>
  )
}

// ── Stat Row ─────────────────────────────────────────────────────────────
export function StatRow({ label, value, valueClass }: { label: string; value: string | number; valueClass?: string }) {
  return (
    <div className="flex items-center justify-between py-2 border-b border-border/50 last:border-0">
      <span className="text-[11px] text-zinc-500">{label}</span>
      <span className={cn('text-[12px] font-bold', valueClass ?? 'text-cream')}>{value}</span>
    </div>
  )
}

// ── Avatar ────────────────────────────────────────────────────────────────
export function Avatar({ name, size = 'sm', vip }: { name: string; size?: 'sm' | 'md' | 'lg'; vip?: boolean }) {
  const initials = name.split(' ').map(n => n[0]).join('').slice(0, 2).toUpperCase()
  const sizes = { sm: 'w-8 h-8 text-[11px]', md: 'w-10 h-10 text-sm', lg: 'w-12 h-12 text-base' }
  return (
    <div className={cn('rounded-full flex items-center justify-center font-black shrink-0', sizes[size], vip ? 'bg-gold/10 border border-gold-dim/40 text-gold-lt' : 'bg-white/[0.06] border border-white/[0.08] text-zinc-400')}>
      {initials}
    </div>
  )
}

// ── Loading Spinner ───────────────────────────────────────────────────────
export function Spinner({ size = 'sm' }: { size?: 'sm' | 'md' | 'lg' }) {
  const s = { sm: 'w-4 h-4 border-2', md: 'w-6 h-6 border-2', lg: 'w-8 h-8 border-2' }
  return <div className={cn('rounded-full border-gold-dim border-t-gold animate-spin', s[size])} />
}

// ── Empty State ───────────────────────────────────────────────────────────
export function Empty({ icon, title, desc }: { icon: string; title: string; desc?: string }) {
  return (
    <div className="flex flex-col items-center justify-center py-16 text-center">
      <span className="text-5xl mb-4 opacity-20">{icon}</span>
      <p className="text-sm font-semibold text-zinc-400 mb-1">{title}</p>
      {desc && <p className="text-[11px] text-zinc-600">{desc}</p>}
    </div>
  )
}

// ── CLV Bar ───────────────────────────────────────────────────────────────
export function ClvBar({ score }: { score: number }) {
  const color = score > 60 ? 'bg-gold' : score > 30 ? 'bg-amber-500' : 'bg-zinc-600'
  return (
    <div className="flex items-center gap-2">
      <div className="flex-1 h-1 bg-border rounded-full overflow-hidden">
        <motion.div className={cn('h-full rounded-full', color)} initial={{ width: 0 }} animate={{ width: `${score}%` }} transition={{ duration: 0.5 }} />
      </div>
      <span className={cn('text-[11px] font-bold w-6 text-right tabular-nums', score > 60 ? 'text-gold' : 'text-zinc-500')}>{score}</span>
    </div>
  )
}
