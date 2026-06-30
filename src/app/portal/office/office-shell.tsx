'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import type { OwnerHubData, StaffOfficeData } from '@/agent/lib/office-hub'
import type { Motivation } from '@/agent/lib/office-motivation'
import OwnerHub from './owner-hub'
import StaffApp from './staff-app'
import NotifBell from './notif-bell'
import GroupChat from './group-chat'
import NavDrawer, { type OfficeNavItem } from './nav-drawer'
import HistoryPanel from './history-panel'

export default function OfficeShell({
  owner,
  staff,
  self,
  headerDate,
  motivation,
  navItems,
}: {
  owner: OwnerHubData | null
  staff: StaffOfficeData | null
  self: 'owner' | 'staff'
  headerDate: string
  motivation: Motivation
  navItems: OfficeNavItem[]
}) {
  const isOwner = self === 'owner'
  const router = useRouter()
  const [navOpen, setNavOpen] = useState(false)
  const [histOpen, setHistOpen] = useState(false)

  // Live sync across screens. The office board is server-rendered and otherwise
  // only re-fetches when the viewer takes an action — so an approval made by the
  // owner (or the agent's auto-verify) didn't reach a staff's open page, or a
  // second tab, until a manual reload. Soft-refresh the server data on a gentle
  // interval (only while the tab is visible) and immediately when the tab regains
  // focus, so done/approved/redo state propagates everywhere on its own.
  // router.refresh() preserves client state (open drawers, chat, scroll), so this
  // never disrupts what the viewer is doing.
  useEffect(() => {
    const REFRESH_MS = 18_000
    const refreshIfVisible = () => {
      if (document.visibilityState === 'visible') router.refresh()
    }
    const id = setInterval(refreshIfVisible, REFRESH_MS)
    document.addEventListener('visibilitychange', refreshIfVisible)
    window.addEventListener('focus', refreshIfVisible)
    return () => {
      clearInterval(id)
      document.removeEventListener('visibilitychange', refreshIfVisible)
      window.removeEventListener('focus', refreshIfVisible)
    }
  }, [router])

  // The app's GLOBAL MobilePullToRefresh listens on the ERP <main> scroll
  // element. The office is a fixed overlay whose OWN scroller is `.wrap`, so
  // <main>.scrollTop stays 0 — meaning every upward scroll inside the office
  // (finger moving down) looked like "at the top, pulling to refresh" and the
  // page reloaded mid-scroll. CSS overscroll-behavior can't stop a JS touch
  // handler, so we stop the office's touch events from bubbling up to it. This
  // does NOT affect native scrolling inside `.wrap`/the chat (that's handled by
  // the browser regardless of JS event propagation) or the office's own taps.
  useEffect(() => {
    const ohub = document.querySelector('.ohub')
    if (!ohub) return
    const stop: EventListener = (e) => e.stopPropagation()
    const evs = ['touchstart', 'touchmove', 'touchend', 'touchcancel']
    evs.forEach((ev) => ohub.addEventListener(ev, stop))
    return () => evs.forEach((ev) => ohub.removeEventListener(ev, stop))
  }, [])

  // Scroll-triggered reveal: each section eases up as it scrolls into view (the
  // "premium" motion). SAFETY: only BELOW-fold elements are hidden, a 2.5s
  // fallback reveals everything no matter what, and any error reveals all — so
  // content can never get stuck invisible.
  useEffect(() => {
    if (typeof IntersectionObserver === 'undefined') return
    const SEL =
      '.ohub .perspective .card, .ohub .kpis, .ohub .hero-row, .ohub .award, .ohub .motiv, .ohub .track, .ohub .props, .ohub .section-h, .ohub .oh-tabs, .ohub .actcol, .ohub .note'
    const revealAll = () => document.querySelectorAll('.ohub .oh-reveal').forEach((el) => el.classList.add('in'))
    let io: IntersectionObserver | null = null
    let setupT: ReturnType<typeof setTimeout> | undefined
    let fallbackT: ReturnType<typeof setTimeout> | undefined
    try {
      io = new IntersectionObserver(
        (entries) => {
          for (const e of entries) {
            if (e.isIntersecting) {
              e.target.classList.add('in')
              io?.unobserve(e.target)
            }
          }
        },
        { threshold: 0.05, rootMargin: '0px 0px -5% 0px' },
      )
      setupT = setTimeout(() => {
        const vh = window.innerHeight || 800
        document.querySelectorAll<HTMLElement>(SEL).forEach((el) => {
          if (el.classList.contains('oh-reveal')) return
          el.classList.add('oh-reveal')
          if (el.getBoundingClientRect().top < vh * 0.9) el.classList.add('in')
          else io?.observe(el)
        })
        fallbackT = setTimeout(revealAll, 2500)
      }, 60)
    } catch {
      revealAll()
    }
    return () => {
      if (setupT) clearTimeout(setupT)
      if (fallbackT) clearTimeout(fallbackT)
      io?.disconnect()
    }
  }, [])

  return (
    <>
      <div className="topbar">
        <button className="tbtn" onClick={() => setNavOpen(true)} aria-label="ERP নেভিগেশন খুলুন">
          <span className="tic">☰</span>
          <span className="tlbl">মেনু</span>
        </button>

        <Link href="/" className="brand" aria-label="ERP-তে ফিরুন">
          <span className="logo">🏢</span>
          <span>
            ALMA Office Hub <small>ALMA Lifestyle</small>
          </span>
        </Link>

        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 10 }}>
          {isOwner && (
            <button className="tbtn" onClick={() => setHistOpen(true)} aria-label="ইতিহাস">
              <span className="tic">📅</span>
              <span className="tlbl">ইতিহাস</span>
            </button>
          )}
          <NotifBell />
        </div>
      </div>

      <div className="wrap">
        {isOwner && owner && (
          <div className="perspective show">
            <OwnerHub data={owner} headerDate={headerDate} motivation={motivation} />
          </div>
        )}

        {!isOwner && staff && (
          <div className="perspective show">
            <StaffApp data={staff} headerDate={headerDate} motivation={motivation} />
          </div>
        )}

        {!isOwner && !staff && (
          <div className="perspective show">
            <div className="card" style={{ padding: 24, textAlign: 'center', marginTop: 24 }}>
              <p style={{ fontSize: 16, fontWeight: 600 }}>আপনার অফিস এখনো সেট করা হয়নি</p>
              <p style={{ marginTop: 8, fontSize: 14, color: 'var(--muted)' }}>
                আপনার অ্যাকাউন্ট এখনো অফিসের সাথে যুক্ত হয়নি। যুক্ত করা হলে আজকের কাজ এখানে দেখাবে।
              </p>
            </div>
          </div>
        )}
      </div>

      <NavDrawer items={navItems} open={navOpen} onClose={() => setNavOpen(false)} />
      {histOpen && <HistoryPanel onClose={() => setHistOpen(false)} />}

      <GroupChat self={self} />
    </>
  )
}
