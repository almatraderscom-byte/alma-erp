'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import type { ChatFeed, ChatMessage } from '@/agent/lib/office-chat'

const POLL_MS = 15_000

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

  const lastId = feed.messages.at(-1)?.id ?? null
  const hasUnseen = !open && lastId !== null && lastId !== lastSeen

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
      <button
        onClick={() => setOpen((v) => !v)}
        aria-label="অফিস চ্যাট"
        className="fixed bottom-5 right-5 z-30 flex h-14 w-14 items-center justify-center rounded-full bg-gradient-to-br from-sky-500 to-violet-600 text-2xl shadow-lg ring-1 ring-white/20"
      >
        💬
        {hasUnseen && (
          <span className="absolute -right-0.5 -top-0.5 h-3.5 w-3.5 rounded-full border-2 border-[#0b1020] bg-rose-500" />
        )}
      </button>

      {open && (
        <div className="fixed bottom-24 right-5 z-30 flex h-[60vh] max-h-[520px] w-[22rem] max-w-[90vw] flex-col overflow-hidden rounded-2xl border border-white/10 bg-[#0b1020] shadow-2xl ring-1 ring-black/40">
          <div className="flex items-center justify-between border-b border-white/10 px-4 py-3">
            <div>
              <p className="text-sm font-semibold text-white">👥 অফিস চ্যাট</p>
              <p className="text-[11px] text-slate-400">মালিক · স্টাফ · এজেন্ট</p>
            </div>
            <button onClick={() => setOpen(false)} className="text-slate-400 hover:text-white">
              ✕
            </button>
          </div>

          <div ref={scrollRef} className="flex-1 space-y-2 overflow-y-auto px-3 py-3">
            {feed.messages.length === 0 && (
              <p className="py-8 text-center text-sm text-slate-500">এখনো কোনো বার্তা নেই। প্রথম বার্তাটি লিখুন।</p>
            )}
            {feed.messages.map((m) => (
              <ChatBubble key={m.id} m={m} self={self} />
            ))}
          </div>

          <div className="flex gap-2 border-t border-white/10 p-2">
            <input
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault()
                  send()
                }
              }}
              placeholder="বার্তা লিখুন…"
              className="flex-1 rounded-lg bg-black/30 px-3 py-2 text-sm text-slate-100 outline-none ring-1 ring-white/10"
            />
            <button
              disabled={sending || !draft.trim()}
              onClick={send}
              className="rounded-lg bg-sky-500/25 px-3 py-2 text-sm font-medium text-sky-100 ring-1 ring-sky-500/40 disabled:opacity-50"
            >
              পাঠান
            </button>
          </div>
        </div>
      )}
    </>
  )
}

function ChatBubble({ m, self }: { m: ChatMessage; self: 'owner' | 'staff' }) {
  const mine = m.authorType === self
  const isAgent = m.authorType === 'agent'
  const isOwner = m.authorType === 'owner'

  const tone = isAgent
    ? 'bg-violet-500/15 text-violet-100 ring-violet-500/25'
    : isOwner
      ? 'bg-emerald-500/15 text-emerald-100 ring-emerald-500/25'
      : 'bg-white/[0.06] text-slate-100 ring-white/10'

  const icon = isAgent ? '🤖' : isOwner ? '👑' : '👤'

  return (
    <div className={`flex ${mine ? 'justify-end' : 'justify-start'}`}>
      <div className={`max-w-[80%] rounded-2xl px-3 py-2 ring-1 ${tone}`}>
        {!mine && (
          <p className="mb-0.5 text-[11px] font-medium opacity-70">
            {icon} {m.authorName}
            {m.isAgentReply ? ' · ব্যাখ্যা' : ''}
          </p>
        )}
        <p className="whitespace-pre-line text-sm leading-snug">{m.body}</p>
      </div>
    </div>
  )
}
