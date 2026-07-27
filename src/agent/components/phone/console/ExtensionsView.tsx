'use client'

/**
 * Extensions — who has a phone, whether it is connected, and what they may do with it.
 *
 * Console step 3. Until now this existed only as an API: a staff member got an extension by
 * opening the phone page, and there was no screen anywhere that could answer "who has a
 * phone", "is Karim's connected", or "stop this person dialling out".
 *
 * The password is never shown. Rotating one does not reveal the new secret either — their
 * browser picks it up the next time they open the phone page, which is the only place it is
 * ever needed. A password that is never displayed cannot be screenshotted or left on a desk.
 */

import { useCallback, useState } from 'react'
import { cn } from '@/lib/utils'
import { useJson } from './useJson'
import { ConsoleButton, EmptyState, ErrorNote, PageHead, Panel, Pill, secs } from './ui'

const ENDPOINT = '/api/assistant/phone-console/extensions'

type Extension = {
  staffId: string
  ext: string
  name: string
  role: string | null
  disabled: boolean
  dialOut: 'full' | 'mobile' | 'internal'
  dnd: boolean
  forwardTo: string
  /** null = the gateway did not report it. Unknown and disconnected are different claims. */
  registered: boolean | null
  onCall: { state: string | null; with: string | null; since: string | null } | null
  liveStateKnown: boolean
}

type Payload = {
  error: string | null
  extensions: Extension[]
  withoutPhone: Array<{ id: string; name: string; role: string }>
}

const DIAL_OUT: ReadonlyArray<{ value: Extension['dialOut']; label: string }> = [
  { value: 'full', label: 'সব দেশি নম্বর' },
  { value: 'mobile', label: 'শুধু মোবাইল' },
  { value: 'internal', label: 'শুধু ভেতরে' },
]

export function ExtensionsView() {
  const { data, error, loading, reload } = useJson<Payload>(ENDPOINT, 15_000)

  return (
    <>
      <PageHead
        title="এক্সটেনশন"
        subtitle="কার ফোন আছে, এখন যুক্ত আছে কি না, আর কে কোথায় কল করতে পারবে।"
      />

      {error && <div className="mb-3"><ErrorNote>{error}</ErrorNote></div>}
      {data?.error && <div className="mb-3"><ErrorNote>গেটওয়ে থেকে তালিকা আনা যায়নি: {data.error}</ErrorNote></div>}
      {loading && !data && <Panel><EmptyState>আনা হচ্ছে…</EmptyState></Panel>}

      {data && (
        <div className="space-y-3">
          {data.extensions.length === 0 && !data.error && (
            <Panel><EmptyState>এখনো কারো ফোন সেট করা হয়নি।</EmptyState></Panel>
          )}

          {data.extensions.map((e) => <ExtensionCard key={e.staffId} ext={e} onChanged={reload} />)}

          {data.withoutPhone.length > 0 && (
            <Panel title="যাদের এখনো ফোন নেই" badge={String(data.withoutPhone.length)}>
              <p className="mb-3 text-[12px] leading-relaxed text-muted">
                দুইভাবে হয়। নিচের বোতামে এখনই তার এক্সটেনশন বানিয়ে দিতে পারেন — অথবা সে নিজে
                ERP-তে ঢুকে ফোন পাতাটা একবার খুললেই নিজে থেকে তৈরি হয়ে যাবে। পাসওয়ার্ড কোনো
                অবস্থাতেই দেখানো হয় না; তার ব্রাউজার ফোন পাতা খোলার সময় নিজেই নিয়ে নেয়।
              </p>
              <ul className="space-y-1.5">
                {data.withoutPhone.map((u) => (
                  <CreateRow key={u.id} user={u} onCreated={reload} />
                ))}
              </ul>
              <div className="mt-3">
                <CopyLink />
              </div>
            </Panel>
          )}
        </div>
      )}
    </>
  )
}

function CreateRow({ user, onCreated }: { user: { id: string; name: string; role: string }; onCreated: () => void }) {
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)

  const create = useCallback(async () => {
    setBusy(true)
    setProblem(null)
    try {
      const res = await fetch(ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ staffId: user.id, action: 'create', label: user.name }),
      })
      const body = (await res.json()) as { ok: boolean; error?: string }
      if (!res.ok || !body.ok) { setProblem(body.error ?? `HTTP ${res.status}`); return }
      onCreated()
    } catch (err) {
      setProblem(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }, [user.id, user.name, onCreated])

  return (
    <li className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-border-subtle bg-card/40 px-3 py-2">
      <span className="min-w-0 text-[12px] text-cream">
        {user.name} <span className="text-muted">· {user.role}</span>
      </span>
      <span className="flex items-center gap-2">
        {problem && <span className="text-[11px] txt-neg">{problem}</span>}
        <button
          type="button"
          disabled={busy}
          onClick={() => void create()}
          className="shrink-0 rounded-full bg-[#E07A5F] px-3 py-1 text-[11px] font-semibold text-white transition-colors hover:bg-[#E07A5F]/90 disabled:opacity-50"
        >
          {busy ? 'বানাচ্ছি…' : 'ফোন বানিয়ে দাও'}
        </button>
      </span>
    </li>
  )
}

