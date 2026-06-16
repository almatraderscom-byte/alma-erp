'use client'

import { useCallback, useEffect, useState } from 'react'
import { motion } from 'framer-motion'
import { cn } from '@/lib/utils'

/* ───────── Types ───────── */

interface RoutingConfig {
  opusEnabled: boolean
  opusDailyCap: number
  opusConfidenceThreshold: number
  opusCriticalTaka: number
  criticalModelId: string
}

interface ModelOption {
  id: string
  label: string
  provider: string
  inPerM: number
  outPerM: number
}

interface AgentToday {
  provider: string
  emoji: string
  label: string
  role: string
  calls: number
  costUsd: number
}

interface ModelToday {
  modelId: string
  label: string
  conversations: number
}

interface SpecialistToday {
  role: string
  label: string
  displayName: string
  icon: string
  calls: number
  costUsd: number
  inputTokens: number
  outputTokens: number
}

interface SpecialistDelegation {
  role: string
  displayName: string
  icon: string
  taskSnippet: string
  costUsd: number
  inputTokens: number
  outputTokens: number
  at: string
}

interface RoutingResponse {
  config: RoutingConfig
  defaults: RoutingConfig
  criticalModelOptions: ModelOption[]
  headModel: ModelOption
  opusUsedToday: number
  opusRemainingToday: number
  agentsToday: AgentToday[]
  modelsToday: ModelToday[]
  specialistsToday: SpecialistToday[]
  specialistDelegationsToday: SpecialistDelegation[]
  headTokensToday: { inputTokens: number; outputTokens: number }
  todayDhakaDate: string
}

const SPECIALIST_ICON: Record<string, string> = {
  researcher: '🔎',
  analyst: '📊',
  marketer: '📣',
  content: '✍️',
  ops: '🗂️',
}

/* ───────── Helpers ───────── */

const ACCENT = '#E07A5F'

function fmtUsd(n: number): string {
  if (n === 0) return '$0'
  if (n < 0.01) return '<$0.01'
  return `$${n.toFixed(2)}`
}

/* ───────── Component ───────── */

