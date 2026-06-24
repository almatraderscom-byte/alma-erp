'use client'

import { useEffect } from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'

export type OfficeNavItem = { href: string; icon: string; label: string }

/**
 * Slide-in ERP navigation drawer. The office surface is a full-viewport overlay
 * that paints over the ERP sidebar, so this drawer is how the owner reaches the
 * rest of the ERP without leaving the office. Toggled from the topbar hamburger.
 */
export default function NavDrawer({
  items,
  open,
  onClose,
}: {
  items: OfficeNavItem[]
  open: boolean
  onClose: () => void
}) {
  const path = usePathname()

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open) return null

  const isCurrent = (href: string) =>
    href === '/' || href === '/digital' ? path === href : path.startsWith(href)

  return (
    <>
      <div className="ohub-drawer-ov" onClick={onClose} aria-hidden />
      <aside className="ohub-drawer" role="dialog" aria-label="ERP নেভিগেশন">
        <div className="dh">
          <span className="logo">🏢</span>
          <span className="ttl">
            <b>ALMA ERP</b>
            <span>সব সেকশনে যান</span>
          </span>
          <button className="x" onClick={onClose} aria-label="বন্ধ করুন">
            ×
          </button>
        </div>
        <nav className="dnav">
          {items.map((it) => (
            <Link
              key={it.href}
              href={it.href}
              prefetch={false}
              className={`dl${isCurrent(it.href) ? ' cur' : ''}`}
              onClick={onClose}
            >
              <span className="di">{it.icon}</span>
              <span className="dt">{it.label}</span>
            </Link>
          ))}
        </nav>
        <div className="dft">ALMA Office Hub · ERP নেভিগেশন</div>
      </aside>
    </>
  )
}
