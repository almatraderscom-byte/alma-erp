'use client'

import { AnimatePresence, motion, useReducedMotion } from 'framer-motion'
import { useCallback, useEffect, useRef, useState } from 'react'
import { cn } from '@/lib/utils'
import type {
  ContextBreakdownItem,
  UsageIntelligenceSnapshot,
} from '@/agent/lib/usage-intelligence'

type AgentUsagePopoverProps = {
  conversationId: string | null
  modelId: string
  streaming: boolean
}

function compactNumber(value: number | null): string {
  if (value == null || !Number.isFinite(value)) return '—'
  return Intl.NumberFormat('en-US', {
    notation: value >= 10_000 ? 'compact' : 'standard',
    maximumFractionDigits: value >= 1_000_000 ? 2 : value >= 1_000 ? 1 : 0,
  }).format(value)
}

function usd(value: number | null, digits = 2): string {
  if (value == null || !Number.isFinite(value)) return '—'
  return `$${value.toFixed(digits)}`
}

function percent(value: number | null): string {
  return value == null ? '—' : `${Math.round(value)}%`
}

function RelativeSync({ value }: { value: string | null }) {
  if (!value) return <span>sync pending</span>
  const seconds = Math.max(0, Math.round((Date.now() - new Date(value).getTime()) / 1000))
  if (seconds < 10) return <span>just synced</span>
  if (seconds < 60) return <span>{seconds}s ago</span>
  return <span>{Math.round(seconds / 60)}m ago</span>
}

function LiveRail({
  value,
  color,
  muted = false,
}: {
  value: number
  color: string
  muted?: boolean
}) {
  const reduceMotion = useReducedMotion()
  const width = `${Math.max(1.5, Math.min(100, value))}%`
  return (
    <div className="relative h-[10px] overflow-hidden rounded-[4px] border border-white/[0.05] bg-black/25">
      <div
        className="absolute inset-0 opacity-40"
        style={{
          backgroundImage:
            'linear-gradient(rgba(255,255,255,.06) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,.06) 1px, transparent 1px)',
          backgroundSize: '5px 5px',
        }}
      />
      <motion.div
        className="absolute inset-y-0 left-0 overflow-hidden rounded-[3px]"
        initial={false}
        animate={{ width }}
        transition={reduceMotion ? { duration: 0 } : { type: 'spring', stiffness: 75, damping: 18 }}
        style={{
          background: `linear-gradient(90deg, ${color}35, ${color}92 78%, ${color})`,
          boxShadow: muted ? 'none' : `0 0 18px ${color}45`,
        }}
      >
        <motion.div
          className="absolute inset-0 opacity-70"
          animate={reduceMotion ? undefined : { backgroundPositionX: ['0px', '12px'] }}
          transition={{ repeat: Infinity, duration: 0.8, ease: 'linear' }}
          style={{
            backgroundImage:
              'linear-gradient(rgba(255,255,255,.16) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,.17) 1px, transparent 1px)',
            backgroundSize: '6px 6px',
          }}
        />
      </motion.div>
      {!muted && (
        <motion.span
          className="absolute top-1/2 h-3 w-3 -translate-y-1/2 rounded-[4px] border border-white/55"
          animate={{
            left: `calc(${width} - 6px)`,
            boxShadow: reduceMotion
              ? `0 0 8px ${color}`
              : [`0 0 5px ${color}`, `0 0 15px ${color}`, `0 0 5px ${color}`],
          }}
          transition={{
            left: reduceMotion ? { duration: 0 } : { type: 'spring', stiffness: 75, damping: 18 },
            boxShadow: { repeat: Infinity, duration: 1.45, ease: 'easeInOut' },
          }}
          style={{ backgroundColor: color }}
        />
      )}
    </div>
  )
}

