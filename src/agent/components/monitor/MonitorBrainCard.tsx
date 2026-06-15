'use client'

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

const fadeIn = { hidden: { opacity: 0, y: 8 }, show: { opacity: 1, y: 0, transition: { duration: 0.3 } } }

function fmtTime(iso: string) {
  return new Date(iso).toLocaleTimeString('en-GB', { timeZone: 'Asia/Dhaka', hour: '2-digit', minute: '2-digit' })
}

function NeuralNode({ label, value, color, delay = 0 }: {
  label: string; value: string | number; color: string; delay?: number
}) {
  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.8 }}
      animate={{ opacity: 1, scale: 1 }}
      transition={{ duration: 0.4, delay }}
      className="group relative rounded-xl border border-white/[0.04] bg-white/[0.01] px-3 py-2.5 transition-all hover:border-white/[0.08] hover:bg-white/[0.03] hover:shadow-[0_0_20px_rgba(168,85,247,0.06)]"
    >
      <div className="absolute -top-1 -right-1 h-2 w-2 rounded-full bg-purple-400/20 opacity-0 group-hover:opacity-100 transition-opacity" />
      <p className="text-[9px] font-bold uppercase tracking-wider text-white/25">{label}</p>
      <p className={cn('mt-0.5 text-lg font-black tabular-nums', color)}>{value}</p>
    </motion.div>
  )
}

export function MonitorBrainCard({ stats }: { stats: BrainStats | null }) {
  return (
    <motion.div variants={fadeIn} initial="hidden" animate="show">
      <div className="rounded-2xl border border-purple-500/20 bg-white/[0.02] backdrop-blur-xl overflow-hidden shadow-[0_0_24px_rgba(168,85,247,0.04)]">
        <div className="flex items-center gap-2 border-b border-white/[0.04] px-4 py-2.5">
          <span className="text-sm">🧠</span>
          <h3 className="text-[11px] font-bold uppercase tracking-[0.08em] text-white/50">এজেন্ট ব্রেইন</h3>
          <div className="ml-auto flex items-center gap-1">
            <span className="inline-block h-1.5 w-1.5 rounded-full bg-purple-400 shadow-[0_0_6px_rgba(168,85,247,0.6)] animate-pulse" />
            <span className="text-[9px] text-purple-300/50">Neural Active</span>
          </div>
        </div>
        <div className="p-3">
          {!stats ? (
            <div className="flex items-center justify-center py-4">
              <span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-purple-400/30 border-t-purple-400" />
              <span className="ml-2 text-[10px] text-white/20">Loading brain stats…</span>
            </div>
          ) : (
            <div className="space-y-3">
              <div className="grid grid-cols-3 gap-2">
                <NeuralNode label="Memories" value={stats.memoryCount} color="text-purple-300" delay={0} />
                <NeuralNode label="Active Rules" value={stats.activePlaybookCount} color="text-emerald-300" delay={0.05} />
                <NeuralNode label="Knowledge" value={stats.knowledgeCount} color="text-blue-300" delay={0.1} />
              </div>

              <div className="grid grid-cols-2 gap-2">
                <div className="rounded-lg border border-white/[0.04] bg-white/[0.01] px-2.5 py-2">
                  <p className="text-[9px] font-bold uppercase tracking-wider text-white/20">Last Session</p>
                  <p className="mt-0.5 text-[11px] tabular-nums text-white/40">
                    {stats.lastSessionSummary ? fmtTime(stats.lastSessionSummary) : '—'}
                  </p>
                </div>
                <div className="rounded-lg border border-white/[0.04] bg-white/[0.01] px-2.5 py-2">
                  <p className="text-[9px] font-bold uppercase tracking-wider text-white/20">Knowledge Build</p>
                  <p className="mt-0.5 text-[11px] tabular-nums text-white/40">
                    {stats.lastKnowledgeBuild ? fmtTime(stats.lastKnowledgeBuild) : '—'}
                  </p>
                </div>
              </div>

              {stats.proposedPlaybookCount > 0 && (
                <motion.div
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  className="flex items-center gap-2 rounded-xl border border-amber-500/20 bg-amber-500/[0.04] px-3 py-2"
                >
                  <span className="text-base animate-pulse">💡</span>
                  <div>
                    <p className="text-[11px] font-semibold text-amber-200/80">
                      {stats.proposedPlaybookCount} proposed rule{stats.proposedPlaybookCount > 1 ? 's' : ''}
                    </p>
                    <p className="text-[9px] text-amber-300/40">awaiting approval</p>
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
