'use client'

import { useState, useRef, useCallback, useEffect } from 'react'
import Link from 'next/link'
import DemoSidebar from './DemoSidebar'
import DemoThread from './DemoThread'
import DemoComposer from './DemoComposer'
import {
  DEMO_CONVERSATIONS,
  STREAMING_REPLY,
  STREAMING_THINKING,
  type DemoConversation,
  type DemoMessage,
} from './mock-data'

function useIsMobile() {
  const [mobile, setMobile] = useState(false)
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 767px)')
    const update = () => setMobile(mq.matches)
    update()
    mq.addEventListener('change', update)
    return () => mq.removeEventListener('change', update)
  }, [])
  return mobile
}

let idc = 0
const nextId = () => `gen-${++idc}`

export default function DemoChatApp() {
  const isMobile = useIsMobile()
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [conversations] = useState<DemoConversation[]>(DEMO_CONVERSATIONS)
  const [activeId, setActiveId] = useState<string | null>(null)
  const [messages, setMessages] = useState<DemoMessage[]>([])
  const [streaming, setStreaming] = useState(false)
  const [streamLabel, setStreamLabel] = useState<string | null>(null)
  const [personalActive, setPersonalActive] = useState(false)
  const timers = useRef<ReturnType<typeof setTimeout>[]>([])

  useEffect(() => {
    setSidebarOpen(!isMobile)
  }, [isMobile])

  const clearTimers = useCallback(() => {
    timers.current.forEach(clearTimeout)
    timers.current = []
  }, [])

  useEffect(() => () => clearTimers(), [clearTimers])

  const activeConv = conversations.find((c) => c.id === activeId)

  function selectConversation(c: DemoConversation) {
    clearTimers()
    setStreaming(false)
    setActiveId(c.id)
    setPersonalActive(false)
    setMessages(c.messages)
    if (isMobile) setSidebarOpen(false)
  }

  function newConversation() {
    clearTimers()
    setStreaming(false)
    setActiveId(null)
    setMessages([])
    if (isMobile) setSidebarOpen(false)
  }

  function enterPersonal() {
    clearTimers()
    setStreaming(false)
    setActiveId(null)
    setPersonalActive(true)
    setMessages([])
    if (isMobile) setSidebarOpen(false)
  }

  // Simulated streaming reply for any user-typed message.
  const handleSend = useCallback(
    (text: string) => {
      if (streaming) return
      clearTimers()

      const userMsg: DemoMessage = { id: nextId(), role: 'user', text }
      const assistantId = nextId()
      setMessages((prev) => [...prev, userMsg])
      setStreaming(true)

      // Phase 1: thinking
      setStreamLabel('🤔 ভাবছি…')
      const t1 = setTimeout(() => {
        setMessages((prev) => [
          ...prev,
          { id: assistantId, role: 'assistant', text: '', thinking: STREAMING_THINKING, thinkingSeconds: 3 },
        ])
        setStreamLabel('🔍 ডেটা টানছি…')
      }, 900)

      // Phase 2: stream the reply word by word
      const t2 = setTimeout(() => {
        setStreamLabel('✍️ উত্তর লিখছি…')
        const words = STREAMING_REPLY.split(' ')
        let idx = 0
        const step = () => {
          idx += Math.max(1, Math.round(Math.random() * 2))
          const partial = words.slice(0, idx).join(' ')
          setMessages((prev) =>
            prev.map((m) => (m.id === assistantId ? { ...m, text: partial } : m)),
          )
          if (idx < words.length) {
            const t = setTimeout(step, 55)
            timers.current.push(t)
          } else {
            setMessages((prev) =>
              prev.map((m) =>
                m.id === assistantId
                  ? { ...m, text: STREAMING_REPLY, tokensIn: 1120, tokensOut: 318, costUsd: 0.0187 }
                  : m,
              ),
            )
            setStreaming(false)
            setStreamLabel(null)
          }
        }
        step()
      }, 1900)

      timers.current.push(t1, t2)
    },
    [streaming, clearTimers],
  )

  function stop() {
    clearTimers()
    setStreaming(false)
    setStreamLabel(null)
  }

  const headerTitle = activeConv?.title ?? (personalActive ? 'ব্যক্তিগত মোড' : 'নতুন কথোপকথন')

  return (
    <div className="flex h-[100dvh] min-h-0 overflow-hidden">
      <DemoSidebar
        open={sidebarOpen}
        isMobile={isMobile}
        onClose={() => setSidebarOpen(false)}
        conversations={conversations}
        activeId={activeId}
        onSelect={selectConversation}
        onNew={newConversation}
        personalActive={personalActive}
        onPersonal={enterPersonal}
      />

      <div className="flex min-h-0 flex-1 flex-col">
        {activeConv?.live && (
          <div className="shrink-0 border-b border-emerald-200/60 bg-emerald-50/90 px-4 py-2 text-[11px] font-medium text-emerald-800">
            🏢 <span className="font-semibold">Agent অফিস লাইভ</span> — কাজ চলছে, Cursor-style লাইভ আপডেট দেখছেন
          </div>
        )}

        {/* Header */}
        <header className="relative flex shrink-0 items-center gap-1 border-b border-black/[0.06] bg-white/80 px-3 py-2 backdrop-blur-md md:px-4">
          <button
            type="button"
            onClick={() => setSidebarOpen((v) => !v)}
            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl text-gray-400 transition-all hover:bg-black/[0.04] hover:text-gray-600 active:scale-95"
            aria-label="সাইডবার"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M4 6h16M4 12h16M4 18h16" /></svg>
          </button>

          <div className="flex min-w-0 flex-1 items-center justify-center gap-2">
            <span className="truncate text-[14px] font-semibold text-gray-700">{headerTitle}</span>
            {personalActive && (
              <span className="shrink-0 rounded-full border border-emerald-400/30 bg-emerald-50 px-2 py-0.5 text-[10px] font-medium text-emerald-600">ব্যক্তিগত</span>
            )}
            {activeConv?.live && (
              <span className="shrink-0 animate-pulse rounded-full border border-emerald-400/40 bg-emerald-50 px-2 py-0.5 text-[10px] font-medium text-emerald-700">অফিস লাইভ</span>
            )}
          </div>

          <button
            type="button"
            onClick={newConversation}
            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl text-gray-400 transition-all hover:bg-black/[0.04] hover:text-gray-600 active:scale-95"
            aria-label="নতুন চ্যাট"
            title="নতুন কথোপকথন"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M12 5v14M5 12h14" /></svg>
          </button>

          <div className="hidden items-center gap-1 md:flex">
            <Link href="/agent-demo/monitor" className="flex h-8 items-center rounded-lg px-2.5 text-[11px] text-gray-400 transition-all hover:bg-black/[0.04] hover:text-gray-600">Monitor</Link>
            <Link href="/agent-demo/costs" className="flex h-8 items-center rounded-lg px-2.5 text-[11px] text-gray-400 transition-all hover:bg-black/[0.04] hover:text-gray-600">Costs</Link>
          </div>
        </header>

        {personalActive && (
          <div className="shrink-0 border-b border-emerald-200/50 bg-emerald-50/60 px-4 py-1.5 text-center text-[11px] text-emerald-700 backdrop-blur-md">
            ব্যক্তিগত মোড — শুধু ব্যক্তিগত ও পারিবারিক বিষয়
          </div>
        )}

        <DemoThread messages={messages} streaming={streaming} streamLabel={streamLabel} onSuggestion={handleSend} />

        <DemoComposer onSend={handleSend} streaming={streaming} onStop={stop} />
      </div>

      {/* Mobile bottom nav */}
      <nav className="fixed bottom-0 left-0 right-0 z-30 border-t border-black/[0.06] bg-white/90 backdrop-blur-md md:hidden">
        <div className="flex items-center justify-around px-4 py-2" style={{ paddingBottom: 'max(0.5rem, env(safe-area-inset-bottom))' }}>
          <NavLink href="/agent-demo" label="Chat" active />
          <NavLink href="/agent-demo/monitor" label="Monitor" />
          <NavLink href="/agent-demo/costs" label="Costs" />
        </div>
      </nav>
    </div>
  )
}

function NavLink({ href, label, active }: { href: string; label: string; active?: boolean }) {
  return (
    <Link href={href} className={`flex flex-col items-center gap-0.5 px-4 py-1 text-[10px] font-medium ${active ? 'text-[#E07A5F]' : 'text-[#94A3B8]'}`}>
      <span className="h-1 w-6 rounded-full" style={{ background: active ? '#E07A5F' : 'transparent' }} />
      {label}
    </Link>
  )
}
