'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import type { NotificationFeed, OfficeNotice } from '@/agent/lib/office-notifications'

const POLL_MS = 30_000

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime()
  const m = Math.floor(diff / 60_000)
  if (m < 1) return 'এইমাত্র'
  if (m < 60) return `${m} মিনিট আগে`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h} ঘণ্টা আগে`
  return `${Math.floor(h / 24)} দিন আগে`
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
    <div ref={boxRef} className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        aria-label="নোটিফিকেশন"
        className="relative flex h-10 w-10 items-center justify-center rounded-full bg-white/5 text-lg ring-1 ring-white/10"
      >
        🔔
        {feed.unread > 0 && (
          <span className="absolute -right-0.5 -top-0.5 flex h-5 min-w-5 items-center justify-center rounded-full bg-rose-500 px-1 text-[11px] font-bold text-white">
            {feed.unread > 9 ? '9+' : feed.unread}
          </span>
        )}
      </button>

      {open && (
        <div className="absolute right-0 z-20 mt-2 w-80 max-w-[88vw] overflow-hidden rounded-2xl border border-white/10 bg-[#0b1020] shadow-xl ring-1 ring-black/40">
          <div className="flex items-center justify-between border-b border-white/10 px-3 py-2">
            <p className="text-sm font-semibold text-white">নোটিফিকেশন</p>
            {feed.unread > 0 && (
              <button onClick={markAll} className="text-xs font-medium text-sky-300 hover:text-sky-200">
                সব পড়া হয়েছে
              </button>
            )}
          </div>
          <div className="max-h-96 overflow-y-auto">
            {feed.items.length === 0 && (
              <p className="px-3 py-6 text-center text-sm text-slate-500">কোনো নোটিফিকেশন নেই।</p>
            )}
            {feed.items.map((n) => (
              <button
                key={n.id}
                onClick={() => onItem(n)}
                className={`flex w-full gap-2.5 border-b border-white/5 px-3 py-2.5 text-left last:border-0 ${
                  n.read ? 'opacity-60' : 'bg-sky-500/[0.06]'
                }`}
              >
                <span className="mt-0.5 text-base">{KIND_ICON[n.kind] ?? '🔔'}</span>
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-medium leading-snug text-slate-100">{n.title}</span>
                  {n.body && <span className="mt-0.5 block truncate text-xs text-slate-400">{n.body}</span>}
                  <span className="mt-0.5 block text-[11px] text-slate-500">{timeAgo(n.createdAt)}</span>
                </span>
                {!n.read && <span className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-sky-400" />}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
