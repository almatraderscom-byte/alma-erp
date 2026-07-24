'use client'

import { StudioConfirmationDialog } from '@/agent/components/creative-studio/StudioUi'
import { VoiceLibrary } from '@/agent/components/creative-studio/VoiceLibrary'
import {
  estimateAudioJob,
  fetchAudioLabStatus,
  queueAudioJob,
  uploadAudioFile,
  type AudioJobEstimate,
  type AudioLabStatus,
} from '@/agent/components/creative-studio/studio-api'
import { cn } from '@/lib/utils'
import { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'react-hot-toast'

export function AudioLabView() {
  const [status, setStatus] = useState<AudioLabStatus | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [musicStyle, setMusicStyle] = useState('celebration')
  const [musicLine, setMusicLine] = useState('')
  const [musicSec, setMusicSec] = useState(30)
  const [occasion, setOccasion] = useState('birthday')
  const [wishName, setWishName] = useState('')
  const [voiceText, setVoiceText] = useState('')
  const [sfxText, setSfxText] = useState('')
  const [dubLanguage, setDubLanguage] = useState('bn')
  const [dubSeconds, setDubSeconds] = useState(30)
  const [changeSeconds, setChangeSeconds] = useState(30)
  const [pct, setPct] = useState<number | null>(null)
  const [confirmation, setConfirmation] = useState<{
    label: string
    body: Record<string, unknown>
    estimate: AudioJobEstimate
    capBdt: number
  } | null>(null)
  const noteRef = useRef<HTMLInputElement>(null)
  const dubRef = useRef<HTMLInputElement>(null)
  const changeRef = useRef<HTMLInputElement>(null)

  const refreshStatus = useCallback(() => {
    void fetchAudioLabStatus()
      .then(setStatus)
      .catch(() => {})
  }, [])

  useEffect(() => {
    refreshStatus()
  }, [refreshStatus])

  const run = useCallback((label: string, body: Record<string, unknown>) => {
    setBusy(label)
    void estimateAudioJob(body)
      .then((estimate) =>
        setConfirmation({
          label,
          body,
          estimate,
          capBdt: estimate.maxCostBdt,
        }),
      )
      .catch((e) => toast.error(e instanceof Error ? e.message : 'হয়নি'))
      .finally(() => setBusy(null))
  }, [])

  const confirmRun = useCallback(() => {
    if (!confirmation) return
    const { body, estimate, label, capBdt } = confirmation
    setBusy(label)
    void queueAudioJob(body, {
      confirmedCostBdt: estimate.costBdt,
      costCapBdt: capBdt,
    })
      .then((result) => {
        setConfirmation(null)
        toast.success(`${label} তৈরি হচ্ছে (সর্বোচ্চ ৳${result.costBdt}) — Gallery-তে আসবে, বস`)
      })
      .catch((error) => toast.error(error instanceof Error ? error.message : 'হয়নি'))
      .finally(() => setBusy(null))
  }, [confirmation])

  const card = 'space-y-2 st-card p-3'
  const input = 'w-full rounded-lg border border-border-subtle bg-bg-1 px-2.5 py-2 text-[12px] text-cream placeholder:text-muted/50'
  const btn = 'st-btn px-4 py-2 text-[12px]'

  return (
    <div className="px-3 py-3 pb-20 md:pb-4">
      <div className="mx-auto max-w-xl space-y-3">
        <div>
          <h2 className="text-sm font-bold">🎙️ অডিও ল্যাব</h2>
          <p className="text-[11px] text-muted">মিউজিক, উইশ গান, আপনার ভয়েস — Queue করার আগে খরচ ও সর্বোচ্চ সীমা নিশ্চিত করতে হবে।</p>
        </div>

        <StudioConfirmationDialog
          open={Boolean(confirmation)}
          ariaLabel="অডিও খরচ নিশ্চিত করুন"
          title="খরচ নিশ্চিত করুন"
          summary={confirmation?.estimate.summary}
          cancelLabel="বাতিল"
          confirmLabel={busy ? 'Queue হচ্ছে…' : `৳${confirmation?.estimate.costBdt ?? 0} পর্যন্ত চালান`}
          onCancel={() => setConfirmation(null)}
          onConfirm={confirmRun}
          confirmDisabled={busy !== null || !confirmation || confirmation.estimate.costBdt > confirmation.capBdt}
        >
          {confirmation && (
            <>
              <div className="mt-3 rounded-xl bg-[#E07A5F]/10 p-3 text-center">
                <p className="text-[10px] text-muted">সর্বোচ্চ আনুমানিক খরচ</p>
                <p className="text-2xl font-extrabold text-[#E07A5F]">৳{confirmation.estimate.costBdt}</p>
                <p className="text-[9px] text-muted">
                  {confirmation.estimate.provider} · চূড়ান্ত provider charge কম হতে পারে; এই সীমার বেশি Queue হবে না।
                </p>
              </div>
              <label className="mt-3 block space-y-1 text-[10px] font-semibold text-muted">
                এই run-এর hard cap (৳)
                <input
                  type="number"
                  min={1}
                  max={5000}
                  step={1}
                  value={confirmation.capBdt}
                  onChange={(event) =>
                    setConfirmation({
                      ...confirmation,
                      capBdt: Math.max(1, Math.min(5000, Math.round(Number(event.target.value) || 1))),
                    })
                  }
                  className="w-full rounded-lg border border-border-subtle bg-bg-1 px-3 py-2 text-[12px] text-cream"
                />
              </label>
              {confirmation.estimate.costBdt > confirmation.capBdt && (
                <p className="mt-2 rounded-lg bg-red-500/10 px-2.5 py-2 text-[10px] font-semibold text-red-300">
                  Estimate hard cap-এর চেয়ে বেশি—cap বাড়ান বা বাতিল করুন।
                </p>
              )}
            </>
          )}
        </StudioConfirmationDialog>

        <VoiceLibrary onChanged={refreshStatus} />

        {/* text → music */}
        <div className={card}>
          <p className="text-[12px] font-bold text-cream">🎵 মিউজিক বানাও</p>
          <div className="flex gap-1.5">
            {(status?.styles ?? []).map((st) => (
              <button
                key={st.id}
                type="button"
                onClick={() => setMusicStyle(st.id)}
                className={cn('rounded-lg px-2.5 py-1.5 text-[11px] font-semibold', musicStyle === st.id ? 'st-chip-on' : 'st-chip')}
              >
                {st.labelBn}
              </button>
            ))}
          </div>
          <input
            value={musicLine}
            onChange={(e) => setMusicLine(e.target.value)}
            placeholder="মুড/থিম এক লাইনে (ঐচ্ছিক)"
            className={input}
          />
          <div className="flex items-center gap-2">
            {[30, 60].map((s2) => (
              <button
                key={s2}
                type="button"
                onClick={() => setMusicSec(s2)}
                className={cn('rounded-lg px-3 py-1.5 text-[11px] font-semibold', musicSec === s2 ? 'st-chip-on' : 'st-chip')}
              >
                {s2}s
              </button>
            ))}
            <button
              type="button"
              disabled={busy !== null}
              className={btn}
              onClick={() =>
                run('মিউজিক', {
                  kind: 'music',
                  styleId: musicStyle,
                  line: musicLine,
                  seconds: musicSec,
                })
              }
            >
              বানাও
            </button>
          </div>
        </div>

        {/* wish song */}
        <div className={card}>
          <p className="text-[12px] font-bold text-cream">🎁 উইশ গান (ফিক্সড লিরিক — শুধু নাম বসে)</p>
          <div className="flex gap-1.5">
            {(status?.occasions ?? []).map((o) => (
              <button
                key={o.id}
                type="button"
                onClick={() => setOccasion(o.id)}
                className={cn('rounded-lg px-2.5 py-1.5 text-[11px] font-semibold', occasion === o.id ? 'st-chip-on' : 'st-chip')}
              >
                {o.labelBn}
              </button>
            ))}
          </div>
          <div className="flex gap-2">
            <input value={wishName} onChange={(e) => setWishName(e.target.value)} placeholder="নাম" className={input} />
            <button
              type="button"
              disabled={busy !== null || !wishName.trim()}
              className={btn}
              onClick={() =>
                run('উইশ গান', {
                  kind: 'wish_song',
                  occasionId: occasion,
                  name: wishName,
                  seconds: 30,
                })
              }
            >
              বানাও
            </button>
          </div>
        </div>

        {/* owner voice */}
        <div className={card}>
          <p className="text-[12px] font-bold text-cream">🎙️ আমার ভয়েসে বলাও</p>
          <textarea
            value={voiceText}
            onChange={(e) => setVoiceText(e.target.value.slice(0, 600))}
            rows={2}
            placeholder="যা বলাতে চান লিখুন…"
            className={input}
          />
          <button
            type="button"
            disabled={busy !== null || !voiceText.trim() || !status?.voiceCloned}
            className={btn}
            onClick={() => run('ভয়েস লাইন', { kind: 'owner_voice', text: voiceText })}
          >
            {status?.voiceCloned ? 'বলাও' : 'আগে ভয়েস ক্লোন করুন'}
          </button>
        </div>

        {/* dubbing */}
        <div className={card}>
          <p className="text-[12px] font-bold text-cream">🌐 Dubbing</p>
          <p className="text-[10px] text-muted">
            Provider: ElevenLabs Dubbing · source voice clone বন্ধ থাকে · Queue করার আগে $1 ceiling-এর ভেতরে estimate দেখাবে।
          </p>
          <div className="flex gap-2">
            <select
              value={dubLanguage}
              onChange={(event) => setDubLanguage(event.target.value)}
              className={input}
            >
              <option value="bn">বাংলা</option>
              <option value="en">English</option>
              <option value="hi">हिन्दी</option>
              <option value="ar">العربية</option>
            </select>
            <select value={dubSeconds} onChange={(event) => setDubSeconds(Number(event.target.value))} className={input}>
              {[30, 60, 120].map((seconds) => <option key={seconds} value={seconds}>{seconds}s</option>)}
            </select>
          </div>
          <input
            ref={dubRef}
            type="file"
            accept="audio/*"
            className="hidden"
            onChange={(event) => {
              const file = event.target.files?.[0]
              if (!file) return
              setPct(0)
              void uploadAudioFile(file, setPct)
                .then((sourcePath) => run('Dubbing', {
                  kind: 'dub',
                  sourcePath,
                  targetLanguage: dubLanguage,
                  seconds: dubSeconds,
                }))
                .catch((err) => toast.error(err instanceof Error ? err.message : 'Dubbing upload ব্যর্থ'))
                .finally(() => {
                  setPct(null)
                  if (dubRef.current) dubRef.current.value = ''
                })
            }}
          />
          <button type="button" disabled={busy !== null || pct !== null} onClick={() => dubRef.current?.click()} className={btn}>
            {pct !== null ? `Upload ${pct}%` : 'Audio দিন ও estimate দেখুন'}
          </button>
        </div>

        {/* voice changer */}
        <div className={card}>
          <p className="text-[12px] font-bold text-cream">🎭 Voice changer → Active owner voice</p>
          <p className="text-[10px] text-muted">
            Provider: ElevenLabs Voice Changer · emotion/timing থাকবে, voice হবে active owner-only version।
          </p>
          <div className="flex items-center gap-2">
            {[15, 30, 60].map((seconds) => (
              <button
                key={seconds}
                type="button"
                onClick={() => setChangeSeconds(seconds)}
                className={cn('rounded-lg px-3 py-1.5 text-[11px]', changeSeconds === seconds ? 'st-chip-on' : 'st-chip')}
              >
                {seconds}s
              </button>
            ))}
          </div>
          <input
            ref={changeRef}
            type="file"
            accept="audio/*"
            className="hidden"
            onChange={(event) => {
              const file = event.target.files?.[0]
              if (!file) return
              setPct(0)
              void uploadAudioFile(file, setPct)
                .then((sourcePath) => run('Voice changer', {
                  kind: 'voice_change',
                  sourcePath,
                  voiceVersionId: status?.activeVoiceVersionId,
                  seconds: changeSeconds,
                }))
                .catch((err) => toast.error(err instanceof Error ? err.message : 'Voice-change upload ব্যর্থ'))
                .finally(() => {
                  setPct(null)
                  if (changeRef.current) changeRef.current.value = ''
                })
            }}
          />
          <button
            type="button"
            disabled={busy !== null || pct !== null || !status?.activeVoiceVersionId}
            onClick={() => changeRef.current?.click()}
            className={btn}
          >
            {status?.activeVoiceVersionId ? 'Audio দিন ও estimate দেখুন' : 'আগে lifecycle voice Active করুন'}
          </button>
        </div>

        {/* clean voice note */}
        <div className={card}>
          <p className="text-[12px] font-bold text-cream">🎧 ভয়েস নোট → স্টুডিও কোয়ালিটি</p>
          <input
            ref={noteRef}
            type="file"
            accept="audio/*"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0]
              if (!f) return
              setPct(0)
              void uploadAudioFile(f, setPct)
                .then((path) =>
                  run('ভয়েস ক্লিনআপ', {
                    kind: 'clean_voice',
                    sourcePath: path,
                  }),
                )
                .catch((err) => toast.error(err instanceof Error ? err.message : 'আপলোড ব্যর্থ'))
                .finally(() => {
                  setPct(null)
                  if (noteRef.current) noteRef.current.value = ''
                })
            }}
          />
          <button type="button" disabled={busy !== null || pct !== null} onClick={() => noteRef.current?.click()} className={btn}>
            {pct !== null ? `আপলোড ${pct}%` : 'ভয়েস নোট দিন'}
          </button>
        </div>

        {/* sfx */}
        <div className={card}>
          <p className="text-[12px] font-bold text-cream">🔊 সাউন্ড ইফেক্ট (রিলের জন্য)</p>
          <div className="flex gap-2">
            <input
              value={sfxText}
              onChange={(e) => setSfxText(e.target.value)}
              placeholder="যেমন: whoosh, চুড়ির টুংটাং"
              className={input}
            />
            <button
              type="button"
              disabled={busy !== null || !sfxText.trim()}
              className={btn}
              onClick={() => run('SFX', { kind: 'sfx', text: sfxText, seconds: 3 })}
            >
              বানাও
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
