'use client'

import {
  deleteVoiceVersion,
  estimateVoiceClone,
  fetchCreativeVoices,
  queueVoiceClone,
  updateVoiceVersion,
  uploadAudioFile,
  type AudioJobEstimate,
  type CreativeVoiceClient,
} from '@/agent/components/creative-studio/studio-api'
import { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'react-hot-toast'

const CONSENT =
  'আমি নিশ্চিত করছি যে এটি আমার নিজের কণ্ঠ, আমি এই নমুনা দিয়ে ব্যক্তিগত Creative Studio voice clone তৈরির অনুমতি দিচ্ছি, এবং এটি কেবল আমার owner-only Studio কাজে ব্যবহার হবে।'

const statusBn: Record<string, string> = {
  pending: 'Provider-এ তৈরি হচ্ছে',
  ready: 'Ready',
  active: 'Active ✓',
  revoked: 'Revoked',
  deletion_pending: 'Provider deletion চলছে',
  deleted: 'Provider থেকে deleted',
}

export function VoiceLibrary({ onChanged }: { onChanged?: () => void }) {
  const [voices, setVoices] = useState<CreativeVoiceClient[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<string | null>(null)
  const [consented, setConsented] = useState(false)
  const [uploadPct, setUploadPct] = useState<number | null>(null)
  const [cloneDraft, setCloneDraft] = useState<{
    paths: string[]
    estimate: AudioJobEstimate
  } | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  const load = useCallback(async () => {
    try {
      setVoices(await fetchCreativeVoices())
      onChanged?.()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Voice Library খোলা যায়নি')
    } finally {
      setLoading(false)
    }
  }, [onChanged])

  useEffect(() => {
    void load()
  }, [load])

  const prepareClone = useCallback(async (files: File[]) => {
    if (!consented) {
      toast.error('নিজের কণ্ঠের consent আগে নিশ্চিত করুন')
      return
    }
    setBusy('upload')
    setUploadPct(0)
    try {
      const paths = await Promise.all(files.slice(0, 3).map((file) => uploadAudioFile(file, setUploadPct)))
      const estimate = await estimateVoiceClone({
        name: 'Maruf — Owner Voice',
        samplePaths: paths,
        consent: { accepted: true, statement: CONSENT },
      })
      setCloneDraft({ paths, estimate })
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Voice sample প্রস্তুত হয়নি')
    } finally {
      setBusy(null)
      setUploadPct(null)
      if (fileRef.current) fileRef.current.value = ''
    }
  }, [consented])

  const confirmClone = useCallback(async () => {
    if (!cloneDraft) return
    setBusy('clone')
    try {
      await queueVoiceClone({
        name: 'Maruf — Owner Voice',
        samplePaths: cloneDraft.paths,
        consent: { accepted: true, statement: CONSENT },
      }, {
        confirmedCostBdt: cloneDraft.estimate.costBdt,
        costCapBdt: cloneDraft.estimate.maxCostBdt,
      })
      setCloneDraft(null)
      setConsented(false)
      toast.success('নতুন immutable voice version Queue হয়েছে')
      await load()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Voice clone Queue হয়নি')
    } finally {
      setBusy(null)
    }
  }, [cloneDraft, load])

  const lifecycle = useCallback(async (
    versionId: string,
    action: 'activate' | 'revoke' | 'delete',
  ) => {
    setBusy(versionId)
    try {
      if (action === 'delete') {
        await deleteVoiceVersion(versionId, 'Owner deleted from Creative Studio Voice Library')
        toast.success('Provider deletion Queue হয়েছে')
      } else {
        await updateVoiceVersion(versionId, action, `Owner ${action}d from Creative Studio`)
        toast.success(action === 'activate' ? 'এই version এখন Active' : 'Voice version revoke হয়েছে')
      }
      await load()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Voice action ব্যর্থ')
    } finally {
      setBusy(null)
    }
  }, [load])

  return (
    <div className="space-y-3 st-card p-3">
      <div>
        <p className="text-[12px] font-bold text-cream">🧬 Owner Voice Library</p>
        <p className="text-[10px] text-muted">
          Consent + immutable version + audit history। Active owner voice কখনো autonomous বা customer-facing flow-তে যায় না।
        </p>
      </div>

      <label className="flex items-start gap-2 rounded-lg border border-[#81B29A]/20 bg-[#81B29A]/[0.06] p-2.5">
        <input
          type="checkbox"
          checked={consented}
          onChange={(event) => setConsented(event.target.checked)}
          className="mt-0.5 accent-[#81B29A]"
        />
        <span className="text-[10px] leading-relaxed text-cream">{CONSENT}</span>
      </label>
      <input
        ref={fileRef}
        type="file"
        accept="audio/*"
        multiple
        className="hidden"
        onChange={(event) => {
          const files = Array.from(event.target.files ?? []).slice(0, 3)
          if (files.length) void prepareClone(files)
        }}
      />
      <button
        type="button"
        disabled={!consented || busy !== null}
        onClick={() => fileRef.current?.click()}
        className="st-btn w-full py-2 text-[11px]"
      >
        {uploadPct !== null ? `Sample upload ${uploadPct}%` : '+ নতুন voice version (১–৩ sample)'}
      </button>

      {cloneDraft && (
        <div className="rounded-xl border border-[#E07A5F]/30 bg-[#E07A5F]/[0.08] p-3">
          <p className="text-[11px] font-bold text-cream">Provider ও খরচ নিশ্চিত করুন</p>
          <p className="mt-1 text-[10px] text-muted">{cloneDraft.estimate.provider}</p>
          <p className="text-lg font-extrabold text-[#E07A5F]">সর্বোচ্চ ৳{cloneDraft.estimate.costBdt}</p>
          <div className="mt-2 flex gap-2">
            <button type="button" onClick={() => setCloneDraft(null)} className="st-chip flex-1 py-1.5 text-[10px]">বাতিল</button>
            <button
              type="button"
              disabled={busy !== null}
              onClick={() => void confirmClone()}
              className="st-btn flex-1 py-1.5 text-[10px]"
            >
              Consent-সহ Queue
            </button>
          </div>
        </div>
      )}

      {loading ? (
        <div className="h-16 animate-pulse rounded-xl bg-white/[0.05]" />
      ) : voices.length === 0 ? (
        <p className="rounded-lg border border-dashed border-white/10 px-3 py-3 text-center text-[10px] text-muted">
          Lifecycle voice এখনো নেই। পুরনো voice থাকলে সেটি Audio Lab-এ কাজ করবে; নতুন clone এখানে versioned হবে।
        </p>
      ) : (
        voices.map((voice) => (
          <div key={voice.id} className="space-y-2 rounded-xl border border-border-subtle bg-bg-1/40 p-2.5">
            <div className="flex items-center justify-between">
              <span className="text-[11px] font-bold text-cream">{voice.name}</span>
              <span className="text-[9px] text-muted">{voice.provider} · owner-only</span>
            </div>
            {voice.versions.map((version) => (
              <div key={version.id} className="rounded-lg bg-white/[0.04] px-2 py-2">
                <div className="flex items-center gap-2">
                  <span className="text-[10px] font-bold text-cream">v{version.version}</span>
                  <span className="min-w-0 flex-1 text-[9px] text-muted">{statusBn[version.status] ?? version.status}</span>
                  {version.status === 'ready' && (
                    <button type="button" disabled={busy !== null} onClick={() => void lifecycle(version.id, 'activate')} className="st-chip px-2 py-1 text-[9px]">
                      Activate
                    </button>
                  )}
                  {version.status === 'active' && (
                    <button type="button" disabled={busy !== null} onClick={() => void lifecycle(version.id, 'revoke')} className="st-chip px-2 py-1 text-[9px]">
                      Revoke
                    </button>
                  )}
                  {!['pending', 'deletion_pending', 'deleted'].includes(version.status) && (
                    <button
                      type="button"
                      disabled={busy !== null}
                      onClick={() => void lifecycle(version.id, 'delete')}
                      className="rounded px-2 py-1 text-[9px] font-semibold text-red-300 hover:bg-red-500/10"
                    >
                      Provider delete
                    </button>
                  )}
                </div>
                <p className="mt-1 text-[8px] text-muted">
                  Consent {new Date(version.consentRecordedAt).toLocaleString('en-BD')} · hash {version.consentSha256.slice(0, 10)}…
                </p>
              </div>
            ))}
            {voice.audits.length > 0 && (
              <details>
                <summary className="cursor-pointer text-[9px] font-semibold text-muted">Audit history ({voice.audits.length})</summary>
                <div className="mt-1 space-y-1">
                  {voice.audits.slice(0, 8).map((audit) => (
                    <p key={audit.id} className="text-[8px] text-muted">
                      {new Date(audit.createdAt).toLocaleString('en-BD')} · {audit.action}
                    </p>
                  ))}
                </div>
              </details>
            )}
          </div>
        ))
      )}
    </div>
  )
}
