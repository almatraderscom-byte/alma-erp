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
  const [actingId, setActingId] = useState<string | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  // Staff message ids we've already asked the agent to draft a reply for, so the
  // poll loop never re-requests (the server also enforces "reply once").
  const requestedRef = useRef<Set<string>>(new Set())

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/assistant/office/chat', { cache: 'no-store' })
      if (res.ok) setFeed((await res.json()) as ChatFeed)
    } catch {
      /* best-effort */
    }
  }, [])

  // Owner only: when a staff posts and the agent hasn't drafted a reply yet,
  // ask the server to draft ONE (DeepSeek). The draft lands as a pending bubble
  // the owner approves or dismisses. One request per message.
  const maybeDraft = useCallback(async () => {
    if (self !== 'owner') return
    const msgs = feed.messages
    if (msgs.length === 0) return
    // The most recent staff message that has no agent reply (pending/posted) after it.
    const repliedTo = new Set(
      msgs.filter((m) => m.authorType === 'agent' && m.replyToId).map((m) => m.replyToId as string),
    )
    const target = [...msgs].reverse().find((m) => m.authorType === 'staff' && !repliedTo.has(m.id))
    if (!target || requestedRef.current.has(target.id)) return
    requestedRef.current.add(target.id)
    try {
      const res = await fetch('/api/assistant/office/chat/agent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'draft', replyToId: target.id }),
      })
      if (res.ok) await load()
    } catch {
      /* best-effort */
    }
  }, [self, feed.messages, load])

  useEffect(() => {
    load()
    const id = setInterval(load, POLL_MS)
    return () => clearInterval(id)
  }, [load])

  useEffect(() => {
    void maybeDraft()
  }, [maybeDraft])

  const act = async (id: string, action: 'approve' | 'dismiss', editedBody?: string) => {
    if (actingId) return
    setActingId(id)
    try {
      const res = await fetch('/api/assistant/office/chat/agent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, id, body: editedBody }),
      })
      if (res.ok) await load()
    } finally {
      setActingId(null)
    }
  }

  // Keep the latest message in view. Jump instantly when the panel first opens,
  // but glide smoothly for messages that arrive while it's already open — the
  // .cp-body scroller carries scroll-behavior:smooth, so a single rAF lets the
  // new bubble lay out before we animate to the bottom.
  const wasOpen = useRef(false)
  useEffect(() => {
    const el = scrollRef.current
    if (!open || !el) {
      wasOpen.current = open
      return
    }
    const justOpened = !wasOpen.current
    wasOpen.current = true
    requestAnimationFrame(() => {
      el.scrollTo({ top: el.scrollHeight, behavior: justOpened ? 'auto' : 'smooth' })
    })
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
            {feed.messages.map((m) =>
              m.status === 'pending' ? (
                <AgentDraft
                  key={m.id}
                  m={m}
                  busy={actingId === m.id}
                  disabled={actingId !== null}
                  onApprove={(body) => act(m.id, 'approve', body)}
                  onDismiss={() => act(m.id, 'dismiss')}
                />
              ) : (
                <GroupMsg key={m.id} m={m} self={self} />
              ),
            )}
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

// Owner-only: a pending agent draft (DeepSeek). The owner reviews it, optionally
// edits the text, then approves (→ posted for everyone) or dismisses it. Staff
// never receive 'pending' rows from the server, so this only renders for the owner.
function AgentDraft({
  m,
  busy,
  disabled,
  onApprove,
  onDismiss,
}: {
  m: ChatMessage
  busy: boolean
  disabled: boolean
  onApprove: (body?: string) => void
  onDismiss: () => void
}) {
  const [editing, setEditing] = useState(false)
  const [text, setText] = useState(m.body)

  return (
    <div className="gm agent draft">
      <span className="av">🤖</span>
      <div>
        <div className="nmt">
          Agent <span className="dtag">খসড়া · শুধু আপনি দেখছেন</span>
        </div>
        {editing ? (
          <textarea className="dedit" value={text} onChange={(e) => setText(e.target.value)} rows={3} />
        ) : (
          <div className="gb">{m.body}</div>
        )}
        <div className="dact">
          <button
            className="ap"
            disabled={disabled || !text.trim()}
            onClick={() => onApprove(editing ? text.trim() : undefined)}
          >
            {busy ? '…' : '✅ পাঠান'}
          </button>
          <button className="ed" disabled={disabled} onClick={() => setEditing((v) => !v)}>
            {editing ? '↩ ফিরে যান' : '✏️ এডিট'}
          </button>
          <button className="ds" disabled={disabled} onClick={onDismiss}>
            ✖ বাতিল
          </button>
        </div>
      </div>
    </div>
  )
}
