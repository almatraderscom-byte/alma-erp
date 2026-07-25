'use client'

/**
 * The phone console's frame: a persistent section nav on the left, the sub-page on the right.
 *
 * The first cut of this was one long scrolling page of cards, and the owner was right that it
 * was the wrong shape. He runs the phone system from here the way he used to run it from the
 * old PBX's control console — a section with its own pages, each doing one job — so the
 * navigation is permanent, the current page is obvious, and what is not built yet is listed
 * with the step it arrives in rather than hidden.
 */

import type { ReactNode, SVGProps } from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { cn } from '@/lib/utils'

type Item = {
  href: string
  label: string
  icon: (p: SVGProps<SVGSVGElement>) => ReactNode
  /** Set on entries that later steps deliver; rendered visibly disabled, never clickable. */
  soon?: string
}

const BASE = '/agent/phone-console'

const GROUPS: Array<{ title: string; items: Item[] }> = [
  {
    title: 'পর্যবেক্ষণ',
    items: [
      { href: BASE, label: 'ড্যাশবোর্ড', icon: IconGrid },
      { href: `${BASE}/live`, label: 'লাইভ চ্যানেল', icon: IconPulse },
      { href: `${BASE}/calls`, label: 'কল লগ', icon: IconList },
      { href: `${BASE}/recordings`, label: 'রেকর্ডিং', icon: IconPlay },
      { href: `${BASE}/quality`, label: 'অডিও কোয়ালিটি', icon: IconWave },
    ],
  },
  {
    title: 'সিস্টেম',
    items: [
      { href: `${BASE}/line`, label: 'লাইন ও ট্রাঙ্ক', icon: IconLink },
      { href: `${BASE}/extensions`, label: 'এক্সটেনশন', icon: IconUsers, soon: 'ধাপ ৩' },
      { href: `${BASE}/routing`, label: 'রাউটিং', icon: IconRoute, soon: 'ধাপ ৪' },
      { href: `${BASE}/settings`, label: 'সেটিংস', icon: IconGear, soon: 'ধাপ ২' },
      { href: `${BASE}/cost`, label: 'খরচ', icon: IconCoin, soon: 'ধাপ ৬' },
    ],
  },
]

export function ConsoleShell({ children }: { children: ReactNode }) {
  const pathname = usePathname()
  const isActive = (href: string) => (href === BASE ? pathname === BASE : pathname.startsWith(href))

  return (
    <div className="flex h-full min-h-0">
      <aside className="hidden w-56 shrink-0 flex-col overflow-y-auto border-r border-border-subtle bg-card/60 md:flex">
        <div className="border-b border-border-subtle px-4 py-4" style={{ paddingTop: 'max(1rem, env(safe-area-inset-top))' }}>
          <Link href="/agent" className="text-[11px] text-muted transition-colors hover:text-cream">← এজেন্ট</Link>
          <p className="mt-1.5 text-sm font-bold text-cream">ফোন <span className="text-[#E07A5F]">কনসোল</span></p>
          <p className="text-[10px] text-muted">ALMA PBX · শুধু-দেখা</p>
        </div>
        <nav className="flex-1 space-y-4 px-2 py-3">
          {GROUPS.map((g) => (
            <div key={g.title}>
              <p className="px-2 pb-1 text-[10px] font-semibold uppercase tracking-wider text-muted">{g.title}</p>
              {g.items.map((i) => <NavRow key={i.href} item={i} active={isActive(i.href)} />)}
            </div>
          ))}
        </nav>
      </aside>

      <div className="min-w-0 flex-1 overflow-y-auto">
        {/* Mobile: the same navigation as one scrollable strip, so no page is unreachable
            without a sidebar. It sticks, because losing it on scroll is what made the old
            single page feel like a dead end. */}
        <div
          className="sticky top-0 z-20 border-b border-border-subtle bg-card/85 backdrop-blur-xl md:hidden"
          style={{ paddingTop: 'max(0.5rem, env(safe-area-inset-top))' }}
        >
          <div className="flex items-center gap-2 px-3 pb-1">
            <Link href="/agent" className="text-[12px] text-muted">←</Link>
            <p className="text-[13px] font-bold text-cream">ফোন <span className="text-[#E07A5F]">কনসোল</span></p>
          </div>
          <div className="flex gap-1.5 overflow-x-auto px-3 pb-2">
            {GROUPS.flatMap((g) => g.items).map((i) => (
              <NavChip key={i.href} item={i} active={isActive(i.href)} />
            ))}
          </div>
        </div>

        <div className="mx-auto max-w-5xl px-4 pb-28 pt-4 md:px-6 md:pb-10 md:pt-6">{children}</div>
      </div>
    </div>
  )
}

