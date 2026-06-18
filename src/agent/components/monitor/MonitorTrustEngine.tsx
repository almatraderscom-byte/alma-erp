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
    auto: { icon: '⚡', label: 'Auto', color: 'border-[#81B29A]/30 bg-[#81B29A]/10 text-[#81B29A]' },
    notify: { icon: '📢', label: 'Notify', color: 'border-[#D4A84B]/30 bg-[#D4A84B]/10 text-[#D4A84B]' },
    approve: { icon: '🔒', label: 'Approve', color: 'border-[#E07A5F]/20 bg-[#E07A5F]/[0.08] text-[#E07A5F]' },
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
      <span className="font-bold text-[#E07A5F]">{count}</span>
    </span>
  )
}

export function MonitorTrustEngine({ rules, onUpdateTier }: {
  rules: TrustRule[]
  onUpdateTier: (ruleId: string, newTier: string) => void
}) {
  return (
    <motion.div variants={fadeIn} initial="hidden" animate="show">
      <div className="rounded-2xl border border-[#81B29A]/20 bg-card/60 backdrop-blur-2xl overflow-hidden shadow-sm">
        <div className="flex items-center gap-2 border-b border-border-subtle px-4 py-2.5">
          <span className="text-sm">🛡️</span>
          <h3 className="text-[11px] font-bold uppercase tracking-[0.08em] text-muted">ট্রাস্ট ইঞ্জিন</h3>
          {rules.length > 0 && (
            <span className="rounded-md bg-[#81B29A]/10 px-1.5 py-0.5 text-[9px] font-bold text-[#81B29A]">{rules.length} rules</span>
          )}
        </div>
        <div className="p-3">
          {rules.length === 0 ? (
            <p className="py-2 text-center text-[10px] text-muted">
              কোনো trust rule নেই — agent approve হতে থাকলে auto-promote হবে
            </p>
          ) : (
            <div className="space-y-2">
              {rules.map(rule => (
                <div key={rule.id} className="group rounded-xl border border-border-subtle bg-transparent p-3 transition-all hover:border-white/[0.12] hover:bg-card/60 backdrop-blur-2xl hover:shadow-sm">
                  <div className="flex items-center gap-2">
                    <div className="min-w-0 flex-1">
                      <p className="text-[11px] font-semibold text-cream/80">{rule.domain} / {rule.actionPattern}</p>
                      <div className="mt-1 flex items-center gap-3 text-[9px] text-muted">
                        <span className="flex items-center gap-1">
                          <span className="text-emerald-500">✅</span> {rule.approvalCount}
                        </span>
                        <span className="flex items-center gap-1">
                          <span className="text-red-500">❌</span> {rule.rejectionCount}
                        </span>
                        <StreakFire count={rule.consecutiveApprovals} />
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <TierBadge tier={rule.tier} />
                      <select
                        value={rule.tier}
                        onChange={(e) => onUpdateTier(rule.id, e.target.value)}
                        className="rounded-md border border-border bg-card/60 backdrop-blur-2xl px-1.5 py-0.5 text-[9px] font-bold text-muted cursor-pointer outline-none transition-colors hover:border-[#E07A5F]/30"
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
