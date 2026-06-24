'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import type { NotificationFeed, OfficeNotice } from '@/agent/lib/office-notifications'

const POLL_MS = 30_000
const BN = '০১২৩৪৫৬৭৮৯'
const bn = (n: number | string) => String(n).replace(/\d/g, (d) => BN[Number(d)])

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime()
  const m = Math.floor(diff / 60_000)
  if (m < 1) return 'এইমাত্র'
  if (m < 60) return `${bn(m)} মিনিট আগে`
  const h = Math.floor(m / 60)
  if (h < 24) return `${bn(h)} ঘণ্টা আগে`
  return `${bn(Math.floor(h / 24))} দিন আগে`
}

const KIND_ICON: Record<string, string> = {
  completed: '✅',
  comment: '💬',
  approved: '👍',
  redo: '🔄',
  update_request: '⏰',
  escalation: '🚨',
  self_initiated: '✨',
  award: '🏆',
  group_message: '👥',
  task_assigned: '📋',
}

export default function NotifBell() {
  const router = useRouter()
  const [feed, setFeed] = useState<NotificationFeed>({ unread: 0, items: [] })
  const [open, setOpen] = useState(false)
  const boxRef = useRef<HTMLDivElement>(null)

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/assistant/office/notifications', { cache: 'no-store' })
      if (res.ok) setFeed((await res.json()) as NotificationFeed)
    } catch {
      /* best-effort */
    }
  }, [])

  useEffect(() => {
    load()
    const id = setInterval(load, POLL_MS)
    return () => clearInterval(id)
  }, [load])

  useEffect(() => {
    if (!open) return
    const onClick = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onClick)
    return () => document.removeEventListener('mousedown', onClick)
  }, [open])

  const markAll = async () => {
    await fetch('/api/assistant/office/notifications', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    })
    await load()
    router.refresh()
  }

  const onItem = async (n: OfficeNotice) => {
    if (!n.read) {
      await fetch('/api/assistant/office/notifications', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: n.id }),
      })
      load()
    }
    setOpen(false)
    router.refresh()
  }

  return (
    <div ref={boxRef} style={{ display: 'inline-block' }}>
      <button className="bell" onClick={() => setOpen((v) => !v)} aria-label="নোটিফিকেশন">
        🔔
        {feed.unread > 0 && <span className="bdot">{feed.unread > 9 ? '৯+' : bn(feed.unread)}</span>}
      </button>

      {open && (
        <div className="ohub-notif">
          <div className="nh">
            <b>নোটিফিকেশন</b>
            {feed.unread > 0 && <button onClick={markAll}>সব পড়া হয়েছে</button>}
          </div>
          <div className="nlist">
            {feed.items.length === 0 && <div className="nempty">কোনো নোটিফিকেশন নেই।</div>}
            {feed.items.map((n) => (
              <button key={n.id} className={`ni${n.read ? '' : ' unread'}`} onClick={() => onItem(n)}>
                <span className="ic">{KIND_ICON[n.kind] ?? '🔔'}</span>
                <span style={{ minWidth: 0, flex: 1 }}>
                  <span className="nm" style={{ display: 'block' }}>
                    {n.title}
                  </span>
                  {n.body && (
                    <span className="nb" style={{ display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {n.body}
                    </span>
                  )}
                  <span className="nt" style={{ display: 'block' }}>
                    {timeAgo(n.createdAt)}
                  </span>
                </span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
