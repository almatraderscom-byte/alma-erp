'use client'

import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * WhatsApp-style live inbox (owner-only) at /agent/whatsapp.
 *
 * Reads /api/assistant/wa-inbox (threads = inbound WhatsApp stored as CsConversation
 * "wa:") and renders them in a real-WhatsApp look: dark chat theme, thread list,
 * green outgoing / grey incoming bubbles. Polls every 5s so new messages appear live.
 *
 * Read-only for now (no reply box) — it's a viewing surface so the owner can see what
 * staff/customers send. Replies still go through the agent / CS brain.
 */
type WaMessage = { from: 'them' | 'us'; text: string; at: string | null }
type WaThread = {
  id: string
  number: string
  name: string
  lastMessage: string
  lastAt: string | null
  needsReply: boolean
  messages: WaMessage[]
}

const WA = {
  bg: '#0b141a',
  panel: '#111b21',
  header: '#202c33',
  incoming: '#202c33',
  outgoing: '#005c4b',
  green: '#00a884',
  text: '#e9edef',
  muted: '#8696a0',
}

function fmtTime(at: string | null): string {
  if (!at) return ''
  try {
    return new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Asia/Dhaka',
      hour: '2-digit',
      minute: '2-digit',
      hour12: true,
    }).format(new Date(at))
  } catch {
    return ''
  }
}

function initials(name: string): string {
  const n = (name || '').trim()
  if (!n) return '#'
  if (/^\+?\d/.test(n)) return '👤'
  return n.slice(0, 1).toUpperCase()
}