export function MonitorAgentsPanel({
  onToast,
}: {
  onToast: (msg: string, type: 'ok' | 'err') => void
}) {
  const [data, setData] = useState<RoutingResponse | null>(null)
  const [draft, setDraft] = useState<RoutingConfig | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/assistant/model-routing', { cache: 'no-store' })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const json = (await res.json()) as RoutingResponse
      setData(json)
      setDraft((prev) => prev ?? json.config)
      setErr(null)
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'load failed')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
    const t = setInterval(() => void load(), 30_000)
    return () => clearInterval(t)
  }, [load])

  const dirty =
    !!data &&
    !!draft &&
    (draft.opusEnabled !== data.config.opusEnabled ||
      draft.opusDailyCap !== data.config.opusDailyCap ||
      draft.opusConfidenceThreshold !== data.config.opusConfidenceThreshold ||
      draft.opusCriticalTaka !== data.config.opusCriticalTaka ||
      draft.criticalModelId !== data.config.criticalModelId)

  async function save() {
    if (!draft) return
    setSaving(true)
    try {
      const res = await fetch('/api/assistant/model-routing', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(draft),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const json = (await res.json()) as { config: RoutingConfig }
      setData((d) => (d ? { ...d, config: json.config } : d))
      setDraft(json.config)
      onToast('✓ মডেল সেটিংস সেভ হয়েছে', 'ok')
    } catch (e) {
      onToast(e instanceof Error ? e.message : 'সেভ ব্যর্থ', 'err')
    } finally {
      setSaving(false)
    }
  }

  if (loading && !data) {
    return (
      <div className="flex items-center justify-center gap-2 py-10 text-sm text-[#94a3b8]">
        <span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-[#E07A5F]/30 border-t-[#E07A5F]" />
        Loading agents…
      </div>
    )
  }

  if (err && !data) {
    return (
      <div className="rounded-2xl border border-red-500/20 bg-red-50 px-4 py-6 text-center text-sm text-red-700">
        লোড করা যায়নি: {err}
      </div>
    )
  }

  if (!data || !draft) return null

  const capPct = data.config.opusDailyCap > 0 ? Math.min(100, (data.opusUsedToday / data.config.opusDailyCap) * 100) : 0

  return (
    <div className="space-y-3">
      {/* ── Model Control Dial ── */}
      <div className="overflow-hidden rounded-2xl border border-[#E07A5F]/20 bg-white shadow-sm">
        <div className="flex items-center gap-2 border-b border-black/[0.06] px-4 py-3">
          <span className="text-base">🎛️</span>
          <h3 className="text-xs font-bold uppercase tracking-[0.08em] text-[#64748b]">Model Control</h3>
          <span className="ml-auto rounded-full bg-[#E07A5F]/10 px-2 py-0.5 text-[9px] font-bold text-[#E07A5F]">
            আপনি নিয়ন্ত্রণ করেন
          </span>
        </div>

        <div className="space-y-4 p-4">
          <p className="text-[11px] leading-relaxed text-[#64748b]">
            হেড এজেন্ট ৯০% কাজ Sonnet দিয়ে করে। শুধু high-risk / বড় টাকার সিদ্ধান্তে দামি{' '}
            <strong className="text-[#1a1a2e]/80">Opus</strong> ব্যবহার হয় — নিচের ডায়াল দিয়ে আপনি ঠিক করেন কতটা।
          </p>

          {/* Opus master toggle */}
          <div className="flex items-center justify-between rounded-xl border border-black/[0.06] bg-[#FAF9F6] px-3.5 py-3">
            <div className="min-w-0">
              <p className="text-[13px] font-bold text-[#1a1a2e]/85">Opus এজেন্ট (Claude Opus 4.8)</p>
              <p className="mt-0.5 text-[10px] text-[#94a3b8]">
                বন্ধ থাকলে সব কাজ Sonnet-এ হবে — সবচেয়ে কম খরচ
              </p>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={draft.opusEnabled}
              onClick={() => setDraft({ ...draft, opusEnabled: !draft.opusEnabled })}
              className={cn(
                'relative ml-3 inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors',
                draft.opusEnabled ? 'bg-[#E07A5F]' : 'bg-zinc-300',
              )}
            >
              <span
                className={cn(
                  'inline-block h-5 w-5 transform rounded-full bg-white shadow transition-transform',
                  draft.opusEnabled ? 'translate-x-[22px]' : 'translate-x-0.5',
                )}
              />
            </button>
          </div>

          {/* The rest only matters when Opus is on */}
          <div className={cn('space-y-4 transition-opacity', !draft.opusEnabled && 'pointer-events-none opacity-40')}>
            {/* Premium model selector — owner picks cost vs power */}
            <div>
              <div className="mb-1.5 flex items-center justify-between">
                <label className="text-[12px] font-semibold text-[#1a1a2e]/75">কোন প্রিমিয়াম মডেল</label>
                <span className="text-[10px] text-[#94a3b8]">দাম: in/out · $ প্রতি 1M টোকেন</span>
              </div>
              <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
                {data.criticalModelOptions.map((m) => {
                  const active = draft.criticalModelId === m.id
                  return (
                    <button
                      key={m.id}
                      type="button"
                      onClick={() => setDraft({ ...draft, criticalModelId: m.id })}
                      className={cn(
                        'flex items-center justify-between rounded-xl border px-3 py-2 text-left transition-all',
                        active
                          ? 'border-[#E07A5F]/40 bg-[#E07A5F]/[0.08]'
                          : 'border-black/[0.08] bg-white hover:bg-black/[0.03]',
                      )}
                    >
                      <span className={cn('text-[12px] font-bold', active ? 'text-[#E07A5F]' : 'text-[#1a1a2e]/80')}>
                        {active ? '● ' : '○ '}
                        {m.label}
                      </span>
                      <span className="ml-2 shrink-0 text-[10px] font-semibold tabular-nums text-[#94a3b8]">
                        ${m.inPerM}/${m.outPerM}
                      </span>
                    </button>
                  )
                })}
              </div>
              <p className="mt-1 text-[10px] text-[#94a3b8]">
                হেড: {data.headModel.label} (${data.headModel.inPerM}/${data.headModel.outPerM}) — সস্তা, ৯০% কাজ এতেই
              </p>
            </div>

            {/* Daily cap stepper */}
            <div>
              <div className="mb-1.5 flex items-center justify-between">
                <label className="text-[12px] font-semibold text-[#1a1a2e]/75">দৈনিক Opus সীমা</label>
                <span className="text-[11px] text-[#94a3b8]">আজ ব্যবহার: {data.opusUsedToday}</span>
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setDraft({ ...draft, opusDailyCap: Math.max(0, draft.opusDailyCap - 1) })}
                  className="h-9 w-9 shrink-0 rounded-lg border border-black/[0.08] bg-white text-lg font-bold text-[#64748b] transition-colors hover:bg-black/[0.03]"
                >
                  −
                </button>
                <div className="flex h-9 flex-1 items-center justify-center rounded-lg border border-black/[0.08] bg-[#FAF9F6] text-[15px] font-black tabular-nums text-[#1a1a2e]/85">
                  {draft.opusDailyCap} <span className="ml-1 text-[10px] font-medium text-[#94a3b8]">কল/দিন</span>
                </div>
                <button
                  type="button"
                  onClick={() => setDraft({ ...draft, opusDailyCap: Math.min(100, draft.opusDailyCap + 1) })}
                  className="h-9 w-9 shrink-0 rounded-lg border border-black/[0.08] bg-white text-lg font-bold text-[#64748b] transition-colors hover:bg-black/[0.03]"
                >
                  +
                </button>
              </div>
              {/* usage bar */}
              <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-black/[0.06]">
                <div
                  className="h-full rounded-full bg-[#E07A5F] transition-all"
                  style={{ width: `${capPct}%` }}
                />
              </div>
            </div>

            {/* Confidence threshold slider */}
            <div>
              <div className="mb-1.5 flex items-center justify-between">
                <label className="text-[12px] font-semibold text-[#1a1a2e]/75">কখন Opus ডাকবে (confidence)</label>
                <span className="text-[11px] font-bold tabular-nums text-[#E07A5F]">
                  {Math.round(draft.opusConfidenceThreshold * 100)}%
                </span>
              </div>
              <input
                type="range"
                min={50}
                max={95}
                step={5}
                value={Math.round(draft.opusConfidenceThreshold * 100)}
                onChange={(e) => setDraft({ ...draft, opusConfidenceThreshold: Number(e.target.value) / 100 })}
                className="w-full accent-[#E07A5F]"
                style={{ accentColor: ACCENT }}
              />
              <p className="mt-1 text-[10px] text-[#94a3b8]">
                Sonnet-এর আত্মবিশ্বাস এর নিচে নামলে তবেই Opus হাত দেয়
              </p>
            </div>

            {/* Critical taka */}
            <div>
              <label className="mb-1.5 block text-[12px] font-semibold text-[#1a1a2e]/75">
                বড় টাকার সিদ্ধান্ত — সীমা
              </label>
              <div className="flex flex-wrap gap-1.5">
                {[5000, 10000, 20000, 50000].map((amt) => (
                  <button
                    key={amt}
                    type="button"
                    onClick={() => setDraft({ ...draft, opusCriticalTaka: amt })}
                    className={cn(
                      'rounded-lg border px-3 py-1.5 text-[11px] font-bold tabular-nums transition-all',
                      draft.opusCriticalTaka === amt
                        ? 'border-[#E07A5F]/40 bg-[#E07A5F]/[0.10] text-[#E07A5F]'
                        : 'border-black/[0.08] bg-white text-[#64748b] hover:bg-black/[0.03]',
                    )}
                  >
                    ৳{amt.toLocaleString('en-US')}
                  </button>
                ))}
              </div>
              <p className="mt-1 text-[10px] text-[#94a3b8]">এর সমান বা বেশি টাকার সিদ্ধান্তে সবসময় Opus</p>
            </div>
          </div>

          {/* Save bar */}
          <div className="flex items-center gap-2 pt-1">
            <button
              type="button"
              disabled={!dirty || saving}
              onClick={() => void save()}
              className={cn(
                'flex-1 rounded-xl px-4 py-2.5 text-[13px] font-bold transition-all',
                dirty && !saving
                  ? 'bg-[#E07A5F] text-white shadow-sm hover:bg-[#cf6a50]'
                  : 'bg-black/[0.06] text-[#94a3b8]',
              )}
            >
              {saving ? 'সেভ হচ্ছে…' : dirty ? '💾 সেভ করুন' : '✓ সেভ করা আছে'}
            </button>
            {dirty && !saving && (
              <button
                type="button"
                onClick={() => setDraft(data.config)}
                className="rounded-xl border border-black/[0.08] bg-white px-3 py-2.5 text-[12px] font-semibold text-[#94a3b8] hover:bg-black/[0.03]"
              >
                বাতিল
              </button>
            )}
          </div>
        </div>
      </div>

      {/* ── What each agent did today (CCTV) ── */}
      <div className="overflow-hidden rounded-2xl border border-black/[0.06] bg-white shadow-sm">
        <div className="flex items-center gap-2 border-b border-black/[0.06] px-4 py-3">
          <span className="text-base">🎥</span>
          <h3 className="text-xs font-bold uppercase tracking-[0.08em] text-[#64748b]">আজ কে কী করেছে</h3>
          <span className="ml-auto text-[10px] text-[#94a3b8]">{data.todayDhakaDate}</span>
        </div>

        <div className="p-3">
          {data.agentsToday.length === 0 ? (
            <p className="py-6 text-center text-[11px] text-[#94a3b8]">আজ এখনও কোনো এজেন্ট কাজ শুরু করেনি</p>
          ) : (
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              {data.agentsToday.map((a) => {
                const isHead = a.provider === 'anthropic'
                return (
                  <motion.div
                    key={a.provider}
                    initial={{ opacity: 0, y: 6 }}
                    animate={{ opacity: 1, y: 0 }}
                    className={cn(
                      'rounded-xl border p-3',
                      isHead ? 'border-[#E07A5F]/25 bg-[#E07A5F]/[0.04]' : 'border-black/[0.06] bg-[#FAF9F6]',
                    )}
                  >
                    <div className="flex items-start gap-2.5">
                      <span className="text-lg leading-none">{a.emoji}</span>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-1.5">
                          <p className="truncate text-[12px] font-bold text-[#1a1a2e]/85">{a.label}</p>
                          {isHead && (
                            <span className="rounded bg-[#E07A5F]/12 px-1.5 py-0.5 text-[8px] font-bold uppercase text-[#E07A5F]">
                              Head
                            </span>
                          )}
                        </div>
                        <p className="mt-0.5 text-[10px] leading-snug text-[#94a3b8]">{a.role}</p>
                      </div>
                    </div>
                    <div className="mt-2.5 flex items-center justify-between border-t border-black/[0.05] pt-2">
                      <span className="text-[11px] font-semibold tabular-nums text-[#64748b]">
                        {a.calls} কল
                      </span>
                      <span className="text-[11px] font-bold tabular-nums text-[#1a1a2e]/70">{fmtUsd(a.costUsd)}</span>
                    </div>

                    {/* Head agent: show which Claude variants + Opus usage */}
                    {isHead && (
                      <div className="mt-2 space-y-1.5">
                        {data.modelsToday.length > 0 && (
                          <div className="flex flex-wrap gap-1">
                            {data.modelsToday.map((m) => (
                              <span
                                key={m.modelId}
                                className="rounded-md border border-black/[0.06] bg-white px-1.5 py-0.5 text-[9px] font-medium text-[#64748b]"
                              >
                                {m.label} · {m.conversations}
                              </span>
                            ))}
                          </div>
                        )}
                        {(data.headTokensToday?.inputTokens > 0 || data.headTokensToday?.outputTokens > 0) && (
                          <p className="text-[10px] text-[#94a3b8]">
                            টোকেন: {(data.headTokensToday.inputTokens / 1000).toFixed(1)}k in ·{' '}
                            {(data.headTokensToday.outputTokens / 1000).toFixed(1)}k out
                            <span className="text-zinc-400"> — বড় system prompt + ERP tools = input বেশি</span>
                          </p>
                        )}
                        <div className="flex items-center gap-1.5 text-[10px] text-[#94a3b8]">
                          <span>⚡ Opus আজ:</span>
                          <span className="font-bold text-[#E07A5F]">
                            {data.opusUsedToday}/{data.config.opusDailyCap}
                          </span>
                          {!data.config.opusEnabled && <span className="text-zinc-400">(বন্ধ)</span>}
                        </div>
                      </div>
                    )}
                  </motion.div>
                )
              })}
            </div>
          )}

          {/* Specialist sub-agents the head delegated to today */}
          {data.specialistsToday && data.specialistsToday.length > 0 && (
            <div className="mt-3 rounded-xl border border-sky-200/60 bg-sky-50/50 p-3">
              <div className="mb-2 flex items-center gap-1.5">
                <span className="text-sm">🤝</span>
                <p className="text-[11px] font-bold uppercase tracking-[0.06em] text-sky-700/80">
                  সাব-এজেন্ট ডেলিগেশন
                </p>
              </div>
              <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
                {data.specialistsToday.map((s) => (
                  <div
                    key={s.role}
                    className="rounded-lg border border-sky-200/50 bg-white px-2.5 py-2"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="flex items-center gap-1.5 text-[11px] font-semibold text-[#1a1a2e]/80">
                        <span>{s.icon ?? SPECIALIST_ICON[s.role] ?? '🤝'}</span>
                        {s.displayName ?? s.label}
                      </span>
                      <span className="shrink-0 text-[10px] tabular-nums text-[#64748b]">
                        {s.calls} কল · {fmtUsd(s.costUsd)}
                      </span>
                    </div>
                    {(s.inputTokens > 0 || s.outputTokens > 0) && (
                      <p className="mt-1 text-[9px] text-[#94a3b8]">
                        {(s.inputTokens / 1000).toFixed(1)}k in · {(s.outputTokens / 1000).toFixed(1)}k out
                      </p>
                    )}
                  </div>
                ))}
              </div>

              {data.specialistDelegationsToday && data.specialistDelegationsToday.length > 0 && (
                <div className="mt-2.5 space-y-1.5 border-t border-sky-200/40 pt-2.5">
                  <p className="text-[10px] font-semibold text-sky-800/70">কোন এজেন্ট কী করেছে</p>
                  {data.specialistDelegationsToday.map((d, i) => (
                    <div
                      key={`${d.role}-${d.at}-${i}`}
                      className="rounded-lg border border-sky-100 bg-white/80 px-2.5 py-2"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-[10px] font-bold text-[#1a1a2e]/75">
                          {d.icon} {d.displayName}
                        </span>
                        <span className="text-[9px] tabular-nums text-[#94a3b8]">{fmtUsd(d.costUsd)}</span>
                      </div>
                      {d.taskSnippet ? (
                        <p className="mt-1 line-clamp-2 text-[10px] leading-snug text-[#64748b]">{d.taskSnippet}</p>
                      ) : null}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
