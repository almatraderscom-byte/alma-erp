'use client'

import { motion } from 'framer-motion'
import DemoDashHeader from '../_demo/DemoDashHeader'
import {
  DEMO_COST_STATS,
  DEMO_DAILY_COSTS,
  DEMO_MODEL_USAGE,
} from '../_demo/mock-data'

export default function CostsPage() {
  const maxCost = Math.max(...DEMO_DAILY_COSTS.map((d) => d.cost))
  const weekTotal = DEMO_DAILY_COSTS.reduce((a, b) => a + b.cost, 0)

  return (
    <div className="min-h-[100dvh] pb-16">
      <DemoDashHeader title="খরচ ড্যাশবোর্ড" subtitle="টোকেন ব্যবহার ও AI খরচের বিশ্লেষণ" />

      <main className="mx-auto max-w-5xl px-4 py-6 md:px-6">
        {/* Stat cards */}
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          {DEMO_COST_STATS.map((s, i) => (
            <motion.div
              key={s.label}
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: i * 0.05, duration: 0.4 }}
              className="rounded-2xl border border-black/[0.06] bg-white/80 p-4 shadow-sm backdrop-blur-sm"
            >
              <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-[#E07A5F]/[0.08] text-base">{s.icon}</span>
              <p className="mt-3 text-2xl font-bold text-[#1a1a2e]">{s.value}</p>
              <p className="mt-0.5 text-[12px] font-medium text-gray-600">{s.label}</p>
              <p className="mt-0.5 text-[10px] text-gray-400">{s.sub}</p>
            </motion.div>
          ))}
        </div>

        <div className="mt-6 grid grid-cols-1 gap-5 lg:grid-cols-5">
          {/* Daily cost chart */}
          <section className="lg:col-span-3">
            <div className="rounded-2xl border border-black/[0.06] bg-white/80 p-5 shadow-sm backdrop-blur-sm">
              <div className="mb-5 flex items-center justify-between">
                <h2 className="text-[14px] font-bold text-[#1a1a2e]">সাপ্তাহিক খরচ</h2>
                <span className="text-[12px] text-gray-500">মোট <span className="font-semibold text-[#E07A5F]">${weekTotal.toFixed(2)}</span></span>
              </div>
              <div className="flex h-44 items-end justify-between gap-2">
                {DEMO_DAILY_COSTS.map((d, i) => (
                  <div key={d.day} className="flex flex-1 flex-col items-center gap-2">
                    <div className="relative flex w-full flex-1 items-end justify-center">
                      <motion.div
                        initial={{ height: 0 }}
                        animate={{ height: `${(d.cost / maxCost) * 100}%` }}
                        transition={{ delay: 0.2 + i * 0.06, duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
                        className="group relative w-full max-w-[34px] rounded-t-lg bg-gradient-to-t from-[#E07A5F] to-[#E8B4A0]"
                      >
                        <span className="absolute -top-5 left-1/2 -translate-x-1/2 whitespace-nowrap text-[10px] font-semibold text-gray-500 opacity-0 transition-opacity group-hover:opacity-100">
                          ${d.cost.toFixed(1)}
                        </span>
                      </motion.div>
                    </div>
                    <span className="text-[11px] text-gray-500">{d.day}</span>
                  </div>
                ))}
              </div>
            </div>
          </section>

          {/* Model usage */}
          <section className="lg:col-span-2">
            <div className="rounded-2xl border border-black/[0.06] bg-white/80 p-5 shadow-sm backdrop-blur-sm">
              <h2 className="mb-4 text-[14px] font-bold text-[#1a1a2e]">মডেল অনুযায়ী ব্যবহার</h2>
              <div className="space-y-4">
                {DEMO_MODEL_USAGE.map((m, i) => (
                  <div key={m.model}>
                    <div className="mb-1.5 flex items-center justify-between text-[12px]">
                      <span className="flex items-center gap-1.5 font-medium text-[#334155]">
                        <span className="h-2.5 w-2.5 rounded-full" style={{ background: m.tone }} />
                        {m.model}
                      </span>
                      <span className="text-gray-500">{m.cost}</span>
                    </div>
                    <div className="h-2 overflow-hidden rounded-full bg-gray-100">
                      <motion.div
                        initial={{ width: 0 }}
                        animate={{ width: `${m.share}%` }}
                        transition={{ delay: 0.3 + i * 0.1, duration: 0.6, ease: [0.22, 1, 0.36, 1] }}
                        className="h-full rounded-full"
                        style={{ background: m.tone }}
                      />
                    </div>
                    <p className="mt-1 text-[10px] text-gray-400">{m.share}% মোট খরচের</p>
                  </div>
                ))}
              </div>
            </div>

            <div className="mt-4 rounded-2xl border border-[#E07A5F]/15 bg-[#E07A5F]/[0.05] p-4">
              <p className="text-[12px] font-semibold text-[#c45a42]">💡 অপটিমাইজেশন টিপ</p>
              <p className="mt-1 text-[11px] leading-relaxed text-[#8a5040]">
                সহজ প্রশ্নগুলো Haiku-তে রাউট করলে মাসে আনুমানিক <span className="font-semibold">$8–12</span> সাশ্রয় হতে পারে।
              </p>
            </div>
          </section>
        </div>
      </main>
    </div>
  )
}
