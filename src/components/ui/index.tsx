'use client'
import { motion } from 'framer-motion'
import { BDT_SYMBOL, fmtNum } from '@/lib/currency'
import { cn } from '@/lib/utils'
import { BdtText, Money } from '@/components/ui/Currency'
import { ResponsiveKpiValue, type KpiValueKind } from '@/components/ui/ResponsiveKpiValue'
import type { OrderStatus, CustomerSegment, RiskLevel } from '@/types'

export { Money, BdtText } from '@/components/ui/Currency'
export { SearchableSelect, type SearchableSelectOption } from '@/components/ui/SearchableSelect'
import { STATUS_COLORS, SEG_COLORS, RISK_COLORS, PAYMENT_COLORS, orderStatusLabel } from '@/lib/utils'
import { PageActionBar } from '@/components/layout/PageActionBar'
import { AgentLauncherButton } from '@/components/layout/AgentAccess'
import { AlertsActionButton } from '@/components/notifications/AlertsActionButton'
import { usePathname } from 'next/navigation'
import { PLATFORM_Z } from '@/lib/platform-z-index'

// ── Skeleton ─────────────────────────────────────────────────────────────
export function Skeleton({ className }: { className?: string }) {
  return <div className={cn('skeleton rounded-lg', className)} />
}

// ── Card ─────────────────────────────────────────────────────────────────
export function Card({
  children,
  className,
  gold,
  interactive,
}: {
  children: React.ReactNode
  className?: string
  gold?: boolean
  /** Subtle hover lift — presentation only. */
  interactive?: boolean
}) {
  return (
    <div
      className={cn(
        'min-w-0 rounded-2xl border bg-card',
        gold ? 'border-gold-dim/50' : 'border-border',
        interactive && 'card-interactive',
        className,
      )}
    >
      {children}
    </div>
  )
}

/** Auto-fit KPI row: ~5 on desktop, 2–3 on tablet, 1–2 on mobile. */
export const KPI_AUTO_GRID =
  'grid gap-3 [grid-template-columns:repeat(auto-fit,minmax(min(100%,9.75rem),1fr))]'

// ── KPI Card ──────────────────────────────────────────────────────────────
export function KpiCard({ label, value, sub, delta, color, loading, valueKind }: {
  label: string
  value: string | number
  sub?: string
  delta?: number
  color?: string
  loading?: boolean
  /** Responsive compact/full formatting for numeric KPI values. */
  valueKind?: KpiValueKind | 'plain'
}) {
  const valueColor = color ?? 'text-cream'

  return (
    <Card className="kpi-card min-w-0 p-3.5 sm:p-4 md:p-5">
      {loading ? (
        <><Skeleton className="mb-3 h-3 w-20" /><Skeleton className="mb-2 h-8 w-24" /><Skeleton className="h-3 w-28" /></>
      ) : (
        <div className="flex min-w-0 flex-col gap-1">
          <p className="text-[10px] font-bold uppercase leading-snug tracking-[0.1em] text-muted line-clamp-2">
            {label}
          </p>
          <div className="min-w-0">
            {typeof value === 'number' ? (
              valueKind === 'plain' ? (
                <p className={cn('min-w-0 max-w-full font-bold tabular-nums leading-tight tracking-tight text-[clamp(0.8125rem,0.55rem+1.1vw,1.375rem)]', valueColor)}>
                  {fmtNum(value)}
                </p>
              ) : (
                <ResponsiveKpiValue
                  amount={value}
                  kind={valueKind === 'number' ? 'number' : valueKind === 'usdt' ? 'usdt' : 'currency'}
                  className={valueColor}
                />
              )
            ) : typeof value === 'string' && value.includes(BDT_SYMBOL) ? (
              <BdtText
                value={value}
                className={cn(
                  'block min-w-0 max-w-full font-bold tabular-nums leading-tight tracking-tight break-words text-[clamp(0.8125rem,0.55rem+1.1vw,1.375rem)]',
                  valueColor,
                )}
              />
            ) : (
              <p
                className={cn(
                  'min-w-0 max-w-full font-bold tabular-nums leading-tight tracking-tight break-words text-[clamp(0.8125rem,0.55rem+1.1vw,1.375rem)]',
                  valueColor,
                )}
              >
                {value}
              </p>
            )}
          </div>
          {sub && <p className="mt-0.5 text-[11px] leading-snug text-zinc-500">{sub}</p>}
          {delta !== undefined && (
            <p className={cn('text-[11px] font-semibold', delta > 0 ? 'text-green-400' : 'text-red-400')}>
              {delta > 0 ? '▲' : '▼'} {Math.abs(delta)}% vs last month
            </p>
          )}
        </div>
      )}
    </Card>
  )
}

