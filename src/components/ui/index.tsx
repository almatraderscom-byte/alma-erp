'use client'
import { motion, useReducedMotion, useSpring } from 'framer-motion'
import { useEffect, useState } from 'react'
import { BDT_SYMBOL, fmtNum } from '@/lib/currency'
import { cn } from '@/lib/utils'
import { tapHaptic } from '@/lib/ui-haptics'
import { BdtText, Money } from '@/components/ui/Currency'
import { ResponsiveKpiValue, type KpiValueKind } from '@/components/ui/ResponsiveKpiValue'
import type { OrderStatus, CustomerSegment, RiskLevel } from '@/types'

export { Money, BdtText } from '@/components/ui/Currency'
export { SearchableSelect, type SearchableSelectOption } from '@/components/ui/SearchableSelect'
import { STATUS_COLORS, SEG_COLORS, RISK_COLORS, PAYMENT_COLORS, orderStatusLabel } from '@/lib/utils'
import { PageActionBar } from '@/components/layout/PageActionBar'
import { PageBackButton } from '@/components/layout/PageBackButton'
import { AgentLauncherButton } from '@/components/layout/AgentAccess'
import { AlertsActionButton } from '@/components/notifications/AlertsActionButton'
import { usePathname } from 'next/navigation'
import { PLATFORM_Z } from '@/lib/platform-z-index'

// ── Skeleton ─────────────────────────────────────────────────────────────
export function Skeleton({ className }: { className?: string }) {
  return <div className={cn('skeleton rounded-lg', className)} />
}

/**
 * Springs a number from 0 → target the first time it mounts, so KPI values
 * "count up" for a premium, alive dashboard feel. Returns the target instantly
 * under reduced motion or when disabled — never animates fractional taka mid-flight
 * because callers round/format the integer it returns. Internal to KpiCard.
 */
export function useCountUp(target: number, enabled: boolean): number {
  const reduce = useReducedMotion()
  const spring = useSpring(0, { stiffness: 80, damping: 22, mass: 0.9 })
  const [n, setN] = useState(enabled && !reduce ? 0 : target)
  useEffect(() => {
    if (!enabled || reduce) {
      setN(target)
      return
    }
    spring.set(target)
    const unsub = spring.on('change', v => setN(Math.round(v)))
    return () => unsub()
  }, [target, enabled, reduce, spring])
  return n
}

// ── Card ─────────────────────────────────────────────────────────────────
export const Card = React.forwardRef<HTMLDivElement, {
  children: React.ReactNode
  className?: string
  gold?: boolean
  /** Subtle hover lift — presentation only. */
  interactive?: boolean
}>(function Card({ children, className, gold, interactive }, ref) {
  return (
    <div
      ref={ref}
      className={cn(
        'min-w-0 rounded-2xl border bg-card/80 shadow-card',
        gold ? 'border-gold/30' : 'border-border-subtle',
        interactive && 'card-interactive',
        className,
      )}
    >
      {children}
    </div>
  )
})

/** Auto-fit KPI row: ~5 on desktop, 2–3 on tablet, 1–2 on mobile. */
export const KPI_AUTO_GRID =
  'grid gap-3 [grid-template-columns:repeat(auto-fit,minmax(min(100%,9.75rem),1fr))]'