function ContextRing({ value }: { value: number }) {
  const reduceMotion = useReducedMotion()
  const radius = 23
  const circumference = 2 * Math.PI * radius
  const dash = circumference * (Math.max(0, Math.min(100, value)) / 100)
  return (
    <div className="relative h-[58px] w-[58px] shrink-0">
      <svg viewBox="0 0 58 58" className="-rotate-90">
        <circle cx="29" cy="29" r={radius} fill="none" stroke="rgba(255,255,255,.07)" strokeWidth="5" />
        <motion.circle
          cx="29"
          cy="29"
          r={radius}
          fill="none"
          stroke="url(#contextGradient)"
          strokeLinecap="round"
          strokeWidth="5"
          initial={false}
          animate={{ strokeDasharray: `${dash} ${circumference}` }}
          transition={reduceMotion ? { duration: 0 } : { type: 'spring', stiffness: 65, damping: 18 }}
          style={{ filter: 'drop-shadow(0 0 5px rgba(155,138,251,.55))' }}
        />
        <defs>
          <linearGradient id="contextGradient">
            <stop stopColor="#57C7FF" />
            <stop offset="1" stopColor="#B69CFF" />
          </linearGradient>
        </defs>
      </svg>
      <span className="absolute inset-0 flex items-center justify-center text-[11px] font-semibold tabular-nums text-white">
        {Math.round(value)}%
      </span>
    </div>
  )
}

function BreakdownRow({ item }: { item: ContextBreakdownItem }) {
  return (
    <div className="grid grid-cols-[10px_1fr_auto_auto] items-center gap-2 py-[3px] text-[11px]">
      <span className="h-2 w-2 rounded-[2px]" style={{ backgroundColor: item.color }} />
      <span className={item.id === 'free' ? 'text-white/42' : 'text-white/70'}>{item.label}</span>
      <span className="text-right font-medium tabular-nums text-white/68">{compactNumber(item.tokens)}</span>
      <span className="w-9 text-right tabular-nums text-white/38">{item.percentage.toFixed(1)}%</span>
    </div>
  )
}

function LoadingCard() {
  return (
    <div className="space-y-3 p-4">
      {[90, 58, 72, 64].map((width, index) => (
        <motion.div
          key={width}
          className="h-11 rounded-xl bg-white/[0.045]"
          animate={{ opacity: [0.35, 0.75, 0.35] }}
          transition={{ repeat: Infinity, delay: index * 0.08, duration: 1.3 }}
          style={{ width: `${width}%` }}
        />
      ))}
    </div>
  )
}