function CopyLink() {
  const [copied, setCopied] = useState(false)
  const copy = useCallback(() => {
    const url = `${window.location.origin}/agent/phone`
    void navigator.clipboard?.writeText(url).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 2500)
    })
  }, [])
  return <ConsoleButton onClick={copy}>{copied ? 'কপি হয়েছে' : 'ফোন পাতার লিংক কপি করুন'}</ConsoleButton>
}

function ExtensionCard({ ext, onChanged }: { ext: Extension; onChanged: () => void }) {
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const [forward, setForward] = useState<string | null>(null)
  const [showHistory, setShowHistory] = useState(false)

  const send = useCallback(async (patch: Record<string, unknown>) => {
    setBusy(true)
    setProblem(null)
    try {
      const res = await fetch(ENDPOINT, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ staffId: ext.staffId, label: ext.name || ext.ext, ...patch }),
      })
      const body = (await res.json()) as { ok: boolean; error?: string }
      if (!res.ok || !body.ok) { setProblem(body.error ?? `HTTP ${res.status}`); return }
      onChanged()
    } catch (err) {
      setProblem(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }, [ext.staffId, ext.name, ext.ext, onChanged])

  const act = useCallback(async (action: 'rotate' | 'remove') => {
    const ask = action === 'rotate'
      ? `${ext.name || ext.ext}-এর ফোনের পাসওয়ার্ড বদলে দেব? ওনার খোলা ফোন পাতাটা লগআউট হয়ে যাবে — আবার খুললেই নতুনটা নিয়ে নেবে।`
      : `${ext.name || ext.ext}-এর এক্সটেনশন পুরোপুরি মুছে দেব? উনি আর ERP থেকে কল ধরতে বা করতে পারবেন না।`
    if (!window.confirm(ask)) return
    setBusy(true)
    setProblem(null)
    try {
      const res = await fetch(ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ staffId: ext.staffId, action, label: ext.name || ext.ext }),
      })
      const body = (await res.json()) as { ok: boolean; error?: string }
      if (!res.ok || !body.ok) { setProblem(body.error ?? `HTTP ${res.status}`); return }
      onChanged()
    } catch (err) {
      setProblem(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }, [ext.staffId, ext.name, ext.ext, onChanged])

  // Order matters, and so does the last case: before the worker is deployed the gateway
  // reports no live state at all, and claiming "যুক্ত নেই" then would be a screen inventing
  // a fact. Step 1's whole lesson was that our own belief about the phone is not evidence.
  const state = ext.disabled
    ? <Pill tone="red">বন্ধ করা</Pill>
    : ext.onCall
      ? <Pill tone="coral">কলে আছেন{ext.onCall.with ? ` · ${ext.onCall.with}` : ''}</Pill>
      : !ext.liveStateKnown
        ? <Pill tone="slate" title="VPS-এ নতুন কোড গেলে এটা দেখা যাবে">জানা নেই</Pill>
        : ext.registered
          ? <Pill tone="green">যুক্ত আছে</Pill>
          : <Pill tone="slate">যুক্ত নেই</Pill>

  return (
    <Panel
      title={`${ext.name || 'নাম নেই'} · ${ext.ext}`}
      badge={ext.role ?? undefined}
      actions={state}
    >
      {ext.disabled ? (
        <p className="text-[12px] leading-relaxed text-muted">
          এই ফোনটা বন্ধ করা আছে — এক্সটেনশনটা Asterisk-এর কনফিগেই নেই, তাই যুক্তই হতে পারবে না।
        </p>
      ) : (
        <div className="space-y-4">
          <Row label="বাইরে কল করতে পারবে" help="চুরি যাওয়া একটা পাসওয়ার্ড দিয়ে কেউ যেন যেখানে খুশি কল করতে না পারে। আন্তর্জাতিক কল কোনো অবস্থাতেই নয়।">
            <div className="inline-flex flex-wrap gap-1 rounded-full border border-border-subtle bg-card/60 p-1">
              {DIAL_OUT.map((o) => (
                <button
                  key={o.value}
                  type="button"
                  disabled={busy}
                  onClick={() => void send({ dialOut: o.value })}
                  className={cn(
                    'rounded-full px-3 py-1.5 text-[12px] transition-colors disabled:opacity-50',
                    ext.dialOut === o.value ? 'bg-[#E07A5F]/[0.16] font-semibold text-cream shadow-sm' : 'text-muted hover:text-cream',
                  )}
                >
                  {o.label}
                </button>
              ))}
            </div>
          </Row>

          <Row label="বিরক্ত করবেন না" help="চালু থাকলে ভেতর থেকে কেউ এই এক্সটেনশনে কল করলে ব্যস্ত পাবে। বাইরের কলে এর প্রভাব নেই।">
            <Toggle on={ext.dnd} busy={busy} onChange={(v) => void send({ dnd: v })} />
          </Row>

          <Row label="না ধরলে মোবাইলে" help="ব্রাউজার ফোন ২০ সেকেন্ড বেজে কেউ না ধরলে এই নম্বরে যাবে। খালি রাখলে কোথাও যাবে না।">
            <div className="flex flex-wrap items-center gap-2">
              <input
                value={forward ?? ext.forwardTo}
                onChange={(e) => setForward(e.target.value)}
                inputMode="tel"
                placeholder="01XXXXXXXXX"
                className="w-44 rounded-xl border border-border-subtle bg-card/60 px-3 py-2 text-sm text-cream placeholder:text-muted focus:border-[#E07A5F]/40 focus:outline-none"
              />
              {forward != null && forward !== ext.forwardTo && (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => { void send({ forwardTo: forward }); setForward(null) }}
                  className="rounded-full bg-[#E07A5F] px-4 py-1.5 text-[12px] font-semibold text-white disabled:opacity-50"
                >
                  সেভ
                </button>
              )}
            </div>
          </Row>
        </div>
      )}

      <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-border-subtle pt-3">
        <ConsoleButton onClick={() => setShowHistory((v) => !v)}>
          {showHistory ? 'কল লুকাও' : 'এর কলগুলো'}
        </ConsoleButton>
        <ConsoleButton onClick={() => void send({ disabled: !ext.disabled })}>
          {ext.disabled ? 'আবার চালু করো' : 'ফোন বন্ধ করো'}
        </ConsoleButton>
        <ConsoleButton onClick={() => void act('rotate')}>পাসওয়ার্ড বদলাও</ConsoleButton>
        <ConsoleButton onClick={() => void act('remove')}>মুছে ফেলো</ConsoleButton>
      </div>

      {problem && <p className="mt-2 tone-red rounded-xl border px-3 py-2 text-[12px]">{problem}</p>}
      {showHistory && <ExtensionHistory ext={ext.ext} />}
    </Panel>
  )
}

