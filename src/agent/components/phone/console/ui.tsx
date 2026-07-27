'use client'

/**
 * Shared furniture for the phone console.
 *
 * One vocabulary for every sub-page — page head, KPI tile, panel, period tabs, table cells —
 * so the section reads as one product rather than as six screens that happen to share a URL
 * prefix. Colours come from the repo's theme-aware `.tone-*` classes and the coral accent,
 * never from hand-picked Tailwind steps: this app runs a light AND a dark theme off
 * `data-theme`, which Tailwind's `dark:` variant does not follow.
 */

import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'
import { PERIODS, type Period } from '@/agent/lib/phone-console-types'

export const CORAL = '#E07A5F'

// ── formatting ───────────────────────────────────────────────────────────────

export function secs(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '—'
  const s = Math.max(0, Math.round(n))
  if (s < 60) return `${s}সে`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}মি ${s % 60}সে`
  return `${Math.floor(m / 60)}ঘ ${m % 60}মি`
}

export function clockBn(iso: string | null): string {
  if (!iso) return '—'
  return new Date(iso).toLocaleString('bn-BD', {
    timeZone: 'Asia/Dhaka', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit',
  })
}

export function dayBn(ymd: string): string {
  return new Date(`${ymd}T00:00:00Z`).toLocaleDateString('bn-BD', {
    timeZone: 'UTC', day: 'numeric', month: 'short',
  })
}

// ── page furniture ───────────────────────────────────────────────────────────

export function PageHead({
  title, subtitle, actions,
}: { title: string; subtitle: string; actions?: ReactNode }) {
  return (
    <header className="mb-4 flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0">
        <h1 className="text-xl font-bold tracking-tight text-cream md:text-2xl">{title}</h1>
        <p className="mt-1 text-[12px] text-muted">{subtitle}</p>
      </div>
      {actions && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
    </header>
  )
}

export function Panel({
  title, badge, actions, children, className,
}: {
  title?: string
  badge?: ReactNode
  actions?: ReactNode
  children: ReactNode
  className?: string
}) {
  return (
    <section className={cn('rounded-[18px] border border-border-subtle bg-card/80 shadow-card', className)}>
      {(title || actions) && (
        <header className="flex flex-wrap items-center justify-between gap-2 border-b border-border-subtle px-4 py-3">
          <div className="flex items-center gap-2">
            {title && <h2 className="text-sm font-bold text-cream">{title}</h2>}
            {badge != null && (
              <span className="rounded-full border border-border-subtle bg-card/60 px-2 py-0.5 text-[11px] text-muted">
                {badge}
              </span>
            )}
          </div>
          {actions && <div className="flex items-center gap-2">{actions}</div>}
        </header>
      )}
      <div className="p-4">{children}</div>
    </section>
  )
}

type Tone = 'coral' | 'green' | 'red' | 'slate' | 'amber'

const TONE_RING: Record<Tone, string> = {
  coral: 'border-[#E07A5F]/35 bg-[#E07A5F]/[0.07]',
  green: 'tone-green',
  red: 'tone-red',
  amber: 'tone-amber',
  slate: 'border-border-subtle bg-card/60',
}

/** The big number a PBX dashboard is really made of. */
export function Kpi({
  label, value, sub, tone = 'slate',
}: { label: string; value: ReactNode; sub?: string; tone?: Tone }) {
  return (
    <div className={cn('rounded-2xl border px-4 py-3.5', TONE_RING[tone])}>
      <p className="text-[11px] font-medium uppercase tracking-wide opacity-80">{label}</p>
      <p className={cn('mt-1 text-2xl font-bold tabular-nums', tone === 'slate' && 'text-cream')}>{value}</p>
      {sub && <p className="mt-0.5 text-[11px] opacity-75">{sub}</p>}
    </div>
  )
}

export function KpiRow({ children }: { children: ReactNode }) {
  return <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">{children}</div>
}

// ── controls ─────────────────────────────────────────────────────────────────

export function Segmented<T extends string>({
  items, value, onChange, size = 'md',
}: {
  items: ReadonlyArray<{ value: T; label: string }>
  value: T
  onChange: (v: T) => void
  size?: 'sm' | 'md'
}) {
  return (
    <div className="inline-flex flex-wrap gap-1 rounded-full border border-border-subtle bg-card/60 p-1">
      {items.map((i) => (
        <button
          key={i.value}
          type="button"
          onClick={() => onChange(i.value)}
          className={cn(
            'rounded-full transition-colors',
            size === 'sm' ? 'px-2.5 py-1 text-[11px]' : 'px-3 py-1.5 text-[12px]',
            value === i.value
              ? 'bg-[#E07A5F]/[0.16] font-semibold text-cream shadow-sm'
              : 'text-muted hover:text-cream',
          )}
        >
          {i.label}
        </button>
      ))}
    </div>
  )
}

export function PeriodTabs({ value, onChange }: { value: Period; onChange: (v: Period) => void }) {
  return <Segmented items={PERIODS.map((p) => ({ value: p.value, label: p.label }))} value={value} onChange={onChange} />
}

export function ConsoleButton({
  children, onClick, href, download,
}: { children: ReactNode; onClick?: () => void; href?: string; download?: boolean }) {
  const cls = 'inline-flex items-center gap-1.5 rounded-full border border-border-subtle bg-card/60 px-3 py-1.5 text-[12px] text-muted transition-colors hover:border-[#E07A5F]/40 hover:text-cream'
  if (href) {
    return <a href={href} download={download} className={cls}>{children}</a>
  }
  return <button type="button" onClick={onClick} className={cls}>{children}</button>
}

export function TextField({
  value, onChange, placeholder, label,
}: { value: string; onChange: (v: string) => void; placeholder?: string; label?: string }) {
  return (
    <label className="block">
      {label && <span className="mb-1 block text-[11px] text-muted">{label}</span>}
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        inputMode="tel"
        placeholder={placeholder}
        className="w-full rounded-xl border border-border-subtle bg-card/60 px-3 py-2 text-sm text-cream placeholder:text-muted focus:border-[#E07A5F]/40 focus:outline-none"
      />
    </label>
  )
}

// ── table ────────────────────────────────────────────────────────────────────

/** Wide tables scroll inside their own box; the page body never scrolls sideways. */
export function TableWrap({ children }: { children: ReactNode }) {
  return <div className="-mx-4 overflow-x-auto px-4"><table className="w-full min-w-[640px] text-left text-[12px]">{children}</table></div>
}

export function Th({ children, className }: { children?: ReactNode; className?: string }) {
  return (
    <th className={cn('whitespace-nowrap border-b border-border-subtle px-2 py-2 text-[11px] font-semibold uppercase tracking-wide text-muted', className)}>
      {children}
    </th>
  )
}

export function Td({ children, className }: { children: ReactNode; className?: string }) {
  return <td className={cn('border-b border-border-subtle/60 px-2 py-2.5 align-top text-cream', className)}>{children}</td>
}

export function EmptyState({ children }: { children: ReactNode }) {
  return <p className="py-10 text-center text-[12px] text-muted">{children}</p>
}

export function ErrorNote({ children }: { children: ReactNode }) {
  return <p className="tone-red rounded-xl border px-3 py-2 text-[12px]">{children}</p>
}

export function Pill({ tone, children, title }: { tone: Tone; children: ReactNode; title?: string }) {
  return (
    <span title={title} className={cn('inline-block whitespace-nowrap rounded-full border px-2 py-0.5 text-[11px] font-medium', TONE_RING[tone])}>
      {children}
    </span>
  )
}

export function DirectionMark({ direction }: { direction: 'inbound' | 'outbound' | 'unknown' }) {
  if (direction === 'unknown') return <span className="text-muted" title="জানা নেই">•</span>
  const inbound = direction === 'inbound'
  return (
    <span
      className={cn('inline-block text-base leading-none', inbound ? 'txt-pos' : 'text-[#E07A5F]')}
      title={inbound ? 'ইনকামিং' : 'আউটগোয়িং'}
    >
      {inbound ? '↙' : '↗'}
    </span>
  )
}

/** A bar per day. Deliberately plain SVG — a charting library for six bars is not a trade. */
export function MiniBars({
  data, label,
}: { data: Array<{ date: string; value: number; sub?: number }>; label: string }) {
  const max = Math.max(1, ...data.map((d) => d.value))
  return (
    <div>
      <p className="mb-2 text-[11px] text-muted">{label}</p>
      {/* h-full on the column matters: a percentage height resolves against a parent with a
          DEFINITE height, and without it every bar collapsed and the chart rendered empty. */}
      <div className="flex h-28 items-end gap-1">
        {data.map((d) => (
          <div key={d.date} className="group relative flex h-full min-w-0 flex-1 flex-col items-center justify-end">
            {d.sub != null && d.sub > 0 && (
              <div
                className="w-full rounded-t-sm bg-[#E07A5F]/25"
                style={{ height: `${(d.sub / max) * 100}%` }}
              />
            )}
            <div
              className="w-full rounded-t-sm bg-[#E07A5F]"
              style={{ height: `${Math.max(d.value ? 4 : 0, ((d.value - (d.sub ?? 0)) / max) * 100)}%` }}
            />
            <span className="pointer-events-none absolute -top-5 hidden whitespace-nowrap rounded border border-border-subtle bg-card px-1.5 py-0.5 text-[10px] text-cream group-hover:block">
              {dayBn(d.date)} · {d.value}
            </span>
          </div>
        ))}
      </div>
      <div className="mt-1 flex justify-between text-[10px] text-muted">
        <span>{data.length ? dayBn(data[0].date) : ''}</span>
        <span>{data.length ? dayBn(data[data.length - 1].date) : ''}</span>
      </div>
    </div>
  )
}
