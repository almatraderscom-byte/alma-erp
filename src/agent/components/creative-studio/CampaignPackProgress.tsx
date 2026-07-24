'use client'

import { cn } from '@/lib/utils'
import type {
  CampaignPackClient,
  CampaignPackStageClient,
} from '@/agent/components/creative-studio/studio-api'

const STATUS_LABELS: Record<CampaignPackStageClient['status'], string> = {
  not_started: 'অপেক্ষায়',
  queued: 'কিউড',
  running: 'চলছে',
  ready: 'রেডি',
  failed: 'ব্যর্থ',
  rejected: 'রিজেক্টেড',
}

function statusClass(status: CampaignPackStageClient['status']) {
  if (status === 'ready') return 'bg-emerald-400/15 text-emerald-200'
  if (status === 'failed' || status === 'rejected') return 'bg-red-400/15 text-red-200'
  if (status === 'queued' || status === 'running') return 'bg-amber-400/15 text-amber-100'
  return 'bg-white/[0.06] text-muted'
}

export function CampaignPackProgress({
  pack,
  busyStageId,
  onSelectDraft,
  onRetry,
}: {
  pack: CampaignPackClient
  busyStageId: string | null
  onSelectDraft: (stageId: 'draft-a' | 'draft-b') => void
  onRetry: (stage: CampaignPackStageClient) => void
}) {
  const drafts = pack.stages.filter((stage) => stage.stageId === 'draft-a' || stage.stageId === 'draft-b')
  const finalStages = pack.stages.filter((stage) => stage.stageId !== 'draft-a' && stage.stageId !== 'draft-b')

  return (
    <section aria-label="Campaign pack progress" className="space-y-3">
      <div className="rounded-2xl border border-white/10 bg-white/[0.04] p-3">
        <div className="flex items-center justify-between gap-3 text-[11px]">
          <span className="font-bold text-cream">
            {pack.status === 'waiting_selection'
              ? 'ড্রাফট বেছে নিন'
              : pack.status === 'ready'
                ? 'Campaign Pack রেডি'
                : pack.status === 'attention'
                  ? 'একটি stage দেখুন'
                  : 'Campaign Pack চলছে'}
          </span>
          <span className="text-muted">{pack.progressPercent}%</span>
        </div>
        <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-white/10">
          <div
            className="h-full rounded-full bg-[#E07A5F] transition-[width]"
            style={{ width: `${pack.progressPercent}%` }}
          />
        </div>
        <p className="mt-2 text-[9px] text-muted">
          খরচ: ${pack.actualCostUsd.toFixed(2)} / অনুমোদিত ${pack.estimatedCostUsd.toFixed(2)}
        </p>
      </div>

      <div className="grid grid-cols-2 gap-2">
        {drafts.map((stage) => {
          const selectable = pack.status === 'waiting_selection' && stage.status === 'ready'
          const selected = pack.selectedDraftStageId === stage.stageId
          return (
            <article
              key={stage.stageId}
              className={cn(
                'overflow-hidden rounded-2xl border bg-black/20',
                selected ? 'border-[#E07A5F]' : 'border-white/10',
              )}
            >
              <div className="aspect-[4/5] bg-white/[0.04]">
                {stage.previewUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={stage.previewUrl} alt={stage.labelBn} className="h-full w-full object-cover" />
                ) : (
                  <div className="grid h-full place-items-center text-2xl text-muted">
                    {stage.status === 'ready' ? '✓' : '◌'}
                  </div>
                )}
              </div>
              <div className="space-y-2 p-2">
                <div className="flex items-center justify-between gap-1">
                  <span className="text-[10px] font-bold text-cream">{stage.labelBn}</span>
                  <span className={cn('rounded-full px-1.5 py-0.5 text-[8px]', statusClass(stage.status))}>
                    {STATUS_LABELS[stage.status]}
                  </span>
                </div>
                {selectable && (
                  <button
                    type="button"
                    disabled={busyStageId === stage.stageId}
                    onClick={() => onSelectDraft(stage.stageId as 'draft-a' | 'draft-b')}
                    className="w-full rounded-lg bg-[#E07A5F] py-1.5 text-[10px] font-bold text-white disabled:opacity-50"
                  >
                    {busyStageId === stage.stageId ? 'নির্বাচন হচ্ছে…' : 'এই ড্রাফট নিন'}
                  </button>
                )}
              </div>
            </article>
          )
        })}
      </div>

      <div className="space-y-2">
        {finalStages.map((stage) => (
          <article key={stage.stageId} className="rounded-xl border border-white/10 bg-white/[0.03] p-2.5">
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <p className="text-[10px] font-bold text-cream">{stage.labelBn}</p>
                <p className="truncate text-[8px] text-muted">
                  {stage.engine} · ${stage.estimatedCostUsd.toFixed(2)} · attempt {Math.max(1, stage.attempt)}
                </p>
              </div>
              <span className={cn('shrink-0 rounded-full px-1.5 py-0.5 text-[8px]', statusClass(stage.status))}>
                {STATUS_LABELS[stage.status]}
              </span>
            </div>
            {stage.previewUrl && stage.mediaType === 'image' && (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={stage.previewUrl} alt={stage.labelBn} className="mt-2 max-h-48 w-full rounded-lg object-contain" />
            )}
            {stage.previewUrl && stage.mediaType === 'video' && (
              <video src={stage.previewUrl} controls className="mt-2 max-h-56 w-full rounded-lg" />
            )}
            {stage.captionBn && (
              <p className="mt-2 whitespace-pre-line rounded-lg bg-black/20 p-2 text-[10px] leading-relaxed text-cream">
                {stage.captionBn}
              </p>
            )}
            {(stage.status === 'ready' || stage.status === 'failed') && (
              <button
                type="button"
                disabled={busyStageId === stage.stageId}
                onClick={() => onRetry(stage)}
                className="mt-2 rounded-lg border border-white/10 px-2 py-1 text-[9px] font-semibold text-muted disabled:opacity-40"
              >
                {stage.status === 'ready' ? 'রিজেক্ট + শুধু এই stage আবার' : 'শুধু এই stage আবার'}
              </button>
            )}
          </article>
        ))}
      </div>
    </section>
  )
}
