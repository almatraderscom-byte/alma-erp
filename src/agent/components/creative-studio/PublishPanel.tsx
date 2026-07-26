'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { toast } from 'react-hot-toast'
import {
  fetchStudioPublishDeliveries,
  mutateStudioPublishDelivery,
  previewStudioPublishClient,
  scheduleStudioPublishClient,
  setStudioPublishingEnabledClient,
  type StudioPublishDelivery,
  type StudioPublishPlatform,
  type StudioPublishPreview,
} from '@/agent/components/creative-studio/studio-api'

function localDateTime(minutesFromNow = 15) {
  const date = new Date(Date.now() + minutesFromNow * 60_000)
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000)
    .toISOString()
    .slice(0, 16)
}

function newPublishKey(assetId: string) {
  const random = typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`
  return `studio-publish:${assetId}:${random}`
}

const STATUS_LABEL: Record<StudioPublishDelivery['status'], string> = {
  scheduled: 'সময়সূচিতে',
  publishing: 'Meta-তে পাঠানো হচ্ছে',
  published: 'প্রকাশিত ও যাচাইকৃত',
  failed_retryable: 'নিরাপদ retry অপেক্ষায়',
  needs_review: 'ম্যানুয়াল যাচাই দরকার',
  canceled: 'বাতিল',
}

export function PublishPanel({
  assetId,
  brandProfileId,
  assetTitle,
}: {
  assetId: string
  brandProfileId: string
  assetTitle: string | null
}) {
  const [deliveries, setDeliveries] = useState<StudioPublishDelivery[]>([])
  const [publishingEnabled, setPublishingEnabled] = useState(false)
  const [canPublish, setCanPublish] = useState(false)
  const [platform, setPlatform] = useState<StudioPublishPlatform>('facebook')
  const [pageRef, setPageRef] = useState<'lifestyle' | 'onlineshop'>('lifestyle')
  const [caption, setCaption] = useState(assetTitle ? `${assetTitle}\n\nALMA Lifestyle` : '')
  const [scheduledFor, setScheduledFor] = useState(localDateTime())
  const [adId, setAdId] = useState('')
  const [idempotencyKey, setIdempotencyKey] = useState(() => newPublishKey(assetId))
  const [preview, setPreview] = useState<StudioPublishPreview | null>(null)
  const [confirmed, setConfirmed] = useState(false)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const data = await fetchStudioPublishDeliveries(assetId, brandProfileId)
      setDeliveries(data.deliveries)
      setPublishingEnabled(data.publishingEnabled)
      setCanPublish(data.canPublish)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Publish history লোড হয়নি।')
    } finally {
      setLoading(false)
    }
  }, [assetId, brandProfileId])

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    setPreview(null)
    setConfirmed(false)
  }, [platform, pageRef, caption, scheduledFor, adId])

  const input = useMemo(() => ({
    assetId,
    brandProfileId,
    platform,
    pageRef,
    caption,
    scheduledFor: Number.isFinite(new Date(scheduledFor).getTime())
      ? new Date(scheduledFor).toISOString()
      : '',
    idempotencyKey,
    ...(adId.trim() ? { adId: adId.trim() } : {}),
  }), [
    adId,
    assetId,
    brandProfileId,
    caption,
    idempotencyKey,
    pageRef,
    platform,
    scheduledFor,
  ])

  const runDryPreview = async () => {
    setBusy('preview')
    setError(null)
    try {
      const result = await previewStudioPublishClient(input)
      setPreview(result)
      toast.success('Dry-run সম্পন্ন — কোনো পোস্ট হয়নি, খরচ $0')
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Dry-run হয়নি।')
    } finally {
      setBusy(null)
    }
  }

  const schedule = async () => {
    if (!preview || !confirmed) return
    setBusy('schedule')
    setError(null)
    try {
      const result = await scheduleStudioPublishClient(input)
      setDeliveries((current) => [
        result.delivery,
        ...current.filter((row) => row.id !== result.delivery.id),
      ])
      setPreview(null)
      setConfirmed(false)
      setIdempotencyKey(newPublishKey(assetId))
      toast.success(result.idempotent ? 'একই Publish request আগেই ছিল' : 'Publish সময়সূচিতে যোগ হয়েছে')
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Publish schedule হয়নি।')
    } finally {
      setBusy(null)
    }
  }

  const updateEnabled = async (enabled: boolean) => {
    setBusy('enable')
    try {
      const result = await setStudioPublishingEnabledClient(brandProfileId, enabled)
      setPublishingEnabled(result.publishingEnabled)
      toast.success(enabled ? 'Meta delivery চালু হয়েছে' : 'Meta delivery pause হয়েছে')
    } catch (reason) {
      toast.error(reason instanceof Error ? reason.message : 'Setting সেভ হয়নি')
    } finally {
      setBusy(null)
    }
  }

  const mutate = async (intent: 'cancel' | 'retry', deliveryId: string) => {
    setBusy(deliveryId)
    try {
      const delivery = await mutateStudioPublishDelivery(intent, deliveryId)
      setDeliveries((current) => current.map((row) => row.id === delivery.id ? delivery : row))
      toast.success(intent === 'cancel' ? 'Publish বাতিল হয়েছে' : 'নিরাপদ retry সময়সূচিতে')
    } catch (reason) {
      toast.error(reason instanceof Error ? reason.message : 'কাজটি হয়নি')
    } finally {
      setBusy(null)
    }
  }

  return (
    <section className="mt-4 rounded-2xl border border-border-subtle bg-bg-1/70 p-3">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h4 className="text-[12px] font-bold text-cream">📣 অনুমোদিত Meta delivery</h4>
          <p className="mt-0.5 text-[11px] text-muted">
            আগে dry-run · approved version pin · একই key retry হলেও duplicate নয়
          </p>
        </div>
        {canPublish && (
          <label className="flex shrink-0 items-center gap-1.5 text-[11px] text-muted">
            Live delivery
            <input
              type="checkbox"
              checked={publishingEnabled}
              disabled={busy === 'enable'}
              onChange={(event) => void updateEnabled(event.target.checked)}
              className="h-4 w-4 accent-[#E07A5F]"
            />
          </label>
        )}
      </div>

      {!publishingEnabled && (
        <p className="mt-2 rounded-lg bg-amber-500/10 px-2.5 py-2 text-[11px] text-amber-200">
          Safe default: live Meta delivery বন্ধ। Schedule রাখা যাবে, কিন্তু owner চালু না করা পর্যন্ত worker প্রকাশ করবে না।
        </p>
      )}

      {canPublish && (
        <div className="mt-3 grid gap-2 sm:grid-cols-2">
          <label className="space-y-1 text-[11px] font-semibold text-muted">
            Platform
            <select
              value={platform}
              onChange={(event) => setPlatform(event.target.value as StudioPublishPlatform)}
              className="w-full rounded-lg border border-border-subtle bg-card px-2 py-2 text-[11px] text-cream"
            >
              <option value="facebook">Facebook</option>
              <option value="instagram">Instagram</option>
            </select>
          </label>
          <label className="space-y-1 text-[11px] font-semibold text-muted">
            Page
            <select
              value={pageRef}
              onChange={(event) => setPageRef(event.target.value as 'lifestyle' | 'onlineshop')}
              className="w-full rounded-lg border border-border-subtle bg-card px-2 py-2 text-[11px] text-cream"
            >
              <option value="lifestyle">ALMA Lifestyle</option>
              <option value="onlineshop">ALMA Online Shop</option>
            </select>
          </label>
          <label className="space-y-1 text-[11px] font-semibold text-muted sm:col-span-2">
            বাংলা caption
            <textarea
              value={caption}
              onChange={(event) => setCaption(event.target.value)}
              rows={4}
              maxLength={platform === 'instagram' ? 2_200 : 10_000}
              className="w-full resize-none rounded-lg border border-border-subtle bg-card px-2.5 py-2 text-[11px] text-cream"
            />
          </label>
          <label className="space-y-1 text-[11px] font-semibold text-muted">
            Publish সময়
            <input
              type="datetime-local"
              value={scheduledFor}
              onChange={(event) => setScheduledFor(event.target.value)}
              className="w-full rounded-lg border border-border-subtle bg-card px-2 py-2 text-[11px] text-cream"
            />
          </label>
          <label className="space-y-1 text-[11px] font-semibold text-muted">
            Meta Ad ID (ঐচ্ছিক attribution)
            <input
              value={adId}
              onChange={(event) => setAdId(event.target.value)}
              placeholder="Ad insights থাকলে"
              className="w-full rounded-lg border border-border-subtle bg-card px-2 py-2 text-[11px] text-cream"
            />
          </label>
          <button
            type="button"
            disabled={busy !== null || caption.trim().length === 0 || !scheduledFor}
            onClick={() => void runDryPreview()}
            className="rounded-lg bg-white/10 px-3 py-2 text-[11px] font-bold text-cream disabled:opacity-40 sm:col-span-2"
          >
            {busy === 'preview' ? 'Dry-run হচ্ছে…' : 'Dry-run preview · $0'}
          </button>
        </div>
      )}

      {preview && (
        <div className="mt-3 rounded-xl border border-[#81B29A]/30 bg-[#81B29A]/10 p-3">
          <div className="flex items-center justify-between gap-2">
            <p className="text-[11px] font-bold text-[#a7d7bf]">✓ Dry-run receipt · কোনো external effect হয়নি</p>
            <span className="rounded-full bg-black/20 px-2 py-0.5 text-[11px] text-[#a7d7bf]">$0</span>
          </div>
          <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-2 gap-y-1 text-[11px] text-muted">
            <dt>Version</dt><dd className="truncate font-mono text-cream">{preview.assetVersionId}</dd>
            <dt>Review</dt><dd className="truncate font-mono text-cream">{preview.approvedReviewEventId}</dd>
            <dt>Campaign pack</dt><dd className="truncate font-mono text-cream">{preview.campaignPackId ?? 'standalone'}</dd>
            <dt>Idempotency</dt><dd className="truncate font-mono text-cream">{preview.idempotencyKey}</dd>
            <dt>Fingerprint</dt><dd className="truncate font-mono text-cream">{preview.requestFingerprint}</dd>
          </dl>
          <label className="mt-3 flex items-start gap-2 text-[11px] text-cream">
            <input
              type="checkbox"
              checked={confirmed}
              onChange={(event) => setConfirmed(event.target.checked)}
              className="mt-0.5 h-4 w-4 accent-[#E07A5F]"
            />
            আমি approved version, caption, page ও সময় দেখে এই delivery schedule অনুমোদন করছি।
          </label>
          <button
            type="button"
            disabled={!confirmed || busy !== null}
            onClick={() => void schedule()}
            className="mt-2 w-full rounded-lg bg-[#E07A5F] px-3 py-2 text-[11px] font-bold text-white disabled:opacity-40"
          >
            {busy === 'schedule' ? 'Schedule হচ্ছে…' : 'Owner-approved schedule'}
          </button>
        </div>
      )}

      {error && <p role="alert" className="mt-2 rounded-lg bg-red-500/10 p-2 text-[11px] text-red-300">{error}</p>}

      <div className="mt-3 border-t border-border-subtle pt-3">
        <div className="flex items-center justify-between">
          <p className="text-[11px] font-bold text-cream">Delivery receipts</p>
          <button type="button" onClick={() => void load()} className="text-[11px] font-semibold text-muted">রিফ্রেশ</button>
        </div>
        {loading ? (
          <p className="py-3 text-center text-[11px] text-muted">লোড হচ্ছে…</p>
        ) : deliveries.length === 0 ? (
          <p className="py-3 text-center text-[11px] text-muted">এখনো কোনো delivery নেই।</p>
        ) : (
          <div className="mt-2 space-y-2">
            {deliveries.map((delivery) => (
              <div key={delivery.id} className="rounded-lg border border-border-subtle bg-card/70 p-2.5">
                <div className="flex items-center justify-between gap-2">
                  <p className="text-[11px] font-bold text-cream">
                    {delivery.platform === 'facebook' ? 'Facebook' : 'Instagram'} · {STATUS_LABEL[delivery.status]}
                  </p>
                  <span className="text-[11px] text-muted">চেষ্টা {delivery.attempts} · ${delivery.costUsd.toFixed(2)}</span>
                </div>
                <p className="mt-1 text-[11px] text-muted">
                  {new Date(delivery.scheduledFor).toLocaleString('bn-BD')} · scene {delivery.sceneKey}
                </p>
                {delivery.externalPostId && (
                  <p className="mt-1 truncate font-mono text-[11px] text-[#81B29A]">
                    Receipt {delivery.externalPostId}{delivery.verifiedAt ? ' · fetch-back verified' : ''}
                  </p>
                )}
                {delivery.lastErrorMessage && (
                  <p className="mt-1 text-[11px] text-amber-200">{delivery.lastErrorMessage}</p>
                )}
                <div className="mt-2 flex gap-2">
                  {delivery.status === 'scheduled' && canPublish && (
                    <button
                      type="button"
                      disabled={busy !== null}
                      onClick={() => void mutate('cancel', delivery.id)}
                      className="rounded-md bg-white/10 px-2 py-1 text-[11px] font-semibold text-muted"
                    >
                      বাতিল
                    </button>
                  )}
                  {delivery.status === 'failed_retryable' && canPublish && (
                    <button
                      type="button"
                      disabled={busy !== null}
                      onClick={() => void mutate('retry', delivery.id)}
                      className="rounded-md bg-amber-500/15 px-2 py-1 text-[11px] font-semibold text-amber-200"
                    >
                      নিরাপদ retry
                    </button>
                  )}
                  {delivery.permalinkUrl && (
                    <a
                      href={delivery.permalinkUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="rounded-md bg-[#81B29A]/15 px-2 py-1 text-[11px] font-semibold text-[#a7d7bf]"
                    >
                      Meta-তে দেখুন
                    </a>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </section>
  )
}
