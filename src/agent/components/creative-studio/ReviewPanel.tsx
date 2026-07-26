'use client'

import { useEffect, useState } from 'react'
import {
  addStudioReviewComment,
  fetchStudioReview,
  transitionStudioReview,
  type StudioReviewState,
  type StudioReviewThread,
} from '@/agent/components/creative-studio/studio-api'

const STATE_LABEL: Record<StudioReviewState, string> = {
  draft: 'খসড়া',
  changes_requested: 'পরিবর্তন চাওয়া হয়েছে',
  revised: 'সংশোধিত',
  approved: 'অনুমোদিত',
}

const ROLE_LABEL = {
  owner: 'মালিক',
  creator: 'নির্মাতা',
  reviewer: 'পর্যালোচক',
} as const

export function ReviewPanel({
  assetId,
  brandProfileId,
}: {
  assetId: string
  brandProfileId: string
}) {
  const [review, setReview] = useState<StudioReviewThread | null>(null)
  const [note, setNote] = useState('')
  const [comment, setComment] = useState('')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = async () => {
    setLoading(true)
    setError(null)
    try {
      setReview(await fetchStudioReview(assetId, brandProfileId))
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'পর্যালোচনার তথ্য লোড করা যায়নি।')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void load()
    // Asset and brand together are the complete immutable review scope.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [assetId, brandProfileId])

  const transition = async (targetState: StudioReviewState) => {
    if (!review) return
    if (targetState === 'changes_requested' && !note.trim()) {
      setError('কী পরিবর্তন দরকার তা লিখুন।')
      return
    }
    setSaving(true)
    setError(null)
    try {
      setReview(await transitionStudioReview({
        assetId,
        brandProfileId,
        targetState,
        expectedSequence: review.currentSequence,
        note: note.trim() || undefined,
      }))
      setNote('')
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'অবস্থা বদলানো যায়নি।')
    } finally {
      setSaving(false)
    }
  }

  const sendComment = async () => {
    if (!comment.trim()) return
    setSaving(true)
    setError(null)
    try {
      setReview(await addStudioReviewComment({
        assetId,
        brandProfileId,
        comment: comment.trim(),
      }))
      setComment('')
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'মন্তব্য যোগ করা যায়নি।')
    } finally {
      setSaving(false)
    }
  }

  if (loading) {
    return <div className="mt-4 h-36 animate-pulse rounded-2xl bg-white/[0.05]" aria-label="পর্যালোচনা লোড হচ্ছে" />
  }
  if (!review) {
    return (
      <div className="mt-4 rounded-2xl border border-red-400/20 bg-red-500/10 p-3">
        <p className="text-[11px] text-red-300">{error ?? 'পর্যালোচনার তথ্য পাওয়া যায়নি।'}</p>
        <button type="button" onClick={() => void load()} className="mt-2 text-[11px] font-bold text-cream">আবার চেষ্টা করুন</button>
      </div>
    )
  }

  const canRequest = review.capabilities.requestChanges
    && (review.currentState === 'draft' || review.currentState === 'revised')
  const canRevise = review.capabilities.markRevised
    && (review.currentState === 'changes_requested' || review.currentState === 'approved')
  const canApprove = review.capabilities.approve
    && (review.currentState === 'draft' || review.currentState === 'revised')

  return (
    <section className="mt-4 rounded-2xl border border-border-subtle bg-bg-1/70 p-3" aria-label="সম্পদ পর্যালোচনা">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h4 className="text-[11px] font-extrabold">পর্যালোচনা ও অনুমোদন</h4>
          <p className="mt-0.5 text-[11px] text-muted">
            {review.brandName} · আপনার ভূমিকা: {ROLE_LABEL[review.role]}
          </p>
        </div>
        <span className={`rounded-full px-2.5 py-1 text-[11px] font-bold ${
          review.publishReady
            ? 'bg-[#81B29A]/20 text-[#9fd6bd]'
            : review.currentState === 'changes_requested'
              ? 'bg-amber-400/15 text-amber-200'
              : 'bg-white/10 text-muted'
        }`}>
          {review.publishReady ? 'প্রকাশের জন্য প্রস্তুত' : STATE_LABEL[review.currentState]}
        </span>
      </div>

      {review.currentState === 'approved' && !review.publishReady && (
        <p className="mt-2 rounded-xl bg-amber-400/10 p-2 text-[11px] text-amber-200">
          অনুমোদনের পর নতুন সংস্করণ হয়েছে। এই সংস্করণ আবার অনুমোদন না হওয়া পর্যন্ত প্রকাশ-প্রস্তুত নয়।
        </p>
      )}
      {error && <p role="alert" className="mt-2 rounded-xl bg-red-500/10 p-2 text-[11px] text-red-300">{error}</p>}

      {(canRequest || canRevise || canApprove) && (
        <div className="mt-3">
          <textarea
            value={note}
            onChange={(event) => setNote(event.target.value)}
            placeholder={canRequest ? 'কী পরিবর্তন দরকার লিখুন…' : 'ঐচ্ছিক নোট…'}
            maxLength={2000}
            className="min-h-20 w-full resize-y rounded-xl border border-border-subtle bg-card px-3 py-2 text-[11px] text-cream outline-none placeholder:text-muted focus:border-[#E07A5F]/60"
          />
          <div className="mt-2 flex flex-wrap gap-2">
            {canRequest && (
              <button
                type="button"
                disabled={saving}
                onClick={() => void transition('changes_requested')}
                className="rounded-xl bg-amber-500/20 px-3 py-2 text-[11px] font-bold text-amber-100 disabled:opacity-40"
              >
                পরিবর্তন চান
              </button>
            )}
            {canRevise && (
              <button
                type="button"
                disabled={saving}
                onClick={() => void transition('revised')}
                className="rounded-xl bg-sky-500/20 px-3 py-2 text-[11px] font-bold text-sky-100 disabled:opacity-40"
              >
                সংশোধিত হিসেবে দিন
              </button>
            )}
            {canApprove && (
              <button
                type="button"
                disabled={saving}
                onClick={() => void transition('approved')}
                className="rounded-xl bg-[#81B29A] px-3 py-2 text-[11px] font-extrabold text-[#10241d] disabled:opacity-40"
              >
                প্রকাশের জন্য অনুমোদন
              </button>
            )}
          </div>
        </div>
      )}

      {review.capabilities.comment && (
        <div className="mt-4 border-t border-border-subtle pt-3">
          <label className="text-[11px] font-bold text-muted">
            পর্যালোচকের মন্তব্য
            <div className="mt-1 flex gap-2">
              <input
                value={comment}
                onChange={(event) => setComment(event.target.value)}
                maxLength={2000}
                placeholder="মন্তব্য লিখুন…"
                className="min-w-0 flex-1 rounded-xl border border-border-subtle bg-card px-3 py-2 text-[11px] text-cream outline-none"
              />
              <button
                type="button"
                disabled={saving || !comment.trim()}
                onClick={() => void sendComment()}
                className="rounded-xl bg-white/10 px-3 text-[11px] font-bold text-cream disabled:opacity-40"
              >
                যোগ করুন
              </button>
            </div>
          </label>
        </div>
      )}

      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <div>
          <h5 className="text-[11px] font-bold">অপরিবর্তনীয় অবস্থা ইতিহাস</h5>
          <div className="mt-2 space-y-2">
            {review.events.length === 0 ? (
              <p className="rounded-xl border border-dashed border-border-subtle p-3 text-[11px] text-muted">এখনো কোনো পরিবর্তন নেই। বর্তমান অবস্থা খসড়া।</p>
            ) : review.events.map((event) => (
              <div key={event.id} className="rounded-xl border border-border-subtle bg-card/70 p-2.5">
                <div className="flex items-center justify-between gap-2 text-[11px]">
                  <span className="font-bold text-cream">#{event.sequence} · {STATE_LABEL[event.toState]}</span>
                  <span className="text-muted">{new Date(event.createdAt).toLocaleString('bn-BD')}</span>
                </div>
                <p className="mt-1 text-[11px] text-muted">{event.actorName} · {ROLE_LABEL[event.actorRole]}</p>
                {event.note && <p className="mt-1 text-[11px] text-cream">{event.note}</p>}
              </div>
            ))}
          </div>
        </div>

        <div>
          <h5 className="text-[11px] font-bold">মন্তব্য</h5>
          <div className="mt-2 space-y-2">
            {review.comments.length === 0 ? (
              <p className="rounded-xl border border-dashed border-border-subtle p-3 text-[11px] text-muted">এখনো কোনো মন্তব্য নেই।</p>
            ) : review.comments.map((item) => (
              <div key={item.id} className="rounded-xl border border-border-subtle bg-card/70 p-2.5">
                <div className="flex items-center justify-between gap-2 text-[11px]">
                  <span className="font-bold text-cream">{item.authorName} · {ROLE_LABEL[item.authorRole]}</span>
                  <span className="text-muted">{new Date(item.createdAt).toLocaleString('bn-BD')}</span>
                </div>
                <p className="mt-1 text-[11px] text-cream">{item.body}</p>
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  )
}
