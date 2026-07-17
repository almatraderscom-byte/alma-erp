'use client'

/**
 * Phase 57 — Autonomy Control Centre (the staged ladder, owner-facing).
 *
 * One card per task class showing its current rung with a plain-Bangla
 * example of what WILL and WILL NOT happen, promote (one rung, evidence-gated
 * server-side) / pause controls, and the service-connection panel
 * (inspect / pause / resume / revoke / delete data).
 *
 * There is deliberately no "সব চালু" button — the API doesn't have one either.
 */
import { useCallback, useEffect, useState } from 'react'
import toast from 'react-hot-toast'

type LadderStage = 'off' | 'shadow' | 'suggest' | 'draft' | 'auto_r1' | 'bounded_r2'

interface RolloutRow {
  taskClass: string
  labelBn: string
  stage: LadderStage
  tier: string
  ceiling: LadderStage
  approvedBy: string | null
  scope: { dailyCount: number; moneyCapTaka: number; canaryPct: number; expiresAt: string | null }
}

interface ServiceRow {
  service: string
  scope: string
  status: string
  readiness: string
  grantedOps: string[]
  live: boolean
}

interface RolloutView {
  rollouts: RolloutRow[]
  services: ServiceRow[]
  stageLabels: Record<LadderStage, string>
  stages: LadderStage[]
}

/** Plain-Bangla will/won't examples per rung (exit gate: the owner reads exactly what changes). */
const STAGE_EXAMPLES: Record<LadderStage, { will: string; wont: string }> = {
  off: { will: 'কিছুই না — এই শ্রেণির কাজ পুরো বন্ধ।', wont: 'পরামর্শও দেবে না।' },
  shadow: { will: 'ভেতরে ভেতরে লিখে রাখবে “আমি হলে এটা করতাম”।', wont: 'আপনাকে বিরক্তও করবে না, কোনো কাজও হবে না।' },
  suggest: { will: '“Boss, এটা করা যায়” বলে জানাবে।', wont: 'আপনার সায় ছাড়া এক পা-ও এগোবে না।' },
  draft: { will: 'কাজটা সাজিয়ে approval কার্ড দেবে (যেমন: মেসেজের খসড়া)।', wont: 'Approve না করা পর্যন্ত কিছুই পাঠাবে/বদলাবে না।' },
  auto_r1: { will: 'ছোট, ফেরানো-যোগ্য কাজ নিজে করে ফেলবে (যেমন: রিমাইন্ডার বসানো) — হিসাব থাকবে।', wont: 'টাকা খরচ, বাইরের মানুষকে মেসেজ, পাবলিক পোস্ট — কিছুই না।' },
  bounded_r2: { will: 'আপনার বেঁধে দেওয়া সীমার ভেতরে মাঝারি কাজও করবে (যেমন: pre-approved কনটেন্ট শিডিউল), আগে-পরে জানিয়ে।', wont: 'সীমার বাইরে গেলে বা undo না থাকলে থেমে জিজ্ঞেস করবে।' },
}

