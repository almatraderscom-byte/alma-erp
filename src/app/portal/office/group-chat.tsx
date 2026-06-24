'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import type { ChatFeed, ChatMessage } from '@/agent/lib/office-chat'

const POLL_MS = 15_000
const BN = '০১২৩৪৫৬৭৮৯'
const bn = (n: number | string) => String(n).replace(/\d/g, (d) => BN[Number(d)])

export default function GroupChat({ self }: { self: 'owner' | 'staff' }) {
  const [open, setOpen] = useState(false)
  const [feed, setFeed] = useState<ChatFeed>({ businessId: '', messages: [] })
  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false)
  const [lastSeen, setLastSeen] = useState<string | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/assistant/office/chat', { cache: 'no-store' })
      if (res.ok) setFeed((await res.json()) as ChatFeed)
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
    if (open && scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight
  }, [open, feed.messages.length])

  useEffect(() => {
    if (open && feed.messages.length > 0) setLastSeen(feed.messages[feed.messages.length - 1].id)
  }, [open, feed.messages])

  // unread count = messages after the last one seen
  let unread = 0
  if (!open) {
    if (lastSeen === null) unread = feed.messages.length
    else {
      const idx = feed.messages.findIndex((m) => m.id === lastSeen)
      unread = idx === -1 ? feed.messages.length : feed.messages.length - idx - 1
    }
  }

  const send = async () => {
    const text = draft.trim()
    if (!text || sending) return
    setSending(true)
    try {
      const res = await fetch('/api/assistant/office/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ body: text }),
      })
      if (res.ok) {
        setDraft('')
        await load()
      }
    } finally {
      setSending(false)
    }
  }

  return (
    <>
      {!open && (
        <div className="ohub-chathead" onClick={() => setOpen(true)} role="button" aria-label="অফিস গ্রুপ চ্যাট">
          <span className="ring"></span>
          <span className="em">🤖</span>
          <span>অফিস গ্রুপ চ্যাট</span>
          {unread > 0 && <span className="badge2">{bn(unread)}</span>}
        </div>
      )}

      {open && (
        <div className="ohub-chatpanel">
          <div className="cp-head">
            <div className="gav">🤖</div>
            <div className="ttl">
              <b>অফিস গ্রুপ</b>
              <span>● Agent, আপনি, টিম</span>
            </div>
            <button className="x" onClick={() => setOpen(false)}>
              ×
            </button>
          </div>
          <div className="cp-body" ref={scrollRef}>
            {feed.messages.length === 0 && (
              <div className="gsys">— এখনো কোনো বার্তা নেই। প্রথম বার্তাটি লিখুন। —</div>
            )}
            {feed.messages.map((m) => (
              <GroupMsg key={m.id} m={m} self={self} />
            ))}
          </div>
          <div className="cp-foot">
            <input
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault()
                  send()
                }
              }}
              placeholder="গ্রুপে মেসেজ লিখুন…"
            />
            <button disabled={sending || !draft.trim()} onClick={send}>
              পাঠান
            </button>
          </div>
        </div>
      )}
    </>
  )
}

function GroupMsg({ m, self }: { m: ChatMessage; self: 'owner' | 'staff' }) {
  const mine = m.authorType === self
  const isAgent = m.authorType === 'agent'
  const isOwner = m.authorType === 'owner'

  const cls = isAgent ? 'gm agent' : mine ? 'gm me' : 'gm'
  const initial = isAgent ? '🤖' : isOwner ? 'M' : (m.authorName.trim()[0] || '?').toUpperCase()
  const avv = isAgent ? '' : isOwner ? 'o' : 'e'
  const name = isAgent ? 'Agent' : isOwner ? (mine ? 'আপনি (Boss)' : 'Boss') : m.authorName

  return (
    <div className={cls}>
      <span className={`av ${avv}`.trim()}>{initial}</span>
      <div>
        <div className="nmt">{name}</div>
        <div className="gb">{m.body}</div>
      </div>
    </div>
  )
}
