'use client'

import { useState } from 'react'
import Link from 'next/link'
import type { OwnerHubData, StaffOfficeData } from '@/agent/lib/office-hub'
import OwnerHub from './owner-hub'
import StaffApp from './staff-app'
import StaffPreview from './staff-preview'
import NotifBell from './notif-bell'
import GroupChat from './group-chat'

type View = 'owner' | 'staff'

export default function OfficeShell({
  owner,
  staff,
  self,
  headerDate,
}: {
  owner: OwnerHubData | null
  staff: StaffOfficeData | null
  self: 'owner' | 'staff'
  headerDate: string
}) {
  const isOwner = self === 'owner'
  const [view, setView] = useState<View>(isOwner ? 'owner' : 'staff')

  return (
    <>
      <div className="topbar">
        <Link href="/" className="brand" aria-label="ERP-তে ফিরুন">
          <span className="logo">🏢</span>
          <span>
            ALMA Office Hub <small>ALMA Lifestyle</small>
          </span>
        </Link>

        {isOwner && (
          <div className="seg">
            <button className={view === 'owner' ? 'active' : ''} onClick={() => setView('owner')}>
              👑 মালিক ভিউ
            </button>
            <button className={view === 'staff' ? 'active' : ''} onClick={() => setView('staff')}>
              👷 স্টাফ ভিউ
            </button>
          </div>
        )}

        <div style={isOwner ? undefined : { marginLeft: 'auto' }}>
          <NotifBell />
        </div>
      </div>

      <div className="wrap">
        {/* Owner perspective */}
        {isOwner && owner && (
          <div className={`perspective ${view === 'owner' ? 'show' : ''}`}>
            <OwnerHub data={owner} headerDate={headerDate} />
          </div>
        )}

        {/* Owner's preview of the staff experience */}
        {isOwner && (
          <div className={`perspective ${view === 'staff' ? 'show' : ''}`}>
            <StaffPreview headerDate={headerDate} />
          </div>
        )}

        {/* Real staff app */}
        {!isOwner && staff && (
          <div className="perspective show">
            <StaffApp data={staff} headerDate={headerDate} />
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

      <GroupChat self={self} />
    </>
  )
}
