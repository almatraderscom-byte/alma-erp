'use client'

import {
  createContext,
  useCallback,
  useContext,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { Button, Input, Select } from '@/components/ui'
import { useBusiness } from '@/contexts/BusinessContext'
import { cn } from '@/lib/utils'
import { useRegisterMobileRefresh } from '@/hooks/useRegisterMobileRefresh'
import { PLATFORM_Z } from '@/lib/platform-z-index'

type Priority = 'LOW' | 'NORMAL' | 'HIGH' | 'CRITICAL'

type NotificationRow = {
  id: string
  title: string
  message: string
  type: string
  priority: Priority
  pinned: boolean
  actionUrl?: string | null
  businessId?: string | null
  createdAt: string
  recipient?: {
    readAt?: string | null
    seenAt?: string | null
    acknowledgedAt?: string | null
    deliveryStatus?: string
    pushStatus?: string | null
  } | null
}

const priorityClass: Record<Priority, string> = {
  LOW: 'border-zinc-600/40 text-zinc-400 bg-zinc-500/5',
  NORMAL: 'border-gold-dim/30 text-gold-lt bg-gold/10',
  HIGH: 'border-amber-400/40 text-amber-300 bg-amber-500/10',
  CRITICAL: 'border-red-400/50 text-red-300 bg-red-500/15',
}

function vibrate(priority: Priority) {
  if (typeof navigator === 'undefined' || !navigator.vibrate) return
  if (priority === 'HIGH') navigator.vibrate([180, 90, 180])
  if (priority === 'CRITICAL') navigator.vibrate([300, 120, 300, 120, 500])
}

function playTone() {
  try {
    const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
    if (!AudioCtx) return
    const ctx = new AudioCtx()
    const osc = ctx.createOscillator()
    const gain = ctx.createGain()
    osc.frequency.value = 880
    gain.gain.value = 0.04
    osc.connect(gain)
    gain.connect(ctx.destination)
    osc.start()
    setTimeout(() => {
      osc.stop()
      void ctx.close()
    }, 220)
  } catch {
    /* audio blocked */
  }
}

async function patchNotification(id: string, action: 'read' | 'unread' | 'ack' | 'pin' | 'unpin') {
  await fetch('/api/notifications', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id, action }),
  })
}

type NotificationShellContextValue = {
  unread: number
  criticalUnacked: number
  openPanel: () => void
}

const NotificationShellContext = createContext<NotificationShellContextValue | null>(null)

export function useNotificationShell() {
  const ctx = useContext(NotificationShellContext)
  if (!ctx) {
    return {
      unread: 0,
      criticalUnacked: 0,
      openPanel: () => {
        window.dispatchEvent(new Event('alma-open-notifications'))
      },
    }
  }
  return ctx
}

