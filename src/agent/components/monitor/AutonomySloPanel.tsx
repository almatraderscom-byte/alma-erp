'use client'

/**
 * Phase 58 — SLO dashboard panel: per-task-class reliability, verified
 * completion, unknown effects, compensation success, and the global
 * zero-invariants (duplicates / unapproved high-impact). Honest by design:
 * insufficient volume shows as "যথেষ্ট ডেটা নেই", never as green.
 */
import { useEffect, useState } from 'react'

type SloValue = number | 'insufficient_data'

interface TaskClassSlo {
  taskClass: string
  labelBn: string
  tier: string
  stage: string
  samples: number
  successRate: SloValue
  verifiedCompletionRate: SloValue
  unknownEffects: number
  compensationSuccessRate: SloValue
  totalCostUsd: number
}

interface SloView {
  effects: {
    outbox: { due: number; leased: number }
    slo?: {
      at: string
      windowHours: number
      classes: TaskClassSlo[]
      global: {
        totalEffects: number
        duplicateExternalEffects: number
        unapprovedHighImpactEffects: number
        unknownEffects: number
        guardCoverage: number
      }
    }
    breaches?: Array<{ taskClass: string; metric: string; detailBn: string }>
  } | null
}

function pct(v: SloValue): string {
  return v === 'insufficient_data' ? 'যথেষ্ট ডেটা নেই' : `${(v * 100).toFixed(1)}%`
}

function pctClass(v: SloValue, target: number): string {
  if (v === 'insufficient_data') return 'text-neutral-400'
  return v >= target ? 'text-emerald-300' : 'text-rose-300'
}

export default function AutonomySloPanel() {
  const [view, setView] = useState<SloView | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    void fetch('/api/assistant/controls?section=slo')
      .then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`)
        setView((await r.json()) as SloView)
      })
      .catch((err) => setError(err instanceof Error ? err.message : String(err)))
  }, [])

  const slo = view?.effects?.slo
  const breaches = view?.effects?.breaches ?? []

  return (
    <div className="safe-x mx-auto w-full max-w-5xl px-4 pt-4 md:px-6">
      <div className="alma-frost overflow-hidden rounded-[18px] p-4">
        <div className="flex items-center gap-2">
          <span className="text-[15px]">📏</span>
          <h2 className="text-[15px] font-bold text-cream">স্বয়ংক্রিয়তার মান (SLO)</h2>
          {slo && <span className="ml-auto text-[10px] text-muted">গত {Math.round(slo.windowHours / 24)} দিন</span>}
        </div>

        {error && <p className="mt-2 text-[12px] text-rose-300">তথ্য আনা যায়নি: {error}</p>}
        {!error && !view && <p className="mt-2 text-[12px] text-muted">লোড হচ্ছে…</p>}

        {slo && (
          <>
            {/* Global zero-invariants */}
            <div className="mt-3 grid grid-cols-2 gap-2 md:grid-cols-4">
              <Invariant label="ডুপ্লিকেট effect" value={slo.global.duplicateExternalEffects} mustBeZero />
              <Invariant label="অনুমোদনহীন বড় কাজ" value={slo.global.unapprovedHighImpactEffects} mustBeZero />
              <Invariant label="অজানা অবস্থার effect" value={slo.global.unknownEffects} mustBeZero={false} />
              <Invariant label="গার্ড কাভারেজ" value={`${(slo.global.guardCoverage * 100).toFixed(0)}%`} mustBeZero={false} good={slo.global.guardCoverage === 1} />
            </div>

            {breaches.length > 0 && (
              <div className="mt-3 rounded-lg border border-rose-500/40 bg-rose-500/10 p-2 text-[12px] text-rose-200">
                {breaches.map((b, i) => (
                  <div key={i}>🛑 {b.detailBn}</div>
                ))}
                <div className="mt-1 text-[10px] text-rose-300/80">লঙ্ঘন হলে শ্রেণিটা নিজে থেকেই এক ধাপ নেমে যায়।</div>
              </div>
            )}

            {/* Per-class table */}
            <div className="mt-3 overflow-x-auto">
              <table className="w-full text-left text-[11px]">
                <thead className="text-muted">
                  <tr>
                    <th className="py-1 pr-2">শ্রেণি</th>
                    <th className="py-1 pr-2">ধাপ</th>
                    <th className="py-1 pr-2">নমুনা</th>
                    <th className="py-1 pr-2">নির্ভরযোগ্যতা (লক্ষ্য ৯৯%)</th>
                    <th className="py-1 pr-2">প্রমাণসহ সমাপ্তি</th>
                    <th className="py-1 pr-2">undo সফলতা</th>
                    <th className="py-1">খরচ</th>
                  </tr>
                </thead>
                <tbody className="text-neutral-200">
                  {slo.classes.filter((c) => c.samples > 0 || c.stage !== 'off').map((c) => (
                    <tr key={c.taskClass} className="border-t border-white/5">
                      <td className="py-1.5 pr-2">{c.labelBn} <span className="text-muted">({c.tier})</span></td>
                      <td className="py-1.5 pr-2">{c.stage}</td>
                      <td className="py-1.5 pr-2">{c.samples}</td>
                      <td className={`py-1.5 pr-2 ${pctClass(c.successRate, 0.99)}`}>{pct(c.successRate)}</td>
                      <td className={`py-1.5 pr-2 ${pctClass(c.verifiedCompletionRate, 0.99)}`}>{pct(c.verifiedCompletionRate)}</td>
                      <td className={`py-1.5 pr-2 ${pctClass(c.compensationSuccessRate, 0.99)}`}>{pct(c.compensationSuccessRate)}</td>
                      <td className="py-1.5">${c.totalCostUsd.toFixed(2)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {slo.classes.every((c) => c.samples === 0) && (
                <p className="mt-2 text-[11px] text-muted">এখনো কোনো effect রেকর্ড হয়নি — engine চালু হলে এখানে শ্রেণি-ধরে মান দেখা যাবে।</p>
              )}
            </div>

            {view?.effects?.outbox && (
              <p className="mt-2 text-[10px] text-muted">
                Outbox: due {view.effects.outbox.due} · চলমান {view.effects.outbox.leased} · জরুরি থামাতে: AGENT_ENABLED=false (সবকিছুর সামনে)
              </p>
            )}
          </>
        )}
      </div>
    </div>
  )
}

function Invariant({ label, value, mustBeZero, good }: { label: string; value: number | string; mustBeZero: boolean; good?: boolean }) {
  const isGood = good ?? (mustBeZero ? value === 0 : true)
  return (
    <div className={`rounded-lg border p-2 ${isGood ? 'border-emerald-500/30 bg-emerald-500/5' : 'border-rose-500/40 bg-rose-500/10'}`}>
      <div className="text-[10px] text-muted">{label}</div>
      <div className={`text-[15px] font-bold ${isGood ? 'text-emerald-300' : 'text-rose-300'}`}>{value}</div>
    </div>
  )
}
