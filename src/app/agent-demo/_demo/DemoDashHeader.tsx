'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'

const TABS = [
  { href: '/agent-demo', label: 'Chat' },
  { href: '/agent-demo/monitor', label: 'Monitor' },
  { href: '/agent-demo/costs', label: 'Costs' },
]

export default function DemoDashHeader({ title, subtitle }: { title: string; subtitle: string }) {
  const pathname = usePathname()
  return (
    <header className="sticky top-0 z-20 border-b border-black/[0.06] bg-white/80 backdrop-blur-md">
      <div className="mx-auto flex max-w-5xl items-center justify-between gap-3 px-4 py-3 md:px-6">
        <div className="flex items-center gap-3">
          <Link
            href="/agent-demo"
            className="flex h-9 w-9 items-center justify-center rounded-xl bg-gradient-to-br from-[#E8B4A0] to-[#E07A5F] text-sm font-bold text-white shadow-sm"
            aria-label="চ্যাটে ফিরুন"
          >
            A
          </Link>
          <div className="min-w-0">
            <h1 className="truncate text-[15px] font-bold text-[#1a1a2e]">{title}</h1>
            <p className="truncate text-[11px] text-gray-500">{subtitle}</p>
          </div>
        </div>
        <nav className="flex items-center gap-1 rounded-xl border border-black/[0.06] bg-gray-50/80 p-1">
          {TABS.map((t) => {
            const active = pathname === t.href
            return (
              <Link
                key={t.href}
                href={t.href}
                className={`rounded-lg px-3 py-1.5 text-[12px] font-semibold transition-all ${
                  active ? 'bg-white text-[#E07A5F] shadow-sm' : 'text-gray-500 hover:text-gray-800'
                }`}
              >
                {t.label}
              </Link>
            )
          })}
        </nav>
      </div>
    </header>
  )
}