export default function WhatsAppInbox() {
  const [threads, setThreads] = useState<WaThread[]>([])
  const [openId, setOpenId] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const endRef = useRef<HTMLDivElement>(null)

  const load = useCallback(async () => {
    try {
      const r = await fetch('/api/assistant/wa-inbox', { cache: 'no-store' })
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      const j = (await r.json()) as { threads?: WaThread[]; error?: string }
      setThreads(Array.isArray(j.threads) ? j.threads : [])
      setError(j.error ?? null)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load()
    const t = setInterval(load, 5000)
    return () => clearInterval(t)
  }, [load])

  const open = openId ? threads.find((t: WaThread) => t.id === openId) ?? null : null

  // Keep the open chat scrolled to the latest message as it polls.
  useEffect(() => {
    if (open) endRef.current?.scrollIntoView({ block: 'end' })
  }, [open?.messages.length, openId]) // eslint-disable-line react-hooks/exhaustive-deps

  const awaiting = threads.filter((t: WaThread) => t.needsReply).length

  return (
    <div className="flex h-[100dvh] flex-col" style={{ background: WA.bg, color: WA.text }}>
      {!open ? (
        <>
          {/* List header */}
          <div className="flex items-center justify-between px-4 py-3" style={{ background: WA.header }}>
            <div>
              <h1 className="text-[17px] font-semibold" style={{ color: WA.text }}>WhatsApp</h1>
              <p className="text-[12px]" style={{ color: WA.muted }}>
                {loading ? 'লোড হচ্ছে…' : `${threads.length} চ্যাট${awaiting ? ` · ${awaiting} reply বাকি` : ''}`}
              </p>
            </div>
            <span
              className="grid h-9 w-9 place-items-center rounded-full text-[18px]"
              style={{ background: WA.green, color: '#0b141a' }}
            >
              ✓
            </span>
          </div>

          {/* Thread list */}
          <div className="min-h-0 flex-1 overflow-y-auto">
            {threads.length === 0 && !loading ? (
              <div className="px-6 py-16 text-center" style={{ color: WA.muted }}>
                <div className="mb-3 text-[40px]">💬</div>
                <p className="text-[14px] font-medium" style={{ color: WA.text }}>এখনো কোনো মেসেজ আসেনি</p>
                <p className="mx-auto mt-2 max-w-xs text-[12px] leading-relaxed">
                  কেউ আপনার business WhatsApp নম্বরে মেসেজ দিলে সেটা এখানে লাইভ দেখা যাবে — ঠিক WhatsApp-এর মতো।
                  {error ? '' : ' (Twilio inbound webhook সেট থাকলে তবেই মেসেজ এখানে আসবে।)'}
                </p>
              </div>
            ) : (
              threads.map((t: WaThread) => (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => setOpenId(t.id)}
                  className="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors active:opacity-80"
                  style={{ borderBottom: '1px solid rgba(255,255,255,0.05)' }}
                >
                  <span
                    className="grid h-12 w-12 shrink-0 place-items-center rounded-full text-[18px] font-semibold"
                    style={{ background: '#2a3942', color: WA.text }}
                  >
                    {initials(t.name)}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center justify-between gap-2">
                      <span className="truncate text-[15px] font-medium" style={{ color: WA.text }}>{t.name}</span>
                      <span className="shrink-0 text-[11px]" style={{ color: t.needsReply ? WA.green : WA.muted }}>
                        {fmtTime(t.lastAt)}
                      </span>
                    </span>
                    <span className="mt-0.5 flex items-center justify-between gap-2">
                      <span className="truncate text-[13px]" style={{ color: WA.muted }}>{t.lastMessage}</span>
                      {t.needsReply && (
                        <span className="grid h-5 min-w-5 shrink-0 place-items-center rounded-full px-1.5 text-[11px] font-bold" style={{ background: WA.green, color: '#0b141a' }}>
                          !
                        </span>
                      )}
                    </span>
                  </span>
                </button>
              ))
            )}
          </div>
        </>
      ) : (
        <>
          {/* Chat header */}
          <div className="flex items-center gap-3 px-3 py-2.5" style={{ background: WA.header }}>
            <button type="button" onClick={() => setOpenId(null)} className="px-1 text-[22px]" style={{ color: WA.text }} aria-label="back">‹</button>
            <span className="grid h-10 w-10 shrink-0 place-items-center rounded-full text-[16px] font-semibold" style={{ background: '#2a3942', color: WA.text }}>
              {initials(open.name)}
            </span>
            <div className="min-w-0">
              <p className="truncate text-[15px] font-semibold" style={{ color: WA.text }}>{open.name}</p>
              <p className="truncate text-[12px]" style={{ color: WA.muted }}>{open.number}</p>
            </div>
          </div>

          {/* Messages */}
          <div
            className="min-h-0 flex-1 overflow-y-auto px-3 py-3"
            style={{
              background:
                'linear-gradient(rgba(11,20,26,0.96), rgba(11,20,26,0.96)), repeating-linear-gradient(45deg, #0c161d 0 18px, #0b141a 18px 36px)',
            }}
          >
            {open.messages.length === 0 ? (
              <p className="mt-10 text-center text-[12px]" style={{ color: WA.muted }}>কোনো মেসেজ নেই</p>
            ) : (
              open.messages.map((m: WaMessage, i: number) => (
                <div key={i} className={`mb-1.5 flex ${m.from === 'us' ? 'justify-end' : 'justify-start'}`}>
                  <div
                    className="max-w-[78%] rounded-lg px-2.5 py-1.5 text-[14px] leading-snug shadow-sm"
                    style={{
                      background: m.from === 'us' ? WA.outgoing : WA.incoming,
                      color: WA.text,
                      borderTopRightRadius: m.from === 'us' ? 2 : 8,
                      borderTopLeftRadius: m.from === 'us' ? 8 : 2,
                    }}
                  >
                    <span className="whitespace-pre-wrap break-words">{m.text}</span>
                    <span className="ml-2 inline-block align-bottom text-[10px]" style={{ color: WA.muted }}>{fmtTime(m.at)}</span>
                  </div>
                </div>
              ))
            )}
            <div ref={endRef} />
          </div>

          {/* Read-only note (no reply box yet) */}
          <div className="px-4 py-2.5 text-center text-[11px]" style={{ background: WA.header, color: WA.muted }}>
            শুধু দেখার জন্য · রিপ্লাই দিতে এজেন্টকে বলুন
          </div>
        </>
      )}
    </div>
  )
}
