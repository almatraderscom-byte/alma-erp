'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ChatFeed, ChatMessage } from '@/agent/lib/office-chat'
import {
  useIntercom,
  IntercomDock,
  IntercomBubble,
  IntercomTakeover,
  IntercomStyle,
  IntercomCall,
  type Intercom,
  type ItcBroadcast,
} from './intercom'

const POLL_MS = 15_000
const BN = '০১২৩৪৫৬৭৮৯'
const bn = (n: number | string) => String(n).replace(/\d/g, (d) => BN[Number(d)])

export default function GroupChat({ self }: { self: 'owner' | 'staff' }) {
  const [open, setOpen] = useState(false)
  const [feed, setFeed] = useState<ChatFeed>({ businessId: '', messages: [] })
  // Live intercom (walkie-talkie) — polls its own fast feed; broadcasts merge
  // into the message list below and the owner gets the PTT dock.
  const itc = useIntercom(self)
  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false)
  const [lastSeen, setLastSeen] = useState<string | null>(null)
  const [actingId, setActingId] = useState<string | null>(null)
  // Images attached to the message being composed (uploaded → signed URLs).
  const [pendingImgs, setPendingImgs] = useState<{ id: string; preview: string; url: string }[]>([])
  const [uploadingImgs, setUploadingImgs] = useState(0)
  // "আজকের কাজ" picker (staff only): tap a task → agent auto-explains it.
  const [tasksOpen, setTasksOpen] = useState(false)
  const [myTasks, setMyTasks] = useState<{ id: string; title: string; type: string; serial: number }[] | null>(null)
  const [explainingId, setExplainingId] = useState<string | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const MAX_IMGS = 6
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
  }, [open, feed.messages.length, itc.feed.broadcasts.length])

  useEffect(() => {
    if (open && feed.messages.length > 0) setLastSeen(feed.messages[feed.messages.length - 1].id)
  }, [open, feed.messages])

  // Chat messages + intercom broadcasts interleaved by time (oldest first).
  const merged = useMemo(() => {
    const rows: ({ el: 'msg'; t: number; m: ChatMessage } | { el: 'itc'; t: number; b: ItcBroadcast })[] = [
      ...feed.messages.map((m) => ({ el: 'msg' as const, t: Date.parse(m.createdAt) || 0, m })),
      ...itc.feed.broadcasts.map((b) => ({ el: 'itc' as const, t: Date.parse(b.createdAt) || 0, b })),
    ]
    rows.sort((a, b) => a.t - b.t)
    return rows
  }, [feed.messages, itc.feed.broadcasts])

  // unread count = messages after the last one seen
  let unread = 0
  if (!open) {
    if (lastSeen === null) unread = feed.messages.length
    else {
      const idx = feed.messages.findIndex((m) => m.id === lastSeen)
      unread = idx === -1 ? feed.messages.length : feed.messages.length - idx - 1
    }
  }

  const pickImages = async (files: FileList | null) => {
    if (!files || files.length === 0) return
    const room = MAX_IMGS - pendingImgs.length
    const batch = Array.from(files).slice(0, Math.max(0, room))
    if (batch.length === 0) return
    setUploadingImgs((n) => n + batch.length)
    await Promise.all(
      batch.map(async (f) => {
        const preview = URL.createObjectURL(f)
        const fd = new FormData()
        fd.append('file', f)
        try {
          const res = await fetch('/api/assistant/office/upload', { method: 'POST', body: fd })
          const data = res.ok ? ((await res.json()) as { url?: string }) : null
          if (data?.url) {
            setPendingImgs((prev) => (prev.length >= MAX_IMGS ? prev : [...prev, { id: `${Date.now()}-${Math.random()}`, preview, url: data.url! }]))
          }
        } finally {
          setUploadingImgs((n) => Math.max(0, n - 1))
        }
      }),
    )
  }

  // Toggle the "আজকের কাজ" picker; fetch the staff's open tasks on first open.
  const toggleTasks = async () => {
    const next = !tasksOpen
    setTasksOpen(next)
    if (next && myTasks === null) {
      try {
        const res = await fetch('/api/assistant/office/my-tasks', { cache: 'no-store' })
        const data = res.ok ? ((await res.json()) as { tasks?: typeof myTasks }) : null
        setMyTasks(data?.tasks ?? [])
      } catch {
        setMyTasks([])
      }
    }
  }

  // Staff taps a task → agent explains it once (no owner approval). The question +
  // explanation post straight to the group; we refresh and close the picker.
  const explainTask = async (taskId: string) => {
    if (explainingId) return
    setExplainingId(taskId)
    try {
      const res = await fetch('/api/assistant/office/chat/explain', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ taskId }),
      })
      if (res.ok) {
        setTasksOpen(false)
        await load()
      }
    } finally {
      setExplainingId(null)
    }
  }

  const send = async () => {
    const text = draft.trim()
    const attachments = pendingImgs.map((p) => ({ type: 'image', url: p.url }))
    if ((!text && attachments.length === 0) || sending || uploadingImgs > 0) return
    setSending(true)
    try {
      const res = await fetch('/api/assistant/office/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ body: text, attachments }),
      })
      if (res.ok) {
        setDraft('')
        setPendingImgs([])
        await load()
      }
    } finally {
      setSending(false)
    }
  }

  return (
    <>
      <IntercomStyle />
      {self === 'staff' && <IntercomTakeover itc={itc} />}
      <IntercomCall itc={itc} />
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
            {merged.map((row) =>
              row.el === 'itc' ? (
                <IntercomMsg key={`itc-${row.b.id}`} b={row.b} itc={itc} self={self} />
              ) : row.m.status === 'pending' ? (
                <AgentDraft
                  key={row.m.id}
                  m={row.m}
                  busy={actingId === row.m.id}
                  disabled={actingId !== null}
                  onApprove={(body) => act(row.m.id, 'approve', body)}
                  onDismiss={() => act(row.m.id, 'dismiss')}
                />
              ) : (
                <GroupMsg key={row.m.id} m={row.m} self={self} />
              ),
            )}
          </div>
          {(pendingImgs.length > 0 || uploadingImgs > 0) && (
            <div className="cp-pending">
              {pendingImgs.map((p) => (
                <div className="cp-pimg" key={p.id}>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={p.preview} alt="" />
                  <button aria-label="মুছুন" onClick={() => setPendingImgs((prev) => prev.filter((x) => x.id !== p.id))}>×</button>
                </div>
              ))}
              {Array.from({ length: uploadingImgs }).map((_, i) => (
                <div className="cp-pimg up" key={`u${i}`}>…</div>
              ))}
            </div>
          )}
          {self === 'staff' && tasksOpen && (
            <div className="cp-tasks">
              <div className="cp-tasks-h">আজকের কাজ — যেটা বুঝছেন না, সেটায় চাপ দিন</div>
              {myTasks === null ? (
                <div className="cp-tasks-e">লোড হচ্ছে…</div>
              ) : myTasks.length === 0 ? (
                <div className="cp-tasks-e">আজ আপনার কোনো বাকি কাজ নেই।</div>
              ) : (
                myTasks.map((t) => (
                  <button
                    key={t.id}
                    className="cp-task"
                    disabled={explainingId !== null}
                    onClick={() => explainTask(t.id)}
                  >
                    <span className="cp-task-n">{bn(t.serial)}</span>
                    <span className="cp-task-t">{t.title}</span>
                    <span className="cp-task-q">{explainingId === t.id ? '…' : 'বুঝিয়ে দিন'}</span>
                  </button>
                ))
              )}
            </div>
          )}
          {self === 'owner' && <IntercomDock itc={itc} />}
          <div className="cp-foot">
            <input
              ref={fileRef}
              type="file"
              accept="image/*"
              multiple
              hidden
              onChange={(e) => { pickImages(e.target.files); e.target.value = '' }}
            />
            {self === 'staff' && (
              <button
                className={`cp-attach${tasksOpen ? ' on' : ''}`}
                aria-label="আজকের কাজ"
                aria-expanded={tasksOpen}
                onClick={toggleTasks}
              >
                📋
              </button>
            )}
            <button
              className="cp-attach"
              aria-label="ছবি যোগ করুন"
              disabled={pendingImgs.length >= MAX_IMGS}
              onClick={() => fileRef.current?.click()}
            >
              📷
            </button>
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
            <button disabled={sending || uploadingImgs > 0 || (!draft.trim() && pendingImgs.length === 0)} onClick={send}>
              পাঠান
            </button>
          </div>
        </div>
      )}
    </>
  )
}

