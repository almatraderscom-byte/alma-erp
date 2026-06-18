'use client'

import { useEffect, useState } from 'react'
import { motion } from 'framer-motion'
import { cn } from '@/lib/utils'

export type BrainStats = {
  memoryCount: number
  activePlaybookCount: number
  proposedPlaybookCount: number
  knowledgeCount: number
  lastKnowledgeBuild: string | null
  lastSessionSummary: string | null
  todayCostUsd: number
}

/** Mirrors GET /api/assistant/costs/summary → promptCache */
type PromptCacheMonitorSnapshot = {
  dhakaDate: string
  tokensSaved: number
  usdSaved: number
  cacheReadTokens: number
  cacheCreationTokens: number
  inputTokens: number
  outputTokens: number
  chatTurns: number
  cacheHitRatio: number
  cachingBroken: boolean
}

const fadeIn = { hidden: { opacity: 0, y: 8 }, show: { opacity: 1, y: 0, transition: { duration: 0.3 } } }

function fmtTime(iso: string) {
  return new Date(iso).toLocaleTimeString('en-GB', { timeZone: 'Asia/Dhaka', hour: '2-digit', minute: '2-digit' })
}

function fmtTokens(n: number) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`
  return String(Math.round(n))
}

function NeuralNode({ label, value, color, delay = 0 }: {
  label: string; value: string | number; color: string; delay?: number
}) {
  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.8 }}
      animate={{ opacity: 1, scale: 1 }}
      transition={{ duration: 0.4, delay }}
      className="group relative rounded-xl border border-border-subtle bg-transparent px-3 py-2.5 transition-all hover:border-white/[0.12] hover:bg-card/80 hover:shadow-sm"
    >
      <div className="absolute -top-1 -right-1 h-2 w-2 rounded-full bg-[#E07A5F]/20 opacity-0 group-hover:opacity-100 transition-opacity" />
      <p className="text-[9px] font-bold uppercase tracking-wider text-muted">{label}</p>
      <p className={cn('mt-0.5 text-lg font-black tabular-nums', color)}>{value}</p>
    </motion.div>
  )
}

function PromptCacheLine({ cache }: { cache: PromptCacheMonitorSnapshot | null }) {
  if (!cache) {
    return (
      <p className="text-[10px] text-muted tabular-nums">💾 ক্যাশ ডেটা লোড হচ্ছে…</p>
    )
  }

  if (cache.cachingBroken) {
    return (
      <div className="rounded-xl border border-amber-300/60 bg-amber-50 px-3 py-2 space-y-1">
        <p className="text-[11px] font-semibold text-amber-800">⚠️ caching হিট করছে না</p>
        <p className="text-[10px] text-amber-700/90 tabular-nums">
          আজ {cache.chatTurns} টার্ন · cache read {fmtTokens(cache.cacheReadTokens)} · hit {(cache.cacheHitRatio * 100).toFixed(0)}%
        </p>
      </div>
    )
  }

  return (
    <div className="rounded-xl border border-[#81B29A]/25 bg-[#81B29A]/[0.06] px-3 py-2">
      <p className="text-[11px] font-medium text-[#3d5c4a] tabular-nums">
        💾 ক্যাশ থেকে বাঁচানো: {fmtTokens(cache.tokensSaved)} টোকেন · ~${cache.usdSaved.toFixed(2)} আজ
      </p>
      <p className="mt-0.5 text-[9px] text-muted tabular-nums">
        hit {(cache.cacheHitRatio * 100).toFixed(0)}% · read {fmtTokens(cache.cacheReadTokens)} · fresh {fmtTokens(cache.inputTokens)} · {cache.chatTurns} turns
      </p>
    </div>
  )
}

export function MonitorBrainCard({ stats }: { stats: BrainStats | null }) {
  const [promptCache, setPromptCache] = useState<PromptCacheMonitorSnapshot | null>(null)

  useEffect(() => {
    let alive = true
    async function load() {
      try {
        const res = await fetch('/api/assistant/costs/summary', { cache: 'no-store' })
        if (!res.ok) return
        const data = await res.json() as { promptCache?: PromptCacheMonitorSnapshot }
        if (alive && data.promptCache) setPromptCache(data.promptCache)
      } catch {
        /* ignore */
      }
    }
    void load()
    const t = setInterval(load, 30_000)
    return () => { alive = false; clearInterval(t) }
  }, [])

  return (
    <motion.div variants={fadeIn} initial="hidden" animate="show">
      <div className="rounded-2xl border border-[#E07A5F]/20 bg-card/80 overflow-hidden shadow-sm">
        <div className="flex items-center gap-2 border-b border-border-subtle px-4 py-2.5">
          <span className="text-sm">🧠</span>
          <h3 className="text-[11px] font-bold uppercase tracking-[0.08em] text-muted">এজেন্ট ব্রেইন</h3>
          <div className="ml-auto flex items-center gap-1">
            <span className="inline-block h-1.5 w-1.5 rounded-full bg-[#E07A5F] shadow-[0_0_6px_rgba(224,122,95,0.6)] animate-pulse" />
            <span className="text-[9px] text-[#E07A5F]/60">Neural Active</span>
          </div>
        </div>
        <div className="p-3">
          {!stats ? (
            <div className="flex items-center justify-center py-4">
              <span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-[#E07A5F]/30 border-t-[#E07A5F]" />
              <span className="ml-2 text-[10px] text-muted">Loading brain stats…</span>
            </div>
          ) : (
            <div className="space-y-3">
              <PromptCacheLine cache={promptCache} />

              <div className="grid grid-cols-3 gap-2">
                <NeuralNode label="Memories" value={stats.memoryCount} color="text-[#E07A5F]" delay={0} />
                <NeuralNode label="Active Rules" value={stats.activePlaybookCount} color="text-[#81B29A]" delay={0.05} />
                <NeuralNode label="Knowledge" value={stats.knowledgeCount} color="text-[#D4A84B]" delay={0.1} />
              </div>

              <div className="grid grid-cols-2 gap-2">
                <div className="rounded-lg border border-border-subtle bg-transparent px-2.5 py-2">
                  <p className="text-[9px] font-bold uppercase tracking-wider text-muted">Last Session</p>
                  <p className="mt-0.5 text-[11px] tabular-nums text-muted">
                    {stats.lastSessionSummary ? fmtTime(stats.lastSessionSummary) : '—'}
                  </p>
                </div>
                <div className="rounded-lg border border-border-subtle bg-transparent px-2.5 py-2">
                  <p className="text-[9px] font-bold uppercase tracking-wider text-muted">Knowledge Build</p>
                  <p className="mt-0.5 text-[11px] tabular-nums text-muted">
                    {stats.lastKnowledgeBuild ? fmtTime(stats.lastKnowledgeBuild) : '—'}
                  </p>
                </div>
              </div>

              {stats.proposedPlaybookCount > 0 && (
                <motion.div
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  className="flex items-center gap-2 rounded-xl border border-[#D4A84B]/20 bg-[#D4A84B]/[0.06] px-3 py-2"
                >
                  <span className="text-base animate-pulse">💡</span>
                  <div>
                    <p className="text-[11px] font-semibold text-[#D4A84B]">
                      {stats.proposedPlaybookCount} proposed rule{stats.proposedPlaybookCount > 1 ? 's' : ''}
                    </p>
                    <p className="text-[9px] text-[#D4A84B]/60">awaiting approval</p>
                  </div>
                </motion.div>
              )}
            </div>
          )}
        </div>
      </div>
    </motion.div>
  )
}