export default function AgentUsagePopover({
  conversationId,
  modelId,
  streaming,
}: AgentUsagePopoverProps) {
  const [open, setOpen] = useState(false)
  const [contextOpen, setContextOpen] = useState(false)
  const [snapshot, setSnapshot] = useState<UsageIntelligenceSnapshot | null>(null)
  const [error, setError] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const abortRef = useRef<AbortController | null>(null)
  const previousStreaming = useRef(streaming)
  const reduceMotion = useReducedMotion()

  const refresh = useCallback(async () => {
    abortRef.current?.abort()
    const controller = new AbortController()
    abortRef.current = controller
    const params = new URLSearchParams({ modelId })
    if (conversationId) params.set('conversationId', conversationId)
    try {
      const response = await fetch(`/api/assistant/usage?${params.toString()}`, {
        cache: 'no-store',
        signal: controller.signal,
      })
      if (!response.ok) throw new Error(`usage_${response.status}`)
      setSnapshot(await response.json() as UsageIntelligenceSnapshot)
      setError(false)
    } catch (fetchError) {
      if ((fetchError as Error).name !== 'AbortError') setError(true)
    }
  }, [conversationId, modelId])

  useEffect(() => {
    void refresh()
    return () => abortRef.current?.abort()
  }, [refresh])

  useEffect(() => {
    if (!open) return
    const interval = window.setInterval(() => {
      if (document.visibilityState === 'visible') void refresh()
    }, 15_000)
    return () => window.clearInterval(interval)
  }, [open, refresh])

  useEffect(() => {
    const justFinished = previousStreaming.current && !streaming
    previousStreaming.current = streaming
    if (!justFinished) return
    const timeout = window.setTimeout(() => void refresh(), 900)
    return () => window.clearTimeout(timeout)
  }, [streaming, refresh])

  useEffect(() => {
    function handlePointer(event: MouseEvent) {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handlePointer)
    return () => document.removeEventListener('mousedown', handlePointer)
  }, [])

  const contextPercent = snapshot?.context.percentage ?? 0
  const activeColor = contextPercent > 85 ? '#F07F8D' : contextPercent > 65 ? '#F6B85A' : '#9B8AFB'
  const weeklyTop = snapshot?.weekly.models.slice(0, 4) ?? []

  return (
    <div ref={rootRef} className="relative shrink-0">
      <button
        type="button"
        onClick={() => {
          setOpen((value) => !value)
          if (!open) void refresh()
        }}
        aria-label="Usage intelligence"
        aria-expanded={open}
        className={cn(
          'group flex h-8 items-center gap-1.5 rounded-full border px-2.5 text-[11px] font-medium transition-all active:scale-95',
          open
            ? 'border-[#9B8AFB]/40 bg-[#9B8AFB]/12 text-white shadow-[0_0_18px_rgba(155,138,251,.13)]'
            : 'border-border text-muted hover:border-[#9B8AFB]/30 hover:bg-[#9B8AFB]/8 hover:text-cream',
        )}
      >
        <span className="relative h-3.5 w-3.5 rounded-full border border-current/35">
          <motion.span
            className="absolute inset-[2px] rounded-full"
            animate={reduceMotion ? undefined : { opacity: [0.45, 1, 0.45] }}
            transition={{ repeat: Infinity, duration: 1.8 }}
            style={{ backgroundColor: error ? '#F07F8D' : activeColor }}
          />
        </span>
        <span className="tabular-nums">{snapshot?.context.usedTokens != null ? percent(contextPercent) : 'Usage'}</span>
      </button>

      <AnimatePresence>
        {open && (
          <motion.div
            initial={reduceMotion ? { opacity: 0 } : { opacity: 0, y: 10, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={reduceMotion ? { opacity: 0 } : { opacity: 0, y: 8, scale: 0.98 }}
            transition={reduceMotion ? { duration: 0 } : { type: 'spring', stiffness: 360, damping: 29 }}
            className="fixed bottom-[88px] left-3 right-3 z-[80] overflow-hidden rounded-[22px] border border-white/[0.09] bg-[#11131A]/[0.97] text-white shadow-[0_24px_80px_rgba(0,0,0,.62),0_0_0_1px_rgba(155,138,251,.03)] backdrop-blur-2xl sm:absolute sm:bottom-full sm:left-0 sm:right-auto sm:mb-2 sm:w-[410px]"
          >
            <div
              className="pointer-events-none absolute inset-0 opacity-60"
              style={{
                background:
                  'radial-gradient(circle at 12% -8%, rgba(87,199,255,.13), transparent 32%), radial-gradient(circle at 92% 4%, rgba(155,138,251,.16), transparent 35%)',
              }}
            />

            <div className="relative flex items-center justify-between border-b border-white/[0.065] px-4 py-3">
              <div>
                <div className="flex items-center gap-2">
                  <span className="text-[13px] font-semibold tracking-[-0.01em]">Usage intelligence</span>
                  <span className="flex items-center gap-1 rounded-full bg-[#62D9A7]/10 px-1.5 py-0.5 text-[8px] font-bold uppercase tracking-[0.13em] text-[#76E4B8]">
                    <motion.i
                      className="h-1.5 w-1.5 rounded-full bg-[#62D9A7]"
                      animate={reduceMotion ? undefined : { opacity: [0.35, 1, 0.35] }}
                      transition={{ repeat: Infinity, duration: 1.15 }}
                    />
                    Live
                  </span>
                </div>
                <div className="mt-0.5 flex items-center gap-1.5 text-[9px] text-white/35">
                  <span>USD only</span>
                  <span>·</span>
                  <RelativeSync value={snapshot?.checkedAt ?? null} />
                </div>
              </div>
              <button
                type="button"
                onClick={() => void refresh()}
                aria-label="Refresh usage"
                className="flex h-8 w-8 items-center justify-center rounded-full border border-white/[0.07] text-white/45 transition hover:bg-white/[0.05] hover:text-white"
              >
                <motion.svg
                  animate={streaming && !reduceMotion ? { rotate: 360 } : { rotate: 0 }}
                  transition={{ repeat: Infinity, duration: 1.2, ease: 'linear' }}
                  width="14"
                  height="14"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  strokeLinecap="round"
                >
                  <path d="M20 11a8 8 0 10-2.3 5.7M20 4v7h-7" />
                </motion.svg>
              </button>
            </div>

            {!snapshot && !error && <LoadingCard />}

            {error && !snapshot && (
              <div className="relative p-5 text-center">
                <p className="text-[12px] text-white/60">Live usage sync করা যায়নি।</p>
                <button type="button" onClick={() => void refresh()} className="mt-2 text-[11px] font-medium text-[#B69CFF]">
                  আবার চেষ্টা করুন
                </button>
              </div>
            )}

            {snapshot && (
              <div className="relative max-h-[min(650px,calc(100vh-125px))] overflow-y-auto p-2.5">
                <section className="overflow-hidden rounded-2xl border border-white/[0.065] bg-white/[0.025]">
                  <button
                    type="button"
                    className="w-full p-3.5 text-left"
                    onClick={() => setContextOpen((value) => !value)}
                    aria-expanded={contextOpen}
                  >
                    <div className="flex items-center gap-3">
                      <ContextRing value={snapshot.context.percentage} />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center justify-between gap-2">
                          <div>
                            <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-white/38">Context window</p>
                            <p className="mt-1 truncate text-[13px] font-semibold text-white/88">{snapshot.model.label}</p>
                          </div>
                          <div className="flex items-center gap-2 text-right">
                            <div>
                              <p className="text-[12px] font-semibold tabular-nums">
                                {compactNumber(snapshot.context.usedTokens)}
                                <span className="font-normal text-white/32"> / {compactNumber(snapshot.model.contextWindow)}</span>
                              </p>
                              <p className={cn('mt-0.5 text-[8px] font-semibold uppercase tracking-[0.1em]', snapshot.context.exact ? 'text-[#62D9A7]' : 'text-[#F6B85A]')}>
                                {snapshot.context.exact ? 'Provider measured' : snapshot.context.source === 'awaiting_provider' ? 'Next turn will measure' : 'Historical estimate'}
                              </p>
                            </div>
                            <motion.svg
                              animate={{ rotate: contextOpen ? 180 : 0 }}
                              width="13"
                              height="13"
                              viewBox="0 0 24 24"
                              fill="none"
                              stroke="currentColor"
                              strokeWidth="2"
                              className="text-white/30"
                            >
                              <path d="M6 9l6 6 6-6" />
                            </motion.svg>
                          </div>
                        </div>
                        <div className="mt-2.5">
                          <LiveRail value={snapshot.context.percentage} color={activeColor} />
                        </div>
                      </div>
                    </div>
                  </button>

                  <AnimatePresence initial={false}>
                    {contextOpen && (
                      <motion.div
                        initial={{ height: 0, opacity: 0 }}
                        animate={{ height: 'auto', opacity: 1 }}
                        exit={{ height: 0, opacity: 0 }}
                        className="overflow-hidden"
                      >
                        <div className="border-t border-white/[0.055] px-3.5 pb-3 pt-2.5">
                          {snapshot.context.breakdown.map((item) => <BreakdownRow key={item.id} item={item} />)}
                          <p className="mt-2 rounded-lg bg-white/[0.028] px-2.5 py-2 text-[9px] leading-relaxed text-white/35">
                            Total provider-measured; category split token-estimated ও exact total-এর সঙ্গে reconciled।
                          </p>
                        </div>
                      </motion.div>
                    )}
                  </AnimatePresence>
                </section>

                <section className="mt-2.5 rounded-2xl border border-white/[0.065] bg-white/[0.025] p-3.5">
                  <div className="flex items-end justify-between gap-3">
                    <div>
                      <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-white/38">Daily budget</p>
                      <p className="mt-1 text-[16px] font-semibold tracking-[-0.02em] tabular-nums">
                        {usd(snapshot.daily.spentUsd)}
                        <span className="ml-1.5 text-[10px] font-normal text-white/32">
                          {snapshot.daily.budgetUsd ? `/ ${usd(snapshot.daily.budgetUsd)}` : '· no ceiling set'}
                        </span>
                      </p>
                    </div>
                    <span className="rounded-full bg-[#57C7FF]/9 px-2 py-1 text-[9px] font-semibold text-[#7ED6FF]">
                      {snapshot.daily.percentage == null ? 'Live spend' : `${percent(snapshot.daily.percentage)} used`}
                    </span>
                  </div>
                  <div className="mt-3">
                    <LiveRail value={snapshot.daily.percentage ?? Math.min(100, snapshot.daily.spentUsd > 0 ? 9 : 1)} color="#57C7FF" />
                  </div>
                </section>

                <section className="mt-2.5 rounded-2xl border border-white/[0.065] bg-white/[0.025] p-3.5">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-white/38">Weekly model cost</p>
                      <p className="mt-1 text-[16px] font-semibold tracking-[-0.02em] tabular-nums">{usd(snapshot.weekly.spentUsd)}</p>
                      <p className="mt-0.5 text-[9px] text-white/30">{snapshot.weekly.startDate} → {snapshot.weekly.endDate}</p>
                    </div>
                    <div className="flex -space-x-1">
                      {weeklyTop.map((item) => (
                        <span
                          key={item.modelId}
                          title={`${item.label}: ${percent(item.percentage)}`}
                          className="flex h-7 w-7 items-center justify-center rounded-full border-2 border-[#15171F] text-[8px] font-bold text-[#11131A]"
                          style={{ backgroundColor: item.color }}
                        >
                          {Math.round(item.percentage)}
                        </span>
                      ))}
                    </div>
                  </div>
                  <div className="mt-3 flex h-2 overflow-hidden rounded-full bg-black/25">
                    {snapshot.weekly.models.map((item) => (
                      <motion.span
                        key={item.modelId}
                        initial={{ width: 0 }}
                        animate={{ width: `${item.percentage}%` }}
                        transition={reduceMotion ? { duration: 0 } : { type: 'spring', stiffness: 65, damping: 18 }}
                        style={{ backgroundColor: item.color, boxShadow: `0 0 10px ${item.color}3c` }}
                      />
                    ))}
                  </div>
                  <div className="mt-2.5 grid grid-cols-2 gap-x-3 gap-y-1.5">
                    {weeklyTop.map((item) => (
                      <div key={item.modelId} className="flex min-w-0 items-center gap-1.5 text-[9px]">
                        <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ backgroundColor: item.color }} />
                        <span className="min-w-0 flex-1 truncate text-white/45">{item.label}</span>
                        <span className="tabular-nums text-white/68">{percent(item.percentage)}</span>
                      </div>
                    ))}
                    {weeklyTop.length === 0 && <span className="col-span-2 text-[10px] text-white/32">এই সপ্তাহে model spend নেই।</span>}
                  </div>
                </section>

                <section className="relative mt-2.5 overflow-hidden rounded-2xl border border-[#9B8AFB]/15 bg-[#9B8AFB]/[0.045] p-3.5">
                  <motion.div
                    className="pointer-events-none absolute -right-12 -top-14 h-32 w-32 rounded-full bg-[#9B8AFB]/10 blur-2xl"
                    animate={reduceMotion ? undefined : { scale: [0.8, 1.12, 0.8], opacity: [0.35, 0.75, 0.35] }}
                    transition={{ repeat: Infinity, duration: 4.2 }}
                  />
                  <div className="relative flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-white/38">Selected model API balance</p>
                      <p className="mt-1 truncate text-[12px] font-semibold text-white/82">
                        {snapshot.wallet.providerLabel ?? snapshot.model.label}
                      </p>
                    </div>
                    <div className="text-right">
                      <p className="text-[17px] font-semibold tracking-[-0.02em] tabular-nums">
                        {usd(snapshot.wallet.balanceUsd)}
                      </p>
                      <p className={cn('text-[8px] font-semibold uppercase tracking-[0.1em]', snapshot.wallet.authoritative ? 'text-[#62D9A7]' : 'text-white/30')}>
                        {snapshot.wallet.authoritative ? 'Live wallet' : snapshot.wallet.status}
                      </p>
                    </div>
                  </div>
                  <div className="relative mt-3 rounded-xl border border-white/[0.055] bg-black/15 px-3 py-2.5">
                    <div className="flex items-center justify-between gap-3">
                      <span className="text-[10px] text-white/38">Equivalent token runway</span>
                      <span className="text-[13px] font-semibold tabular-nums text-[#C8B9FF]">
                        {snapshot.wallet.estimatedTokens != null
                          ? `≈ ${compactNumber(snapshot.wallet.estimatedTokens)}`
                          : snapshot.wallet.estimatedTokenMin != null && snapshot.wallet.estimatedTokenMax != null
                            ? `${compactNumber(snapshot.wallet.estimatedTokenMin)}–${compactNumber(snapshot.wallet.estimatedTokenMax)}`
                            : '—'}
                      </span>
                    </div>
                    <div className="mt-2">
                      <LiveRail
                        value={snapshot.wallet.balanceUsd != null ? Math.max(8, Math.min(92, Math.log10(snapshot.wallet.balanceUsd + 1) * 36)) : 1}
                        color="#B69CFF"
                        muted={snapshot.wallet.balanceUsd == null}
                      />
                    </div>
                  </div>
                  <p className="relative mt-2 text-[9px] leading-relaxed text-white/32">{snapshot.wallet.note}</p>
                </section>
              </div>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}