// An intercom broadcast rendered as a chat row — always authored by the Boss,
// so it sits right-aligned for the owner and left-aligned for staff.
function IntercomMsg({ b, itc, self }: { b: ItcBroadcast; itc: Intercom; self: 'owner' | 'staff' }) {
  const mine = self === 'owner'
  return (
    <div className={mine ? 'gm me' : 'gm'}>
      <span className="av o">M</span>
      <div style={{ minWidth: 0, flex: 1 }}>
        <div className="nmt" style={mine ? { textAlign: 'right' } : undefined}>
          {mine ? 'আপনি (Boss)' : 'Boss'} · 🎙️
        </div>
        <IntercomBubble b={b} itc={itc} />
      </div>
    </div>
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
  const img = !isAgent ? m.authorImageUrl : null
  const attachments = m.attachments ?? []

  return (
    <div className={cls}>
      {img ? (
        <span className={`av ${avv} img`.trim()} style={{ backgroundImage: `url(${img})` }} />
      ) : (
        <span className={`av ${avv}`.trim()}>{initial}</span>
      )}
      <div>
        <div className="nmt">{name}</div>
        {attachments.length > 0 && (
          <div className={`gm-imgs${attachments.length === 1 ? ' one' : ''}`}>
            {attachments.map((a, i) => (
              <a key={i} href={a.url} target="_blank" rel="noreferrer" className="gm-img">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={a.url} alt="attachment" />
              </a>
            ))}
          </div>
        )}
        {m.body.trim() && <div className="gb">{m.body}</div>}
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
