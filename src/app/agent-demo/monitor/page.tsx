'use client'

import { motion } from 'framer-motion'
import DemoDashHeader from '../_demo/DemoDashHeader'
import {
  DEMO_MONITOR_STATS,
  DEMO_STAFF,
  DEMO_ACTIVITY_FEED,
  type StaffActivity,
} from '../_demo/mock-data'

const STATUS_STYLE: Record<StaffActivity['status'], { dot: string; label: string; text: string }> = {
  active: { dot: 'bg-emerald-500', label: 'সক্রিয়', text: 'text-emerald-600' },
  idle: { dot: 'bg-amber-400', label: 'বিরতি', text: 'text-amber-600' },
  offline: { dot: 'bg-gray-300', label: 'অফলাইন', text: 'text-gray-400' },
}

const FEED_TONE: Record<string, string> = {
  success: 'bg-emerald-50 text-emerald-600 border-emerald-100',
  info: 'bg-sky-50 text-sky-600 border-sky-100',
  warning: 'bg-amber-50 text-amber-600 border-amber-100',
}

export default function MonitorPage() {
  return (
    <div className="min-h-[100dvh] pb-16">
      <DemoDashHeader title="LIVE Business Monitor" subtitle="রিয়েল-টাইম স্টাফ ও অপারেশন ওভারভিউ" />

      <main className="mx-auto max-w-5xl px-4 py-6 md:px-6">
        {/* Stat cards */}
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          {DEMO_MONITOR_STATS.map((s, i) => (
            <motion.div
              key={s.label}
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: i * 0.05, duration: 0.4 }}
              className="rounded-2xl border border-black/[0.06] bg-white/80 p-4 shadow-sm backdrop-blur-sm"
            >
              <div className="flex items-center justify-between">
                <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-[#E07A5F]/[0.08] text-base">{s.icon}</span>
                <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${s.positive ? 'bg-emerald-50 text-emerald-600' : 'bg-red-50 text-red-500'}`}>
                  {s.delta}
                </span>
              </div>
              <p className="mt-3 text-2xl font-bold text-[#1a1a2e]">{s.value}</p>
              <p className="mt-0.5 text-[12px] text-gray-500">{s.label}</p>
            </motion.div>
          ))}
        </div>

        <div className="mt-6 grid grid-cols-1 gap-5 lg:grid-cols-5">
          {/* Staff list */}
          <section className="lg:col-span-3">
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-[14px] font-bold text-[#1a1a2e]">স্টাফ কার্যক্রম</h2>
              <span className="flex items-center gap-1.5 text-[11px] text-gray-500">
                <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-500" /> লাইভ
              </span>
            </div>
            <div className="space-y-2">
              {DEMO_STAFF.map((st, i) => {
                const style = STATUS_STYLE[st.status]
                return (
                  <motion.div
                    key={st.id}
                    initial={{ opacity: 0, x: -12 }}
                    animate={{ opacity: 1, x: 0 }}
                    transition={{ delay: i * 0.05, duration: 0.35 }}
                    className="flex items-center gap-3 rounded-2xl border border-black/[0.06] bg-white/80 p-3 shadow-sm backdrop-blur-sm"
                  >
                    <div className="relative flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-[#F6E6DF] to-[#E8B4A0] text-sm font-bold text-[#c45a42]">
                      {st.name.charAt(0)}
                      <span className={`absolute -bottom-0.5 -right-0.5 h-3 w-3 rounded-full border-2 border-white ${style.dot}`} />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <p className="truncate text-[13px] font-semibold text-[#1a1a2e]">{st.name}</p>
                        <span className="rounded-md bg-gray-100 px-1.5 py-0.5 text-[10px] text-gray-500">{st.role}</span>
                      </div>
                      <p className="mt-0.5 truncate text-[12px] text-gray-500">{st.task}</p>
                    </div>
                    <div className="shrink-0 text-right">
                      <p className={`text-[11px] font-semibold ${style.text}`}>{style.label}</p>
                      <p className="mt-0.5 text-[10px] text-gray-400">{st.tasksToday} টাস্ক · {st.lastSeen}</p>
                    </div>
                  </motion.div>
                )
              })}
            </div>
          </section>

          {/* Activity feed */}
          <section className="lg:col-span-2">
            <h2 className="mb-3 text-[14px] font-bold text-[#1a1a2e]">সাম্প্রতিক কার্যক্রম</h2>
            <div className="rounded-2xl border border-black/[0.06] bg-white/80 p-2 shadow-sm backdrop-blur-sm">
              {DEMO_ACTIVITY_FEED.map((a, i) => (
                <motion.div
                  key={a.id}
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: 0.2 + i * 0.05, duration: 0.35 }}
                  className="flex items-start gap-3 rounded-xl px-2.5 py-2.5 transition-colors hover:bg-black/[0.02]"
                >
                  <span className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border text-sm ${FEED_TONE[a.tone]}`}>{a.icon}</span>
                  <div className="min-w-0 flex-1">
                    <p className="text-[12px] leading-snug text-[#334155]">{a.text}</p>
                    <p className="mt-0.5 text-[10px] text-gray-400">{a.time}</p>
                  </div>
                </motion.div>
              ))}
            </div>
          </section>
        </div>
      </main>
    </div>
  )
}
