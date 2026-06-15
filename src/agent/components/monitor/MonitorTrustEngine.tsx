'use client'

import { motion } from 'framer-motion'
import { cn } from '@/lib/utils'

export type TrustRule = {
  id: string
  domain: string
  actionPattern: string
  tier: string
  approvalCount: number
  rejectionCount: number
  consecutiveApprovals: number
}

const fadeIn = { hidden: { opacity: 0, y: 8 }, show: { opacity: 1, y: 0, transition: { duration: 0.3 } } }

function TierBadge({ tier }: { tier: string }) {
  const config = {
    auto: { icon: '⚡', label: 'Auto', color: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300' },
    notify: { icon: '📢', label: 'Notify', color: 'border-amber-500/30 bg-amber-500/10 text-amber-300' },
    approve: { icon: '🔒', label: 'Approve', color: 'border-red-500/20 bg-red-500/[0.05] text-red-300' },
  }
  const c = config[tier as keyof typeof config] ?? config.approve

  return (
    <span className={cn('inline-flex items-center gap-1 rounded-lg border px-2 py-0.5 text-[10px] font-bold', c.color)}>
      <span>{c.icon}</span>
      {c.label}
    </span>
  )
}

function StreakFire({ count }: { count: number }) {
  if (count < 3) return null
  return (
    <span className="inline-flex items-center gap-0.5 text-[10px]">
      <span className="animate-pulse">🔥</span>
      <span className="font-bold text-orange-300">{count}</span>
    </span>
  )
}

export function MonitorTrustEngine({ rules, onUpdateTier }: {
  rules: TrustRule[]
  onUpdateTier: (ruleId: string, newTier: string) => void
}) {
  return (
    <motion.div variants={fadeIn} initial="hidden" animate="show">
      <div className="rounded-2xl border border-blue-500/20 bg-white/[0.02] backdrop-blur-xl overflow-hidden shadow-[0_0_24px_rgba(59,130,246,0.04)]">
        <div className="flex items-center gap-2 border-b border-white/[0.04] px-4 py-2.5">
          <span className="text-sm">🛡️</span>
          <h3 className="text-[11px] font-bold uppercase tracking-[0.08em] text-white/50">ট্রাস্ট ইঞ্জিন</h3>
          {rules.length > 0 && (
            <span className="rounded-md bg-blue-500/10 px-1.5 py-0.5 text-[9px] font-bold text-blue-300">{rules.length} rules</span>
          )}
        </div>
        <div className="p-3">
          {rules.length === 0 ? (
            <p className="py-2 text-center text-[10px] text-white/30">
              কোনো trust rule নেই — agent approve হতে থাকলে auto-promote হবে
            </p>
          ) : (
            <div className="space-y-2">
              {rules.map(rule => (
                <div key={rule.id} className="group rounded-xl border border-white/[0.04] bg-white/[0.01] p-3 transition-all hover:border-white/[0.08] hover:bg-white/[0.02]">
                  <div className="flex items-center gap-2">
                    <div className="min-w-0 flex-1">
                      <p className="text-[11px] font-semibold text-white/60">{rule.domain} / {rule.actionPattern}</p>
                      <div className="mt-1 flex items-center gap-3 text-[9px] text-white/30">
                        <span className="flex items-center gap-1">
                          <span className="text-emerald-400">✅</span> {rule.approvalCount}
                        </span>
                        <span className="flex items-center gap-1">
                          <span className="text-red-400">❌</span> {rule.rejectionCount}
                        </span>
                        <StreakFire count={rule.consecutiveApprovals} />
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <TierBadge tier={rule.tier} />
                      <select
                        value={rule.tier}
                        onChange={(e) => onUpdateTier(rule.id, e.target.value)}
                        className="rounded-md border border-white/[0.08] bg-transparent px-1.5 py-0.5 text-[9px] font-bold text-white/40 cursor-pointer outline-none transition-colors hover:border-[#C9A84C]/30"
                      >
                        <option value="approve">🔒 Approve</option>
                        <option value="notify">📢 Notify</option>
                        <option value="auto">⚡ Auto</option>
                      </select>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </motion.div>
  )
}
