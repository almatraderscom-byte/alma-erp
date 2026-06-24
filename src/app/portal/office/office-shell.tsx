'use client'

import { useState } from 'react'
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
  const [navOpen, setNavOpen] = useState(false)
  const [histOpen, setHistOpen] = useState(false)

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