// ── Status Badge ──────────────────────────────────────────────────────────
export function StatusBadge({ status }: { status: OrderStatus }) {
  const c = STATUS_COLORS[status] ?? STATUS_COLORS.Cancelled
  const label = orderStatusLabel(status)
  return (
    <span className={cn('inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[10px] font-bold border', c.text, c.bg, c.border)}>
      <span className={cn('w-1.5 h-1.5 rounded-full', c.dot)} />
      {label}
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
const PAGE_HEADER_NO_ALERTS = ['/login', '/forgot-password', '/reset-password', '/invoice/share']

export function PageHeader({
  title,
  subtitle,
  actions,
  showAlerts = true,
}: {
  title: string
  subtitle?: React.ReactNode
  actions?: React.ReactNode
  /** Desktop in-header Alerts control (mobile uses bottom nav). */
  showAlerts?: boolean
}) {
  const pathname = usePathname() ?? ''
  const hideChrome = PAGE_HEADER_NO_ALERTS.some(prefix => pathname.startsWith(prefix))
  const hasActions = Boolean(actions) || (showAlerts && !hideChrome) || !hideChrome

  return (
    <header
      className="page-header sticky top-0 border-b border-border bg-surface/95 px-4 py-4 backdrop-blur md:px-8"
      style={{ zIndex: PLATFORM_Z.stickyBanner }}
    >
      <div className="grid grid-cols-1 gap-3 xl:grid-cols-[minmax(0,1fr)_auto] xl:items-center xl:gap-4">
        <div className="min-w-0">
          <h1 className="truncate text-base font-bold tracking-tight text-cream md:text-lg">{title}</h1>
          {subtitle != null && subtitle !== '' && (
            <p className="mt-0.5 truncate text-[11px] text-zinc-500">{subtitle}</p>
          )}
        </div>
        {hasActions && (
          <PageActionBar className="xl:justify-end">
            {actions}
            {!hideChrome && <AgentLauncherButton className="hidden md:inline-flex" />}
            {showAlerts && !hideChrome && (
              <AlertsActionButton className="hidden md:inline-flex" />
            )}
          </PageActionBar>
        )}
      </div>
    </header>
  )
}

// ── Button ────────────────────────────────────────────────────────────────
export function Button({
  children,
  onClick,
  variant = 'ghost',
  size = 'sm',
  disabled,
  loading,
  className,
  type = 'button',
}: {
  children: React.ReactNode
  onClick?: () => void
  variant?: 'gold' | 'ghost' | 'secondary' | 'danger'
  size?: 'xs' | 'sm' | 'md'
  disabled?: boolean
  loading?: boolean
  className?: string
  type?: 'button' | 'submit'
}) {
  const base = 'inline-flex min-h-[44px] items-center justify-center gap-2 rounded-xl font-semibold transition-all duration-150 disabled:opacity-40 active:scale-[0.98] md:min-h-0'
  const sizes = { xs: 'px-2.5 py-1.5 text-[11px] min-h-[36px] md:min-h-0', sm: 'px-3.5 py-2 text-xs', md: 'px-5 py-2.5 text-sm' }
  const variants = {
    gold:      'bg-gold/10 border border-gold-dim/50 text-gold-lt hover:bg-gold/20',
    secondary: 'bg-white/[0.04] border border-border text-cream hover:bg-white/[0.07] hover:border-gold-dim/30',
    ghost:     'bg-transparent border border-border text-zinc-400 hover:bg-white/[0.04] hover:text-cream',
    danger:    'bg-red-400/10 border border-red-400/30 text-red-400 hover:bg-red-400/20',
  }
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={cn(base, sizes[size], variants[variant], className)}
    >
      {loading && <Spinner size="sm" />}
      {children}
    </button>
  )
}

// ── Input ────────────────────────────────────────────────────────────────
export function Input({ className, ...props }: React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      {...props}
      className={cn(
        'w-full rounded-xl bg-card border border-border px-4 py-3 text-sm text-cream placeholder-zinc-600 transition-colors focus:outline-none focus:border-gold-dim/60 focus:ring-1 focus:ring-gold-dim/30',
        className,
      )}
    />
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
export function StatRow({ label, value, valueClass }: { label: string; value: React.ReactNode; valueClass?: string }) {
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
export function Empty({
  icon,
  title,
  desc,
  action,
}: {
  icon: string
  title: string
  desc?: string
  action?: React.ReactNode
}) {
  return (
    <div className="flex flex-col items-center justify-center py-16 text-center">
      <span className="mb-4 text-5xl opacity-20">{icon}</span>
      <p className="mb-1 text-sm font-semibold text-zinc-400">{title}</p>
      {desc && <p className="text-[11px] text-zinc-600">{desc}</p>}
      {action && <div className="mt-4">{action}</div>}
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
