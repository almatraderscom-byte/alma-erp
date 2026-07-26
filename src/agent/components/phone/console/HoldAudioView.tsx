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
type Slot = {
  slot: 'transfer' | 'welcome'
  cls: string
  live: boolean
  files: Array<{ name: string; seconds: number | null; bytes: number }>
}

const SLOT_TEXT: Record<Slot['slot'], { title: string; blurb: string }> = {
  welcome: {
    title: 'শুরুর সুর',
    blurb: 'অচেনা নম্বর থেকে কল এলে টিমের ফোন যতক্ষণ বাজে, ততক্ষণ কলদাতা এটাই শোনে। এটা লুপ হয়ে বাজে, তাই “আর একটু পরেই” জাতীয় সময়ের কথা এড়িয়ে যান — তৃতীয়বার বাজলে অস্বস্তিকর শোনায়।',
  },
  transfer: {
    title: 'ট্রান্সফারের সুর',
    blurb: 'AI যখন মানুষে যুক্ত করছে, তখন এটা বাজে। মনে রাখবেন কেউ না ধরলে কলটা AI-র কাছেই ফিরে আসে, তাই “যুক্ত হয়ে গেছে” বলে ফেলবেন না।',
  },
}

const STEP_BN: Record<string, string> = {
  convert: 'ফাইল রূপান্তর (৮ kHz মনো)',
  'declare-class': 'ক্লাস ঘোষণা',
  reload: 'Asterisk-এ লোড ও যাচাই',
  rollback: 'আগেরটা ফিরিয়ে আনা',
}

export function HoldAudioView() {
  const { data, error, loading, reload } = useJson<{ hold: HoldAudioState & { slots?: Slot[] } }>(ENDPOINT)
  const hold = data?.hold

  // A gateway on the previous build reports no `slots` at all, so fall back to the single
  // transfer tune it does know about rather than showing the owner an empty page.
  const slots: Slot[] = hold?.slots?.length
    ? hold.slots
    : hold
      ? [{ slot: 'transfer', cls: hold.liveClass ?? 'alma-hold', live: Boolean(hold.liveClass), files: hold.files }]
      : []

  return (
    <>
      <SettingsView group="hold" />

      <div className="mt-3 space-y-3">
        {loading && !data && <Panel><EmptyState>আনা হচ্ছে…</EmptyState></Panel>}
        {error && <ErrorNote>গেটওয়ে থেকে আনা যায়নি: {error}</ErrorNote>}
        {hold?.error && <ErrorNote>{hold.error}</ErrorNote>}

        {hold?.busy && (
          <p className="tone-amber rounded-xl border px-3 py-2 text-[12px]">
            এখন লাইনে কল চলছে। সুর বদলানোর সময় Asterisk-এর হোল্ড মডিউল একবার বন্ধ-চালু হয়, তাই
            যিনি হোল্ডে আছেন তার সুর কেটে যেত। কল শেষ হলে আবার চেষ্টা করুন।
          </p>
        )}

        {!hold?.error && slots.map((s) => (
          <SlotCard key={s.slot} slot={s} busy={Boolean(hold?.busy)} onDone={reload} />
        ))}
      </div>
    </>
  )
}

function SlotCard({ slot, busy, onDone }: { slot: Slot; busy: boolean; onDone: () => void }) {
  const fileRef = useRef<HTMLInputElement>(null)
  const [sending, setSending] = useState(false)
  const [steps, setSteps] = useState<Step[]>([])
  const [problem, setProblem] = useState<string | null>(null)
  const [done, setDone] = useState(false)
  const text = SLOT_TEXT[slot.slot]

  const upload = useCallback(async (file: File) => {
    setSending(true)
    setProblem(null)
    setSteps([])
    setDone(false)
    try {
      const form = new FormData()
      form.append('file', file)
      form.append('slot', slot.slot)
      const res = await fetch(ENDPOINT, { method: 'POST', body: form })
      const body = (await res.json()) as { ok: boolean; error?: string; steps?: Step[] }
      setSteps(body.steps ?? [])
      if (!res.ok || !body.ok) { setProblem(body.error ?? `HTTP ${res.status}`); return }
      setDone(true)
      onDone()
    } catch (err) {
      setProblem(err instanceof Error ? err.message : String(err))
    } finally {
      setSending(false)
      if (fileRef.current) fileRef.current.value = ''
    }
  }, [slot.slot, onDone])

  return (
    <Panel title={text.title} badge={slot.live ? 'লোড হয়ে আছে' : 'লোড নেই'}>
      <p className="text-[12px] leading-relaxed text-muted">{text.blurb}</p>

      <p className="mt-3 text-[12px] text-muted">
        {slot.live
          ? <>Asterisk এই মুহূর্তে <span className="font-semibold text-cream">{slot.cls}</span> ক্লাসটা লোড করে রেখেছে — এটাই বাজবে।</>
          : <>আপনার নিজের কোনো রেকর্ডিং এখানে লোড নেই ({slot.cls})। এখন Asterisk-এর নিজের বাঁধা সুর বাজবে।</>}
      </p>

      {slot.files.length > 0 && (
        <ul className="mt-3 space-y-1">
          {slot.files.map((f) => (
            <li key={f.name} className="flex items-baseline justify-between gap-3 text-[12px]">
              <span className="truncate text-cream">{f.name}</span>
              <span className="shrink-0 tabular-nums text-muted">
                {f.seconds != null ? `${f.seconds} সেকেন্ড · ` : ''}{Math.round(f.bytes / 1024)} KB
              </span>
            </li>
          ))}
        </ul>
      )}

      <div className="mt-4 border-t border-border-subtle pt-3">
        <p className="mb-2 text-[12px] text-muted">
          যেকোনো ফরম্যাট চলবে (mp3, m4a, wav) — সার্ভার নিজেই ফোন লাইনের ফরম্যাটে বদলে নেবে।
          ১৫–৩০ সেকেন্ড ভালো। সর্বোচ্চ ৮ MB।
        </p>
        <input
          ref={fileRef}
          type="file"
          accept="audio/*"
          disabled={sending || busy}
          onChange={(e) => { const f = e.target.files?.[0]; if (f) void upload(f) }}
          className="block w-full text-[12px] text-muted file:mr-3 file:rounded-full file:border-0 file:bg-[#E07A5F] file:px-4 file:py-1.5 file:text-[12px] file:font-semibold file:text-white hover:file:bg-[#E07A5F]/90 disabled:opacity-50"
        />
      </div>

      {sending && <p className="mt-3 text-[12px] text-muted">পাঠানো হচ্ছে, রূপান্তর ও লোড হচ্ছে — এক মিনিট পর্যন্ত লাগতে পারে…</p>}

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

      {done && <p className="mt-3 text-[12px] text-emerald-500">হয়ে গেছে — পরের কল থেকেই নতুন সুরটা বাজবে।</p>}
      {problem && <p className="mt-3 tone-red rounded-xl border px-3 py-2 text-[12px]">{problem}</p>}
    </Panel>
  )
}