export function NotificationShellProvider({ children }: { children: ReactNode }) {
  const { businessId } = useBusiness()
  const [open, setOpen] = useState(false)
  const [rows, setRows] = useState<NotificationRow[]>([])
  const [unread, setUnread] = useState(0)
  const [criticalUnacked, setCriticalUnacked] = useState(0)
  const [q, setQ] = useState('')
  const deferredQ = useDeferredValue(q)
  const [status, setStatus] = useState('all')
  const [priority, setPriority] = useState('all')
  const [pushEnabled, setPushEnabled] = useState(false)
  const knownIds = useRef(new Set<string>())
  const seededKnownIds = useRef(false)

  const critical = useMemo(
    () => rows.find(n => n.priority === 'CRITICAL' && !n.recipient?.acknowledgedAt),
    [rows],
  )

  const load = useCallback(async (summary = !open) => {
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return
    const params = new URLSearchParams({ business_id: businessId, status, priority })
    if (summary) params.set('summary', '1')
    if (deferredQ.trim() && !summary) params.set('q', deferredQ.trim())
    const res = await fetch(`/api/notifications?${params.toString()}`, summary ? undefined : { cache: 'no-store' })
    const json = await res.json().catch(() => ({}))
    if (!res.ok) return
    const next = (json.notifications ?? []) as NotificationRow[]
    const fresh = seededKnownIds.current ? next.filter(n => !knownIds.current.has(n.id)) : []
    next.forEach(n => knownIds.current.add(n.id))
    seededKnownIds.current = true
    const loud = fresh.find(n => n.priority === 'HIGH' || n.priority === 'CRITICAL')
    if (loud && !document.hidden) {
      playTone()
      vibrate(loud.priority)
    }
    if (!summary) setRows(next)
    setUnread(json.unread ?? 0)
    setCriticalUnacked(json.criticalUnacked ?? 0)
    window.dispatchEvent(
      new CustomEvent('alma:notifications-updated', {
        detail: { unread: json.unread ?? 0, criticalUnacked: json.criticalUnacked ?? 0 },
      }),
    )
  }, [businessId, deferredQ, open, priority, status])

  const openPanel = useCallback(() => {
    setOpen(true)
    void load()
  }, [load])

  useEffect(() => {
    void load()
    const timer = window.setInterval(() => {
      if (!document.hidden) void load(!open)
    }, open ? 45_000 : 60_000)
    return () => window.clearInterval(timer)
  }, [load, open])

  useRegisterMobileRefresh(
    useCallback(async () => {
      await load(true)
      if (open) await load(false)
    }, [load, open]),
  )

  useEffect(() => {
    function openFromMobileNav() {
      openPanel()
    }
    window.addEventListener('alma-open-notifications', openFromMobileNav)
    return () => window.removeEventListener('alma-open-notifications', openFromMobileNav)
  }, [openPanel])

  useEffect(() => {
    if (!critical) return
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    if (reduceMotion) return
    const timer = window.setInterval(() => {
      if (!document.hidden) vibrate('CRITICAL')
    }, 4000)
    return () => window.clearInterval(timer)
  }, [critical])

  useEffect(() => {
    setPushEnabled(localStorage.getItem('alma_push_enabled') === '1')
    function onEnabled() {
      setPushEnabled(true)
    }
    window.addEventListener('alma-push-enabled', onEnabled)
    return () => window.removeEventListener('alma-push-enabled', onEnabled)
  }, [])

  const enablePush = useCallback(() => {
    window.dispatchEvent(new Event('alma-enable-push'))
  }, [])

  async function act(id: string, action: 'read' | 'unread' | 'ack' | 'pin' | 'unpin') {
    await patchNotification(id, action)
    await load()
  }

  const shellValue = useMemo(
    () => ({ unread, criticalUnacked, openPanel }),
    [criticalUnacked, openPanel, unread],
  )

  return (
    <NotificationShellContext.Provider value={shellValue}>
      {children}

      <AnimatePresence>
        {open && (
          <>
            <motion.button
              type="button"
              aria-label="Close notifications"
              className="fixed inset-0 bg-black/60 backdrop-blur-sm"
              style={{ zIndex: PLATFORM_Z.notificationPanel - 10 }}
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setOpen(false)}
            />
            <motion.aside
              initial={{ x: 420, opacity: 0 }}
              animate={{ x: 0, opacity: 1 }}
              exit={{ x: 420, opacity: 0 }}
              transition={{ duration: 0.18 }}
              className="fixed right-0 top-0 h-[100dvh] w-full max-w-md border-l border-gold-dim/30 bg-[#08080b] shadow-2xl shadow-black"
              style={{ zIndex: PLATFORM_Z.notificationPanel }}
            >
              <div className="border-b border-border p-4">
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-base font-bold text-cream">Notification Center</p>
                    <p className="text-[11px] text-zinc-500">
                      {unread} unread · {criticalUnacked} critical need acknowledgment
                    </p>
                  </div>
                  <div className="flex shrink-0 flex-wrap gap-2">
                    {!pushEnabled && process.env.NEXT_PUBLIC_ONESIGNAL_APP_ID && (
                      <Button size="xs" variant="gold" onClick={() => void enablePush()}>
                        Enable push
                      </Button>
                    )}
                    <Button size="xs" variant="secondary" onClick={() => setOpen(false)}>
                      Close
                    </Button>
                  </div>
                </div>
                <div className="mt-4 grid grid-cols-3 gap-2">
                  <Input
                    value={q}
                    onChange={e => setQ(e.target.value)}
                    placeholder="Search alerts"
                    className="col-span-3 py-2 text-xs"
                  />
                  <Select
                    value={status}
                    onChange={setStatus}
                    options={[
                      { label: 'All', value: 'all' },
                      { label: 'Unread', value: 'unread' },
                      { label: 'Needs ack', value: 'needs_ack' },
                      { label: 'Acknowledged', value: 'ack' },
                    ]}
                    className="col-span-2 text-xs"
                  />
                  <Select
                    value={priority}
                    onChange={setPriority}
                    options={[
                      { label: 'Any priority', value: 'all' },
                      { label: 'Low', value: 'LOW' },
                      { label: 'Normal', value: 'NORMAL' },
                      { label: 'High', value: 'HIGH' },
                      { label: 'Critical', value: 'CRITICAL' },
                    ]}
                    className="text-xs"
                  />
                </div>
              </div>
              <div className="h-[calc(100dvh-150px)] overflow-y-auto p-3 space-y-2">
                {!rows.length ? (
                  <p className="p-6 text-center text-xs text-zinc-600">No notifications found.</p>
                ) : (
                  rows.map(n => (
                    <div
                      key={n.id}
                      className={cn(
                        'rounded-2xl border p-3',
                        priorityClass[n.priority],
                        !n.recipient?.readAt && 'ring-1 ring-gold-dim/40',
                      )}
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <p className="truncate text-sm font-bold text-cream">
                            {n.pinned ? 'Pinned · ' : ''}
                            {n.title}
                          </p>
                          <p className="mt-1 text-xs leading-relaxed text-zinc-400">{n.message}</p>
                        </div>
                        <span className="shrink-0 rounded-full border border-current px-2 py-0.5 text-[9px] font-black">
                          {n.priority}
                        </span>
                      </div>
                      <div className="mt-3 flex flex-wrap items-center gap-2 text-[10px] text-zinc-500">
                        <span>{new Date(n.createdAt).toLocaleString()}</span>
                        <span>{n.businessId || 'All businesses'}</span>
                        <span>{n.recipient?.deliveryStatus || 'DELIVERED'}</span>
                        {n.recipient?.pushStatus && <span>Push {n.recipient.pushStatus}</span>}
                      </div>
                      <div className="mt-3 flex flex-wrap gap-2">
                        {n.actionUrl && (
                          <a
                            href={n.actionUrl}
                            className="shrink-0 rounded-xl border border-border px-2.5 py-1.5 text-[11px] font-semibold text-gold-lt"
                          >
                            Open
                          </a>
                        )}
                        <Button
                          size="xs"
                          variant="secondary"
                          onClick={() => void act(n.id, n.recipient?.readAt ? 'unread' : 'read')}
                        >
                          {n.recipient?.readAt ? 'Unread' : 'Read'}
                        </Button>
                        <Button
                          size="xs"
                          variant={n.recipient?.acknowledgedAt ? 'secondary' : 'gold'}
                          onClick={() => void act(n.id, 'ack')}
                        >
                          {n.recipient?.acknowledgedAt ? 'Acknowledged' : 'Acknowledge'}
                        </Button>
                        <Button size="xs" variant="ghost" onClick={() => void act(n.id, n.pinned ? 'unpin' : 'pin')}>
                          {n.pinned ? 'Unpin' : 'Pin'}
                        </Button>
                      </div>
                    </div>
                  ))
                )}
              </div>
            </motion.aside>
          </>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {critical && (
          <motion.div
            className="fixed inset-0 flex items-center justify-center bg-red-950/80 p-4 backdrop-blur-md"
            style={{ zIndex: PLATFORM_Z.loadingOverlay - 20 }}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
          >
            <motion.div
              initial={{ scale: 0.96 }}
              animate={{ scale: 1 }}
              exit={{ scale: 0.96 }}
              className="w-full max-w-lg rounded-3xl border border-red-300/50 bg-[#120508] p-6 shadow-2xl shadow-red-950/60"
            >
              <p className="text-[10px] font-black uppercase tracking-[0.18em] text-red-300">Critical alert</p>
              <h2 className="mt-2 text-2xl font-black text-cream">{critical.title}</h2>
              <p className="mt-3 text-sm leading-relaxed text-red-100/80">{critical.message}</p>
              <div className="mt-5 flex flex-wrap gap-2">
                {critical.actionUrl && (
                  <a
                    href={critical.actionUrl}
                    className="rounded-xl border border-red-300/40 bg-red-500/15 px-4 py-2 text-sm font-bold text-red-100"
                  >
                    Open action
                  </a>
                )}
                <Button variant="gold" onClick={() => void act(critical.id, 'ack')}>
                  Acknowledge and stop alert
                </Button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </NotificationShellContext.Provider>
  )
}