// ── KPI Card ──────────────────────────────────────────────────────────────
export function KpiCard({ label, value, sub, delta, color, loading, valueKind, animate }: {
  label: string
  value: string | number
  sub?: string
  delta?: number
  color?: string
  loading?: boolean
  /** Responsive compact/full formatting for numeric KPI values. */
  valueKind?: KpiValueKind | 'plain'
  /** Count-up the numeric value on mount (premium dashboard feel). */
  animate?: boolean
}) {
  const valueColor = color ?? 'text-cream'
  // Animated integer for numeric values; no-op (returns value) for string values.
  const animatedValue = useCountUp(typeof value === 'number' ? value : 0, !!animate && typeof value === 'number')
  const numeric = typeof value === 'number' ? (animate ? animatedValue : value) : value

  return (
    <Card className="kpi-card min-w-0 border-l-[3px] border-l-gold/40 p-3.5 sm:p-4 md:p-5">
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
                  {fmtNum(numeric as number)}
                </p>
              ) : (
                <ResponsiveKpiValue
                  amount={numeric as number}
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
          {sub && <p className="mt-0.5 text-[11px] leading-snug text-muted">{sub}</p>}
          {delta !== undefined && (
            <p className={cn('text-[11px] font-semibold', delta > 0 ? 'txt-pos' : 'txt-neg')}>
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
  const cls = PAYMENT_COLORS[method] ?? 'text-muted bg-zinc-400/10 border-zinc-400/20'
  return <span className={cn('inline-flex items-center px-2 py-0.5 rounded-md text-[10px] font-bold border', cls)}>{method}</span>
}

// ── Progress Bar ──────────────────────────────────────────────────────────
export function Progress({ value, max = 100, color = 'bg-gold', className }: { value: number; max?: number; color?: string; className?: string }) {
  const pct = Math.min(100, Math.round(value / max * 100))
  return (
    <div className={cn('h-1 bg-bg-2 rounded-full overflow-hidden', className)}>
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
      className="page-header sticky top-0 border-b border-border-subtle bg-card/80 px-4 pb-4 backdrop-blur md:px-8"
      // Pad the sticky header below the status bar / Dynamic Island so the title and
      // action buttons never render under the notch on iPhone (and notched Android).
      style={{ zIndex: PLATFORM_Z.stickyBanner, paddingTop: 'max(1rem, env(safe-area-inset-top))' }}
    >
      <div className="grid grid-cols-1 gap-3 xl:grid-cols-[minmax(0,1fr)_auto] xl:items-center xl:gap-4">
        <div className="flex min-w-0 items-center gap-2.5">
          <PageBackButton />
          <div className="min-w-0">
            <h1 className="truncate text-base font-bold tracking-tight text-cream md:text-lg">{title}</h1>
            {subtitle != null && subtitle !== '' && (
              <p className="mt-0.5 truncate text-[11px] text-muted">{subtitle}</p>
            )}
          </div>
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
  const base = 'inline-flex min-h-[44px] items-center justify-center gap-2 rounded-xl font-semibold transition-all duration-150 disabled:opacity-50 disabled:saturate-[0.85] disabled:cursor-not-allowed disabled:active:scale-100 active:scale-[0.98] md:min-h-0'
  const sizes = { xs: 'px-2.5 py-1.5 text-[11px] min-h-[36px] md:min-h-0', sm: 'px-3.5 py-2 text-xs', md: 'px-5 py-2.5 text-sm' }
  const variants = {
    gold:      'bg-gold/10 border border-gold/30 text-gold-dim hover:bg-gold/20 hover:shadow-gold-sm',
    secondary: 'bg-bg-2 border border-border-subtle text-cream hover:bg-bg-3 hover:border-border-strong hover:shadow-card',
    ghost:     'bg-transparent border border-border-subtle text-muted-hi hover:bg-bg-2 hover:text-cream hover:shadow-card',
    danger:    'bg-danger/10 border border-danger/30 text-danger hover:bg-danger/20 hover:shadow-card',
  }
  return (
    <button
      type={type}
      onClick={onClick ? () => { tapHaptic(); onClick() } : undefined}
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
export function Input({ className, error, ...props }: React.InputHTMLAttributes<HTMLInputElement> & { error?: boolean }) {
  return (
    <input
      {...props}
      aria-invalid={error || undefined}
      className={cn(
        'w-full rounded-xl bg-card border px-4 py-3 text-sm text-cream placeholder-muted transition-all focus:outline-none disabled:opacity-60 disabled:cursor-not-allowed',
        error
          ? 'border-danger/60 focus:border-danger focus:ring-2 focus:ring-danger/30'
          : 'border-border-strong focus:border-gold/60 focus:ring-2 focus:ring-gold/25 focus:shadow-gold-sm',
        className,
      )}
    />
  )
}

// ── Search Input ──────────────────────────────────────────────────────────
export function SearchInput({ value, onChange, placeholder }: { value: string; onChange: (v: string) => void; placeholder?: string }) {
  return (
    <div className="relative">
      <span className="absolute left-3 top-1/2 -translate-y-1/2 text-muted text-sm">⌕</span>
      <input
        value={value} onChange={e => onChange(e.target.value)} placeholder={placeholder ?? 'Search…'}
        className="w-full bg-card border border-border-strong rounded-xl pl-9 pr-4 py-2.5 text-sm text-cream placeholder-muted focus:outline-none focus:border-gold/50 transition-colors"
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
      className={cn('bg-card border border-border-strong rounded-xl px-3 py-2.5 text-sm text-cream focus:outline-none focus:border-gold/50 transition-colors cursor-pointer', className)}>
      {options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
    </select>
  )
}

// ── Stat Row ─────────────────────────────────────────────────────────────
export function StatRow({ label, value, valueClass }: { label: string; value: React.ReactNode; valueClass?: string }) {
  return (
    <div className="flex items-center justify-between py-2 border-b border-border-subtle last:border-0">
      <span className="text-[11px] text-muted">{label}</span>
      <span className={cn('text-[12px] font-bold', valueClass ?? 'text-cream')}>{value}</span>
    </div>
  )
}

// ── Avatar ────────────────────────────────────────────────────────────────
export function Avatar({ name, size = 'sm', vip }: { name: string; size?: 'sm' | 'md' | 'lg'; vip?: boolean }) {
  const initials = name.split(' ').map(n => n[0]).join('').slice(0, 2).toUpperCase()
  const sizes = { sm: 'w-8 h-8 text-[11px]', md: 'w-10 h-10 text-sm', lg: 'w-12 h-12 text-base' }
  return (
    <div className={cn('rounded-full flex items-center justify-center font-black shrink-0', sizes[size], vip ? 'bg-gold/10 border border-gold/30 text-gold-dim' : 'bg-bg-2 border border-border-subtle text-muted')}>
      {initials}
    </div>
  )
}

// ── Loading Spinner ───────────────────────────────────────────────────────
export function Spinner({ size = 'sm' }: { size?: 'sm' | 'md' | 'lg' }) {
  const s = { sm: 'w-4 h-4 border-2', md: 'w-6 h-6 border-2', lg: 'w-8 h-8 border-2' }
  return <div className={cn('rounded-full border-gold/30 border-t-gold animate-spin', s[size])} />
}

// ── Empty State ───────────────────────────────────────────────────────────
/** Crafted "empty inbox" line illustration — replaces the abstract glyphs that
 *  read like missing icons. currentColor lets the accent chip tint it. */
function EmptyIllustration() {
  return (
    <svg viewBox="0 0 48 48" fill="none" aria-hidden className="h-8 w-8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9 19 L40 19 L40 36 Q40 39 37 39 L12 39 Q9 39 9 36 Z" stroke="currentColor" strokeWidth="2" opacity="0.75" />
      <path d="M9 19 L14 10 Q15 8.5 17 8.5 L32 8.5 Q34 8.5 35 10 L40 19" stroke="currentColor" strokeWidth="2" opacity="0.4" />
      <path d="M9 19 L18 19 L21 24 L27 24 L30 19 L40 19" stroke="currentColor" strokeWidth="2" opacity="0.75" />
    </svg>
  )
}

export function Empty({
  title,
  desc,
  action,
}: {
  /** Optional legacy glyph — ignored in favour of the crafted illustration; kept for back-compat. */
  icon?: string
  title: string
  desc?: string
  action?: React.ReactNode
}) {
  return (
    <div className="flex flex-col items-center justify-center py-16 text-center">
      {/* Crafted illustration in a soft accent-tinted chip — premium, consistent. */}
      <span
        className="mb-4 flex h-16 w-16 items-center justify-center rounded-2xl border text-muted-hi/80 shadow-card"
        style={{ background: 'rgb(var(--c-accent) / 0.06)', borderColor: 'rgb(var(--c-accent) / 0.14)' }}
      >
        <EmptyIllustration />
      </span>
      <p className="mb-1 text-sm font-semibold text-muted-hi">{title}</p>
      {desc && <p className="text-[11px] text-muted max-w-[34ch]">{desc}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  )
}

// ── CLV Bar ───────────────────────────────────────────────────────────────
export function ClvBar({ score }: { score: number }) {
  const color = score > 60 ? 'bg-gold' : score > 30 ? 'bg-amber-500' : 'bg-border-strong'
  return (
    <div className="flex items-center gap-2">
      <div className="flex-1 h-1 bg-bg-2 rounded-full overflow-hidden">
        <motion.div className={cn('h-full rounded-full', color)} initial={{ width: 0 }} animate={{ width: `${score}%` }} transition={{ duration: 0.5 }} />
      </div>
      <span className={cn('text-[11px] font-bold w-6 text-right tabular-nums', score > 60 ? 'text-gold' : 'text-muted')}>{score}</span>
    </div>
  )
}
