'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import toast from 'react-hot-toast'
import { CampaignPackProgress } from '@/agent/components/creative-studio/CampaignPackProgress'
import {
  fetchCampaignPack,
  getActiveStudioContentContext,
  listCampaignPacks,
  previewCampaignPack,
  queueCampaignPack,
  retryCampaignPackStage,
  selectCampaignPackDraft,
  type CampaignPackClient,
  type CampaignPackStageClient,
} from '@/agent/components/creative-studio/studio-api'
import type { CampaignPackManifest } from '@/lib/creative-studio/campaign-pack'

function newIdempotencyKey() {
  if (typeof window !== 'undefined' && typeof window.crypto?.randomUUID === 'function') {
    return `cse4-${window.crypto.randomUUID()}`
  }
  return `cse4-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

export function CampaignPackPanel() {
  const [includeFamily, setIncludeFamily] = useState(false)
  const [includeReel, setIncludeReel] = useState(false)
  const [manifest, setManifest] = useState<CampaignPackManifest | null>(null)
  const [pack, setPack] = useState<CampaignPackClient | null>(null)
  const [loading, setLoading] = useState(true)
  const [queueing, setQueueing] = useState(false)
  const [paidConfirmed, setPaidConfirmed] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busyStageId, setBusyStageId] = useState<string | null>(null)
  const idempotencyKey = useRef('')
  const initialRestoreComplete = useRef(false)
  const activePackId = pack?.id ?? null
  const activePackStatus = pack?.status ?? null

  const loadManifest = useCallback(async () => {
    const context = getActiveStudioContentContext()
    if (!context) {
      setManifest(null)
      setError('Campaign Pack-এর জন্য একটি Project বেছে নিন।')
      setLoading(false)
      return
    }
    setLoading(true)
    setError(null)
    setPaidConfirmed(false)
    try {
      setManifest(await previewCampaignPack({
        projectId: context.projectId,
        includeFamily,
        includeReel,
      }))
    } catch (reason) {
      setManifest(null)
      setError(reason instanceof Error ? reason.message : 'Campaign Pack preview লোড হয়নি।')
    } finally {
      setLoading(false)
    }
  }, [includeFamily, includeReel])

  useEffect(() => {
    const restoreOrPreview = async () => {
      const context = getActiveStudioContentContext()
      if (!context) {
        await loadManifest()
        return
      }
      if (!initialRestoreComplete.current) {
        initialRestoreComplete.current = true
        setLoading(true)
        setError(null)
        try {
          const recent = await listCampaignPacks(context.projectId)
          if (recent[0]) {
            // The detail route signs every completed storage path, so a browser
            // reload restores both durable progress and viewable draft/output URLs.
            setPack(await fetchCampaignPack(recent[0].id))
            setManifest(null)
            setLoading(false)
            return
          }
        } catch {
          // Fall through to a fresh manifest; recovery must not strand Studio.
        }
      }
      await loadManifest()
    }
    void restoreOrPreview()
    const refresh = () => {
      setPack(null)
      idempotencyKey.current = ''
      initialRestoreComplete.current = false
      void restoreOrPreview()
    }
    window.addEventListener('alma-studio-content-context', refresh)
    return () => window.removeEventListener('alma-studio-content-context', refresh)
  }, [loadManifest])

  useEffect(() => {
    if (!activePackId || activePackStatus === 'ready') return
    let active = true
    const poll = async () => {
      try {
        const next = await fetchCampaignPack(activePackId)
        if (active) setPack(next)
      } catch {
        // Keep the last durable snapshot; the next interval retries.
      }
    }
    const interval = window.setInterval(() => void poll(), 3_000)
    return () => {
      active = false
      window.clearInterval(interval)
    }
  }, [activePackId, activePackStatus])

  const queue = async () => {
    const context = getActiveStudioContentContext()
    if (!context || !manifest) return
    if (manifest.requiresPaidConfirmation && !paidConfirmed) {
      toast.error('প্রথমে মোট paid cost নিশ্চিত করুন।')
      return
    }
    if (!idempotencyKey.current) idempotencyKey.current = newIdempotencyKey()
    setQueueing(true)
    setError(null)
    try {
      const result = await queueCampaignPack({
        projectId: context.projectId,
        includeFamily,
        includeReel,
        idempotencyKey: idempotencyKey.current,
        confirmedCostUsd: manifest.estimatedCostUsd,
      })
      setPack(result.pack)
      toast.success(result.idempotent ? 'একই Campaign Pack খোলা হয়েছে।' : 'দুটি preview draft কিউ হয়েছে।')
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : 'Campaign Pack কিউ হয়নি।'
      setError(message)
      toast.error(message)
    } finally {
      setQueueing(false)
    }
  }

  const selectDraft = async (stageId: 'draft-a' | 'draft-b') => {
    if (!pack) return
    setBusyStageId(stageId)
    try {
      setPack(await selectCampaignPackDraft(pack.id, stageId))
      toast.success('ড্রাফট লক হয়েছে — final stages কিউ হয়েছে।')
    } catch (reason) {
      toast.error(reason instanceof Error ? reason.message : 'ড্রাফট নির্বাচন হয়নি।')
    } finally {
      setBusyStageId(null)
    }
  }

  const retry = async (stage: CampaignPackStageClient) => {
    if (!pack) return
    if (
      stage.estimatedCostUsd > 0
      && !window.confirm(`শুধু ${stage.labelBn} আবার চালাতে $${stage.estimatedCostUsd.toFixed(2)} পর্যন্ত খরচ হতে পারে। নিশ্চিত?`)
    ) return
    setBusyStageId(stage.stageId)
    try {
      setPack(await retryCampaignPackStage({
        packId: pack.id,
        stageId: stage.stageId,
        confirmedCostUsd: stage.estimatedCostUsd || undefined,
        reason: 'owner_rejected_output',
      }))
      toast.success('শুধু নির্বাচিত stage আবার কিউ হয়েছে।')
    } catch (reason) {
      toast.error(reason instanceof Error ? reason.message : 'Stage retry হয়নি।')
    } finally {
      setBusyStageId(null)
    }
  }

  if (pack) {
    return (
      <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-28 pt-3">
        <div className="mx-auto max-w-2xl space-y-3">
          <button
            type="button"
            onClick={() => {
              setPack(null)
              idempotencyKey.current = ''
              void loadManifest()
            }}
            className="text-[10px] font-semibold text-muted"
          >
            ← নতুন pack preview
          </button>
          <CampaignPackProgress
            pack={pack}
            busyStageId={busyStageId}
            onSelectDraft={(id) => void selectDraft(id)}
            onRetry={(stage) => void retry(stage)}
          />
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-28 pt-3">
      <div className="mx-auto max-w-2xl space-y-3">
        <section className="rounded-2xl border border-[#E07A5F]/25 bg-[#E07A5F]/[0.07] p-3">
          <p className="text-[12px] font-extrabold text-cream">Deterministic Campaign Pack</p>
          <p className="mt-1 text-[9px] leading-relaxed text-muted">
            Project-এর ERP product + locked recipe থেকে আগে সম্পূর্ণ manifest দেখুন।
            দুটি free preview draft-এর একটি বাছার আগে paid video কখনো শুরু হবে না।
          </p>
        </section>

        <div className="grid grid-cols-2 gap-2">
          <label className="flex items-center justify-between rounded-xl border border-white/10 bg-white/[0.04] px-3 py-2 text-[10px] text-cream">
            Family version
            <input
              type="checkbox"
              checked={includeFamily}
              onChange={(event) => setIncludeFamily(event.target.checked)}
              className="accent-[#E07A5F]"
            />
          </label>
          <label className="flex items-center justify-between rounded-xl border border-white/10 bg-white/[0.04] px-3 py-2 text-[10px] text-cream">
            6s Reel
            <input
              type="checkbox"
              checked={includeReel}
              onChange={(event) => setIncludeReel(event.target.checked)}
              className="accent-[#E07A5F]"
            />
          </label>
        </div>

        {loading && <div className="rounded-2xl bg-white/[0.04] p-5 text-center text-[10px] text-muted">Manifest তৈরি হচ্ছে…</div>}
        {error && <p role="alert" className="rounded-xl border border-red-400/20 bg-red-400/10 p-3 text-[10px] text-red-200">{error}</p>}

        {manifest && (
          <>
            <section className="rounded-2xl border border-white/10 bg-white/[0.035] p-3">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="text-[11px] font-bold text-cream">{manifest.product.name}</p>
                  <p className="text-[9px] text-muted">
                    {manifest.product.code} · ৳{manifest.product.priceBdt.toLocaleString('bn-BD')}
                  </p>
                  <p className="mt-1 text-[9px] text-emerald-200">
                    🔒 {manifest.recipe.name} v{manifest.recipe.version}
                  </p>
                  <p className="mt-1 text-[8px] text-muted">
                    Master: {manifest.masterSource.kind === 'approved_project_asset'
                      ? '✓ approved project asset (reused)'
                      : 'ERP product image'}
                  </p>
                </div>
                <div className="text-right">
                  <p className="text-lg font-black text-cream">${manifest.estimatedCostUsd.toFixed(2)}</p>
                  <p className="text-[8px] text-muted">hard cap ${manifest.hardCostCeilingUsd.toFixed(2)}</p>
                </div>
              </div>
              <div className="mt-3 grid grid-cols-2 gap-2 text-[9px] text-muted">
                <div className="rounded-lg bg-black/15 p-2">{manifest.outputs.length} outputs</div>
                <div className="rounded-lg bg-black/15 p-2">~{Math.max(1, Math.ceil(manifest.estimatedSeconds / 60))} মিনিট</div>
              </div>
            </section>

            <section className="space-y-1.5">
              {manifest.stages.map((stage, index) => (
                <div key={stage.id} className="flex items-center gap-2 rounded-xl border border-white/10 bg-white/[0.03] px-2.5 py-2">
                  <span className="grid h-5 w-5 shrink-0 place-items-center rounded-full bg-white/[0.07] text-[8px] text-muted">{index + 1}</span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[9px] font-bold text-cream">{stage.labelBn}</p>
                    <p className="truncate text-[8px] text-muted">{stage.engine} · ~{stage.estimatedSeconds}s</p>
                  </div>
                  <span className={stage.paid ? 'text-[9px] font-bold text-amber-200' : 'text-[9px] font-bold text-emerald-200'}>
                    {stage.paid ? `$${stage.estimatedCostUsd.toFixed(2)}` : 'FREE'}
                  </span>
                </div>
              ))}
            </section>

            {manifest.requiresPaidConfirmation && (
              <label className="flex items-start gap-2 rounded-xl border border-amber-300/25 bg-amber-300/[0.08] p-3 text-[9px] leading-relaxed text-amber-100">
                <input
                  type="checkbox"
                  checked={paidConfirmed}
                  onChange={(event) => setPaidConfirmed(event.target.checked)}
                  className="mt-0.5 accent-[#E07A5F]"
                />
                মোট ${manifest.estimatedCostUsd.toFixed(2)} (৳{manifest.estimatedCostBdt}) পর্যন্ত paid call আমি অনুমোদন করছি।
              </label>
            )}

            <button
              type="button"
              disabled={queueing || (manifest.requiresPaidConfirmation && !paidConfirmed)}
              onClick={() => void queue()}
              className="w-full rounded-xl bg-[#E07A5F] py-3 text-[12px] font-bold text-white disabled:opacity-40"
            >
              {queueing ? 'কিউ হচ্ছে…' : `দুটি preview draft কিউ করুন · $${manifest.estimatedCostUsd.toFixed(2)}`}
            </button>
            <p className="text-center text-[8px] text-muted">
              একই submit key একই pack-ই ফেরত দেয় · completed paid stage restart-এ পুনরায় চলে না
            </p>
          </>
        )}
      </div>
    </div>
  )
}