function NavRow({ item, active }: { item: Item; active: boolean }) {
  const Icon = item.icon
  const body = (
    <>
      <Icon className="h-4 w-4 shrink-0" />
      <span className="min-w-0 flex-1 truncate">{item.label}</span>
      {item.soon && (
        <span className="shrink-0 rounded-full border border-border-subtle px-1.5 text-[9px] text-muted">{item.soon}</span>
      )}
    </>
  )
  const cls = 'flex items-center gap-2.5 rounded-lg px-2 py-2 text-[12px] transition-colors'

  if (item.soon) {
    return <div className={cn(cls, 'cursor-not-allowed text-muted opacity-55')} title="পরের ধাপে আসছে">{body}</div>
  }
  return (
    <Link
      href={item.href}
      className={cn(cls, active ? 'bg-[#E07A5F]/[0.12] font-semibold text-cream' : 'text-muted hover:bg-card hover:text-cream')}
    >
      {body}
    </Link>
  )
}

function NavChip({ item, active }: { item: Item; active: boolean }) {
  const cls = 'shrink-0 rounded-full border px-3 py-1 text-[11px] whitespace-nowrap'
  if (item.soon) {
    return <span className={cn(cls, 'border-border-subtle text-muted opacity-55')}>{item.label} · {item.soon}</span>
  }
  return (
    <Link
      href={item.href}
      className={cn(cls, active
        ? 'border-[#E07A5F]/50 bg-[#E07A5F]/[0.14] font-semibold text-cream'
        : 'border-border-subtle bg-card/60 text-muted')}
    >
      {item.label}
    </Link>
  )
}

// ── icons ────────────────────────────────────────────────────────────────────

const stroke = { fill: 'none', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const }

function IconGrid(p: SVGProps<SVGSVGElement>) {
  return <svg viewBox="0 0 24 24" {...stroke} {...p}><rect x="3" y="3" width="7" height="7" rx="1.5" /><rect x="14" y="3" width="7" height="7" rx="1.5" /><rect x="3" y="14" width="7" height="7" rx="1.5" /><rect x="14" y="14" width="7" height="7" rx="1.5" /></svg>
}
function IconPulse(p: SVGProps<SVGSVGElement>) {
  return <svg viewBox="0 0 24 24" {...stroke} {...p}><path d="M3 12h4l3-8 4 16 3-8h4" /></svg>
}
function IconList(p: SVGProps<SVGSVGElement>) {
  return <svg viewBox="0 0 24 24" {...stroke} {...p}><path d="M8 6h13M8 12h13M8 18h13M3.5 6h.01M3.5 12h.01M3.5 18h.01" /></svg>
}
function IconPlay(p: SVGProps<SVGSVGElement>) {
  return <svg viewBox="0 0 24 24" {...stroke} {...p}><circle cx="12" cy="12" r="9" /><path d="M10 8.5l6 3.5-6 3.5z" /></svg>
}
function IconWave(p: SVGProps<SVGSVGElement>) {
  return <svg viewBox="0 0 24 24" {...stroke} {...p}><path d="M4 12v2M8 8v8M12 5v14M16 9v6M20 11v3" /></svg>
}
function IconLink(p: SVGProps<SVGSVGElement>) {
  return <svg viewBox="0 0 24 24" {...stroke} {...p}><path d="M10 13a5 5 0 007 0l2-2a5 5 0 00-7-7l-1 1" /><path d="M14 11a5 5 0 00-7 0l-2 2a5 5 0 007 7l1-1" /></svg>
}
function IconUsers(p: SVGProps<SVGSVGElement>) {
  return <svg viewBox="0 0 24 24" {...stroke} {...p}><circle cx="9" cy="8" r="3.2" /><path d="M3.5 19a5.5 5.5 0 0111 0" /><path d="M16 6.2a3.2 3.2 0 010 5.6M17.5 19a5.5 5.5 0 00-2-4.2" /></svg>
}
function IconRoute(p: SVGProps<SVGSVGElement>) {
  return <svg viewBox="0 0 24 24" {...stroke} {...p}><circle cx="6" cy="6" r="2.2" /><circle cx="18" cy="18" r="2.2" /><path d="M6 8.2V14a4 4 0 004 4h5.8" /></svg>
}
function IconGear(p: SVGProps<SVGSVGElement>) {
  return <svg viewBox="0 0 24 24" {...stroke} {...p}><circle cx="12" cy="12" r="3" /><path d="M12 3v2.2M12 18.8V21M21 12h-2.2M5.2 12H3M18.4 5.6l-1.6 1.6M7.2 16.8l-1.6 1.6M18.4 18.4l-1.6-1.6M7.2 7.2L5.6 5.6" /></svg>
}
function IconCoin(p: SVGProps<SVGSVGElement>) {
  return <svg viewBox="0 0 24 24" {...stroke} {...p}><circle cx="12" cy="12" r="9" /><path d="M12 7v10M9.5 9.5h5M9.5 14.5h5" /></svg>
}