function Row({ label, help, children }: { label: string; help: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="text-[12px] font-medium text-cream">{label}</p>
      <p className="mb-2 text-[11px] leading-relaxed text-muted">{help}</p>
      {children}
    </div>
  )
}

/**
 * The knob carries a border and a shadow rather than relying on being white: this app runs a
 * light theme off `data-theme`, and a white circle on a near-white card is an invisible
 * control — which is exactly how it rendered on the first pass.
 */
function Toggle({ on, busy, onChange }: { on: boolean; busy: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      disabled={busy}
      onClick={() => onChange(!on)}
      className={cn(
        'relative h-6 w-11 rounded-full border transition-colors disabled:opacity-50',
        on ? 'border-[#E07A5F] bg-[#E07A5F]' : 'border-border-subtle bg-muted/25',
      )}
    >
      <span
        className={cn(
          'absolute top-[3px] h-[18px] w-[18px] rounded-full border shadow-sm transition-all',
          on ? 'left-[23px] border-white bg-white' : 'left-[3px] border-border-subtle bg-card',
        )}
      />
    </button>
  )
}

function ExtensionHistory({ ext }: { ext: string }) {
  const { data, loading } = useJson<{ rows: Array<{ direction: string; other: string; at: string | null; seconds: number; answered: boolean }>; error: string | null }>(
    `/api/assistant/phone-console/extensions/history?ext=${ext}`,
  )

  return (
    <div className="mt-3 rounded-xl border border-border-subtle bg-card/40 p-3">
      {loading && <p className="text-[12px] text-muted">আনা হচ্ছে…</p>}
      {data?.error && <p className="text-[12px] text-muted">{data.error}</p>}
      {data && !data.error && data.rows.length === 0 && <p className="text-[12px] text-muted">সাম্প্রতিক কোনো কল নেই।</p>}
      {data && data.rows.length > 0 && (
        <>
          <ul className="space-y-1">
            {data.rows.map((r, i) => (
              <li key={i} className="flex items-baseline justify-between gap-3 text-[12px]">
                <span className="min-w-0 truncate text-cream">
                  <span className={r.direction === 'inbound' ? 'txt-pos' : 'text-[#E07A5F]'}>
                    {r.direction === 'inbound' ? '↙' : '↗'}
                  </span>{' '}
                  {r.other || 'অজানা'}
                </span>
                <span className="shrink-0 tabular-nums text-muted">
                  {r.answered ? secs(r.seconds) : 'ধরেনি'} · {r.at ?? ''}
                </span>
              </li>
            ))}
          </ul>
          <p className="mt-2 text-[11px] text-muted">
            এগুলো Asterisk-এর নিজের কল-লগ থেকে। স্টাফের কল আমরা রেকর্ড করি না — শুধু AI-এর কল
            রেকর্ড হয় — তাই এখানে শোনার কিছু নেই।
          </p>
        </>
      )}
    </div>
  )
}
