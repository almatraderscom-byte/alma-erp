'use client'

import { useCallback, useEffect, useState } from 'react'
import {
  fetchStudioPerformance,
  type StudioPerformanceDashboard,
} from '@/agent/components/creative-studio/studio-api'

function healthTone(value: number, warn: number, danger: number) {
  if (value >= danger) return 'text-red-300'
  if (value >= warn) return 'text-amber-200'
  return 'text-[#a7d7bf]'
}

export function PerformanceView({
  brandProfileId,
  projectId,
  assetId,
}: {
  brandProfileId: string
  projectId?: string
  assetId?: string
}) {
  const [dashboard, setDashboard] = useState<StudioPerformanceDashboard | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      setDashboard(await fetchStudioPerformance({ brandProfileId, projectId, assetId }))
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Performance data লোড হয়নি।')
    } finally {
      setLoading(false)
    }
  }, [assetId, brandProfileId, projectId])

  useEffect(() => {
    void load()
  }, [load])

  return (
    <section className="mt-4 rounded-2xl border border-border-subtle bg-bg-1/70 p-3">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h4 className="text-[12px] font-bold text-cream">📈 ফলাফল ও attribution</h4>
          <p className="text-[11px] text-muted">Meta receipt → campaign pack → exact asset version → deterministic weight</p>
        </div>
        <button type="button" onClick={() => void load()} className="rounded-lg bg-white/10 px-2 py-1 text-[11px] font-semibold text-muted">
          রিফ্রেশ
        </button>
      </div>

      {loading ? (
        <div className="mt-3 grid grid-cols-3 gap-2">
          {Array.from({ length: 6 }).map((_, index) => <div key={index} className="h-12 animate-pulse rounded-lg bg-white/[0.05]" />)}
        </div>
      ) : error ? (
        <p role="alert" className="mt-3 rounded-lg bg-red-500/10 p-2 text-[11px] text-red-300">{error}</p>
      ) : dashboard ? (
        <>
          <div className="mt-3 grid grid-cols-3 gap-2">
            {[
              ['Reach', dashboard.totals.reach],
              ['Impression', dashboard.totals.impressions],
              ['Engagement', dashboard.totals.engagements],
              ['Click', dashboard.totals.clicks],
              ['Conversion', dashboard.totals.conversions],
              ['Receipt', dashboard.deliveries.length],
            ].map(([label, value]) => (
              <div key={String(label)} className="rounded-lg bg-card/70 p-2 text-center">
                <p className="text-[13px] font-extrabold text-cream">{Number(value).toLocaleString('bn-BD')}</p>
                <p className="text-[11px] text-muted">{label}</p>
              </div>
            ))}
          </div>

          <div className="mt-3 rounded-xl border border-border-subtle bg-card/60 p-2.5">
            <p className="text-[11px] font-bold text-cream">Operations signals</p>
            <div className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-[11px]">
              <span className="text-muted">Queue age</span>
              <span className={healthTone(dashboard.observability.queueAgeSec, 300, 900)}>
                {dashboard.observability.queueAgeSec}s
              </span>
              <span className="text-muted">Worker heartbeat</span>
              <span className={healthTone(dashboard.observability.workerHeartbeatAgeSec ?? 999_999, 180, 600)}>
                {dashboard.observability.workerHeartbeatAgeSec === null
                  ? 'unknown'
                  : `${dashboard.observability.workerHeartbeatAgeSec}s আগে`}
              </span>
              <span className="text-muted">Provider error (7d)</span>
              <span className={healthTone(dashboard.observability.providerErrorRatePct, 5, 15)}>
                {dashboard.observability.providerErrorRatePct}%
              </span>
              <span className="text-muted">Creative spend (7d)</span>
              <span className="text-cream">${dashboard.observability.spendUsd7d.toFixed(2)}</span>
              <span className="text-muted">QC pass (7d)</span>
              <span className="text-cream">
                {dashboard.observability.qcRatePct7d === null ? 'no sample' : `${dashboard.observability.qcRatePct7d}%`}
              </span>
              <span className="text-muted">Archive lag</span>
              <span className={healthTone(dashboard.observability.archiveLagHours, 24, 48)}>
                {dashboard.observability.archivePending} pending · {dashboard.observability.archiveLagHours}h
              </span>
              <span className="text-muted">Publish failures (7d)</span>
              <span className={healthTone(dashboard.observability.publishFailures7d, 1, 3)}>
                {dashboard.observability.publishFailures7d}
              </span>
            </div>
          </div>

          {dashboard.weights.length > 0 && (
            <div className="mt-3">
              <p className="text-[11px] font-bold text-cream">Deterministic recipe weights</p>
              <p className="mt-0.5 text-[11px] text-muted">শুধু measurable winner · ≥100 impressions · ≥10% margin · সপ্তাহে সর্বোচ্চ এক update</p>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {dashboard.weights.map((weight) => (
                  <span key={`${weight.recipeId}:${weight.sceneKey}`} className="rounded-full bg-[#81B29A]/10 px-2 py-1 text-[11px] text-[#a7d7bf]">
                    {weight.sceneKey} · {weight.weight} · n={weight.sampleCount}
                  </span>
                ))}
              </div>
            </div>
          )}

          <div className="mt-3 space-y-1.5">
            {dashboard.deliveries.map((delivery) => (
              <div key={delivery.id} className="rounded-lg border border-border-subtle bg-card/60 p-2">
                <div className="flex items-center justify-between gap-2 text-[11px]">
                  <span className="font-semibold text-cream">{delivery.platform} · {delivery.status}</span>
                  <span className="text-muted">{delivery.sceneKey}</span>
                </div>
                <p className="mt-1 truncate font-mono text-[11px] text-muted">
                  pack {delivery.campaignPackId ?? 'standalone'} · version {delivery.assetVersionId}
                </p>
                {delivery.latestSnapshot && (
                  <p className="mt-1 text-[11px] text-[#a7d7bf]">
                    Reach {delivery.latestSnapshot.reach} · engagement {delivery.latestSnapshot.engagements}
                    {' '}· clicks {delivery.latestSnapshot.clicks}
                  </p>
                )}
              </div>
            ))}
          </div>
        </>
      ) : null}
    </section>
  )
}