export default function AutonomyControlCenter() {
  const [view, setView] = useState<RolloutView | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/assistant/controls?section=autonomy_rollout')
      if (res.ok) setView((await res.json()) as RolloutView)
    } catch {
      /* view stays null */
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  async function act(body: Record<string, string>, okMsg: string) {
    if (busy) return
    setBusy(body.taskClass ?? body.service ?? 'x')
    try {
      const res = await fetch('/api/assistant/controls', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const data = (await res.json().catch(() => null)) as { blockers?: string[] } | null
      if (res.ok) {
        toast.success(okMsg)
      } else {
        toast.error(data?.blockers?.length ? `আটকে গেছে: ${data.blockers[0]}` : 'হয়নি — শর্ত পূরণ হয়নি')
      }
      await load()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'নেটওয়ার্ক সমস্যা')
    } finally {
      setBusy(null)
    }
  }

  if (loading) return <div className="p-4 text-sm text-neutral-400">লোড হচ্ছে…</div>
  if (!view) return <div className="p-4 text-sm text-neutral-400">স্বয়ংক্রিয়তার তথ্য আনা যায়নি।</div>

  return (
    <div className="space-y-4">
      <div className="rounded-xl border border-amber-500/30 bg-amber-500/5 p-3 text-xs text-amber-200">
        নিয়ম: প্রতিটা শ্রেণি আলাদাভাবে, এক ধাপ করে বাড়ে — প্রমাণ (shadow/canary ফলাফল) ছাড়া প্রমোশন হয় না।
        “সব একসাথে চালু” বলে কিছু নেই। বড় প্রভাবের (R3/R4) কাজ কখনোই স্বয়ংক্রিয় হয় না।
      </div>

      <div className="grid gap-3 md:grid-cols-2">
        {view.rollouts.map((r) => {
          const ex = STAGE_EXAMPLES[r.stage]
          const atCeiling = r.stage === r.ceiling
          return (
            <div key={r.taskClass} className="rounded-xl border border-neutral-700/60 bg-neutral-900/60 p-3">
              <div className="flex items-start justify-between gap-2">
                <div>
                  <div className="text-sm font-semibold text-neutral-100">{r.labelBn}</div>
                  <div className="mt-0.5 text-[11px] text-neutral-400">
                    শ্রেণি: {r.taskClass} · ঝুঁকি: {r.tier} · সর্বোচ্চ ধাপ: {view.stageLabels[r.ceiling]?.split(' — ')[0]}
                  </div>
                </div>
                <span className="shrink-0 rounded-full bg-neutral-800 px-2 py-0.5 text-[11px] text-neutral-200">
                  {view.stageLabels[r.stage]?.split(' — ')[0]}
                </span>
              </div>

              <div className="mt-2 space-y-1 text-[12px]">
                <div className="text-emerald-300/90">✓ যা হবে: {ex.will}</div>
                <div className="text-rose-300/90">✗ যা হবে না: {ex.wont}</div>
              </div>

              {(r.stage === 'auto_r1' || r.stage === 'bounded_r2') && (
                <div className="mt-2 text-[11px] text-neutral-400">
                  সীমা: দিনে {r.scope.dailyCount}টা · টাকা ৳{r.scope.moneyCapTaka} · canary {r.scope.canaryPct}%
                </div>
              )}

              <div className="mt-3 flex gap-2">
                <button
                  className="rounded-lg bg-emerald-600/20 px-3 py-1 text-xs text-emerald-300 disabled:opacity-40"
                  disabled={busy === r.taskClass || atCeiling}
                  onClick={() => void act({ action: 'promote', taskClass: r.taskClass, note: 'owner promoted from control centre' }, 'এক ধাপ বাড়ানো হলো')}
                >
                  {atCeiling ? 'সর্বোচ্চ ধাপে' : 'এক ধাপ বাড়াও'}
                </button>
                <button
                  className="rounded-lg bg-rose-600/20 px-3 py-1 text-xs text-rose-300 disabled:opacity-40"
                  disabled={busy === r.taskClass || r.stage === 'off'}
                  onClick={() => void act({ action: 'pause', taskClass: r.taskClass, note: 'owner paused' }, 'বন্ধ করা হলো — পরের কাজ থেকেই কার্যকর')}
                >
                  বন্ধ করো
                </button>
              </div>
            </div>
          )
        })}
      </div>

      {view.services.length > 0 && (
        <div className="rounded-xl border border-neutral-700/60 bg-neutral-900/60 p-3">
          <div className="mb-2 text-sm font-semibold text-neutral-100">সংযুক্ত সার্ভিস</div>
          <div className="space-y-2">
            {view.services.map((s) => (
              <div key={s.service} className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-neutral-800/50 px-3 py-2">
                <div className="text-xs text-neutral-200">
                  {s.service} <span className="text-neutral-400">({s.scope})</span>
                  <span className={`ml-2 rounded-full px-2 py-0.5 text-[10px] ${s.live ? 'bg-emerald-600/30 text-emerald-200' : 'bg-neutral-700 text-neutral-300'}`}>
                    {s.live ? 'চালু' : `${s.status} / ${s.readiness}`}
                  </span>
                  <div className="mt-0.5 text-[10px] text-neutral-500">অনুমতি: {s.grantedOps.join(', ') || '(কিছু না)'}</div>
                </div>
                <div className="flex gap-1.5">
                  {s.status === 'connected' && (
                    <button className="rounded bg-neutral-700 px-2 py-1 text-[11px]" disabled={busy === s.service}
                      onClick={() => void act({ action: 'service_pause', service: s.service }, 'সার্ভিস থামানো হলো')}>থামাও</button>
                  )}
                  {s.status === 'paused' && (
                    <button className="rounded bg-neutral-700 px-2 py-1 text-[11px]" disabled={busy === s.service}
                      onClick={() => void act({ action: 'service_resume', service: s.service }, 'সার্ভিস চালু হলো')}>চালু করো</button>
                  )}
                  <button className="rounded bg-rose-700/40 px-2 py-1 text-[11px] text-rose-200" disabled={busy === s.service}
                    onClick={() => void act({ action: 'service_revoke', service: s.service }, 'অ্যাক্সেস বাতিল')}>বাতিল</button>
                  <button className="rounded bg-rose-900/40 px-2 py-1 text-[11px] text-rose-300" disabled={busy === s.service}
                    onClick={() => void act({ action: 'service_delete_data', service: s.service }, 'জমা রাখা ডেটা মুছে দেওয়া হলো')}>ডেটা মুছো</button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
