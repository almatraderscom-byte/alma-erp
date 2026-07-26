'use client'

/**
 * Hold audio — the recording a caller hears while the AI hunts for a human.
 *
 * Today this takes SSH, two ffmpeg commands by hand, an edit to `musiconhold.conf` and a
 * module unload/load, because a plain `moh reload` reports success and silently does nothing
 * (trap #16). This page is that whole sequence behind one file picker, and it shows each step
 * with its own tick — the reload is the exact step that has lied before, so it is proven by
 * `moh show classes` and reported rather than assumed.
 *
 * It refuses while a call is up. Unloading music-on-hold mid-call cuts the audio out from
 * under whoever is listening to it, and no hold tune is worth a customer's line going quiet.
 */

import { useCallback, useRef, useState } from 'react'
import type { HoldAudioState } from '@/agent/lib/phone-settings-types'
import { SettingsView } from './SettingsView'
import { useJson } from './useJson'
import { EmptyState, ErrorNote, Panel } from './ui'

const ENDPOINT = '/api/assistant/phone-console/settings/hold'

type Step = { step: string; ok: boolean; detail: string }

const STEP_BN: Record<string, string> = {
  convert: 'ফাইল রূপান্তর (৮ kHz মনো)',
  'declare-class': 'ক্লাস ঘোষণা',
  reload: 'Asterisk-এ লোড ও যাচাই',
  rollback: 'আগেরটা ফিরিয়ে আনা',
}

export function HoldAudioView() {
  const { data, error, loading, reload } = useJson<{ hold: HoldAudioState }>(ENDPOINT)
  const hold = data?.hold
  const fileRef = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState(false)
  const [steps, setSteps] = useState<Step[]>([])
  const [problem, setProblem] = useState<string | null>(null)
  const [done, setDone] = useState(false)

  const upload = useCallback(async (file: File) => {
    setBusy(true)
    setProblem(null)
    setSteps([])
    setDone(false)
    try {
      const form = new FormData()
      form.append('file', file)
      const res = await fetch(ENDPOINT, { method: 'POST', body: form })
      const body = (await res.json()) as { ok: boolean; error?: string; steps?: Step[] }
      setSteps(body.steps ?? [])
      if (!res.ok || !body.ok) { setProblem(body.error ?? `HTTP ${res.status}`); return }
      setDone(true)
      reload()
    } catch (err) {
      setProblem(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
      if (fileRef.current) fileRef.current.value = ''
    }
  }, [reload])

  return (
    <>
      <SettingsView group="hold" />

      <div className="mt-3 space-y-3">
        <Panel title="এখন কী বাজছে" badge={hold?.liveClass ? 'লোড হয়ে আছে' : 'লোড নেই'}>
          {loading && !data && <EmptyState>আনা হচ্ছে…</EmptyState>}
          {error && <ErrorNote>গেটওয়ে থেকে আনা যায়নি: {error}</ErrorNote>}
          {hold?.error && <ErrorNote>{hold.error}</ErrorNote>}

          {hold && !hold.error && (
            <>
              <p className="text-[12px] text-muted">
                {hold.liveClass
                  ? <>Asterisk এই মুহূর্তে <span className="font-semibold text-cream">{hold.liveClass}</span> ক্লাসটা লোড করে রেখেছে — এটাই বাজবে।</>
                  : 'আপনার নিজের কোনো হোল্ড অডিও লোড নেই — এখন Asterisk-এর নিজের বাঁধা সুর বাজে।'}
              </p>
              {hold.files.length > 0 && (
                <ul className="mt-3 space-y-1">
                  {hold.files.map((f) => (
                    <li key={f.name} className="flex items-baseline justify-between gap-3 text-[12px]">
                      <span className="truncate text-cream">{f.name}</span>
                      <span className="shrink-0 tabular-nums text-muted">
                        {f.seconds != null ? `${f.seconds} সেকেন্ড · ` : ''}{Math.round(f.bytes / 1024)} KB
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
        </Panel>

        <Panel title="নতুন রেকর্ডিং দিন">
          <p className="mb-3 text-[12px] leading-relaxed text-muted">
            যেকোনো ফরম্যাট চলবে (mp3, m4a, wav) — সার্ভার নিজেই ফোন লাইনের ফরম্যাটে বদলে নেবে।
            ১৫–৩০ সেকেন্ডের রেকর্ডিং ভালো, কারণ এটা লুপ হয়ে বাজে। সর্বোচ্চ ৮ MB।
          </p>

          {hold?.busy && (
            <p className="mb-3 tone-amber rounded-xl border px-3 py-2 text-[12px]">
              এখন লাইনে কল চলছে। বদলানোর সময় Asterisk-এর হোল্ড মডিউল একবার বন্ধ-চালু হয়, তাই
              যিনি হোল্ডে আছেন তার সুর কেটে যেত। কল শেষ হলে আবার চেষ্টা করুন।
            </p>
          )}

          <input
            ref={fileRef}
            type="file"
            accept="audio/*"
            disabled={busy || hold?.busy}
            onChange={(e) => { const f = e.target.files?.[0]; if (f) void upload(f) }}
            className="block w-full text-[12px] text-muted file:mr-3 file:rounded-full file:border-0 file:bg-[#E07A5F] file:px-4 file:py-1.5 file:text-[12px] file:font-semibold file:text-white hover:file:bg-[#E07A5F]/90 disabled:opacity-50"
          />
          {busy && <p className="mt-3 text-[12px] text-muted">পাঠানো হচ্ছে, রূপান্তর ও লোড হচ্ছে — এক মিনিট পর্যন্ত লাগতে পারে…</p>}

          {steps.length > 0 && (
            <ul className="mt-3 space-y-1.5">
              {steps.map((s, i) => (
                <li key={`${s.step}-${i}`} className="flex items-start gap-2 text-[12px]">
                  <span className={s.ok ? 'text-emerald-500' : 'text-red-500'}>{s.ok ? '✓' : '✕'}</span>
                  <span className="min-w-0">
                    <span className="text-cream">{STEP_BN[s.step] ?? s.step}</span>
                    <span className="text-muted"> — {s.detail}</span>
                  </span>
                </li>
              ))}
            </ul>
          )}

          {done && <p className="mt-3 text-[12px] text-emerald-500">হয়ে গেছে — পরের ট্রান্সফার থেকেই নতুন সুরটা বাজবে।</p>}
          {problem && <p className="mt-3 tone-red rounded-xl border px-3 py-2 text-[12px]">{problem}</p>}
        </Panel>
      </div>
    </>
  )
}
