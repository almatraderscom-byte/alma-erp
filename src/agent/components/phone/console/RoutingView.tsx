'use client'

/**
 * Inbound routing — which number answers as what.
 *
 * Console step 4. Until now this was a JSON blob in the `SIP_DID_MAP` env var, so adding a
 * second line meant an engineer and a redeploy.
 *
 * The DIDs we have actually received calls on are offered as one-click rows, because the
 * failure mode here is silent: a mistyped DID never matches, the row looks configured, and
 * nothing tells you until a customer reaches the wrong persona.
 */

import { useCallback, useEffect, useState } from 'react'
import { cn } from '@/lib/utils'
import type { DidRoute, RoutingPayload } from '@/agent/lib/phone-routing-types'
import { useJson } from './useJson'
import { ConsoleButton, EmptyState, ErrorNote, PageHead, Panel } from './ui'

const ENDPOINT = '/api/assistant/phone-console/routing'

export function RoutingView() {
  const { data, error, loading, reload } = useJson<RoutingPayload>(ENDPOINT)
  const [rows, setRows] = useState<DidRoute[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)

  useEffect(() => { if (data) setRows(data.dids) }, [data])

  const dirty = Boolean(data && rows && JSON.stringify(rows) !== JSON.stringify(data.dids))

  const update = useCallback((i: number, patch: Partial<DidRoute>) => {
    setRows((prev) => prev?.map((r, idx) => (idx === i ? { ...r, ...patch } : r)) ?? prev)
    setSaved(false)
  }, [])

  const save = useCallback(async () => {
    if (!rows) return
    setBusy(true)
    setProblem(null)
    try {
      const res = await fetch(ENDPOINT, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dids: rows }),
      })
      const body = (await res.json()) as { ok: boolean; error?: string }
      if (!res.ok || !body.ok) { setProblem(body.error ?? `HTTP ${res.status}`); return }
      setSaved(true)
      reload()
    } catch (err) {
      setProblem(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }, [rows, reload])

  const add = useCallback((did = '') => {
    setRows((prev) => [...(prev ?? []), { did, label: '', line: 'support', allowTransfer: true }])
    setSaved(false)
  }, [])

  const known = new Set((rows ?? []).map((r) => r.did.replace(/\D/g, '').slice(-9)))

  return (
    <>
      <PageHead
        title="ইনবাউন্ড রাউটিং"
        subtitle="কোন নম্বরে কল এলে AI কীভাবে ধরবে, আর মানুষ চাইলে কোথায় যাবে।"
        actions={<ConsoleButton href="/agent/phone-console/routing/preview">পরীক্ষা করে দেখুন</ConsoleButton>}
      />

      {error && <div className="mb-3"><ErrorNote>{error}</ErrorNote></div>}
      {loading && !data && <Panel><EmptyState>আনা হচ্ছে…</EmptyState></Panel>}

      {/* What the rules would do to a call arriving RIGHT NOW. Without this the console cannot be
          tested honestly: the owner spent an evening concluding the system was broken because he
          tested at 21:01, when the after-hours rule was quietly doing exactly its job. */}
      {data?.now && (
        <div className={cn('mb-3 rounded-2xl border px-4 py-3', data.now.open ? 'tone-green' : 'tone-amber')}>
          <p className="text-[12px] font-semibold">
            {data.now.open ? 'এখন অফিস খোলা' : 'এখন অফিস বন্ধ'} · {data.now.reason}
          </p>
          <p className="mt-1 text-[12px] leading-relaxed opacity-90">{data.now.effect}</p>
          <p className="mt-1 text-[11px] leading-relaxed opacity-75">{data.now.note}</p>
        </div>
      )}

      {data && rows && (
        <div className="space-y-3">
          <Panel title="যেসব নম্বরে কল আসে">
            <p className="mb-3 text-[12px] leading-relaxed text-muted">
              তালিকায় না থাকা যেকোনো নম্বর ডিফল্ট নিয়মে চলবে — AI ব্যবসার সহকারী হিসেবে ধরবে।
              তাই কিছু না লিখলেও কিছু ভাঙে না; এখানে শুধু সেই লাইনগুলো লিখুন যেগুলো আলাদা আচরণ করবে।
            </p>

            {rows.length === 0 && <EmptyState>কোনো আলাদা নিয়ম নেই — সব কল ডিফল্ট নিয়মে চলছে।</EmptyState>}

            <div className="space-y-3">
              {rows.map((r, i) => (
                <div key={i} className="rounded-xl border border-border-subtle bg-card/40 p-3">
                  <div className="grid gap-2 md:grid-cols-2">
                    <Field label="নম্বর (DID)">
                      <Input value={r.did} onChange={(v) => update(i, { did: v })} placeholder="09649777738" />
                    </Field>
                    <Field label="নাম">
                      <Input value={r.label} onChange={(v) => update(i, { label: v })} placeholder="সাপোর্ট" />
                    </Field>
                  </div>

                  <div className="mt-3 flex flex-wrap items-center gap-4">
                    <div>
                      <p className="mb-1 text-[11px] text-muted">কীভাবে ধরবে</p>
                      <div className="inline-flex gap-1 rounded-full border border-border-subtle bg-card/60 p-1">
                        {(['boss', 'support'] as const).map((l) => (
                          <button
                            key={l}
                            type="button"
                            onClick={() => update(i, { line: l })}
                            className={cn(
                              'rounded-full px-3 py-1.5 text-[12px] transition-colors',
                              r.line === l ? 'bg-[#E07A5F]/[0.16] font-semibold text-cream' : 'text-muted hover:text-cream',
                            )}
                          >
                            {l === 'boss' ? 'বসের লাইন' : 'সাপোর্ট লাইন'}
                          </button>
                        ))}
                      </div>
                    </div>
                    <label className="flex items-center gap-2 text-[12px] text-cream">
                      <input
                        type="checkbox"
                        checked={r.allowTransfer !== false}
                        onChange={(e) => update(i, { allowTransfer: e.target.checked })}
                        className="h-4 w-4 accent-[#E07A5F]"
                      />
                      মানুষে যুক্ত করা যাবে
                    </label>
                  </div>

                  <div className="mt-3 grid gap-2 md:grid-cols-2">
                    <Field label="এই লাইনের সাপোর্ট নম্বর (খালি = সাধারণ সেটিং)">
                      <Input value={r.forwardSupport ?? ''} onChange={(v) => update(i, { forwardSupport: v })} placeholder="(সাধারণ সেটিং)" />
                    </Field>
                    <Field label="এই লাইনের বস নম্বর (খালি = সাধারণ সেটিং)">
                      <Input value={r.forwardBoss ?? ''} onChange={(v) => update(i, { forwardBoss: v })} placeholder="(সাধারণ সেটিং)" />
                    </Field>
                  </div>

                  <button
                    type="button"
                    onClick={() => { setRows((prev) => prev?.filter((_, idx) => idx !== i) ?? prev); setSaved(false) }}
                    className="mt-3 text-[12px] text-muted hover:text-cream"
                  >
                    এই সারিটা সরাও
                  </button>
                </div>
              ))}
            </div>

            <div className="mt-3 flex flex-wrap items-center gap-2">
              <ConsoleButton onClick={() => add()}>নতুন লাইন যোগ করুন</ConsoleButton>
              {/* Disabled until something actually changed. A live inbound routing table is
                  not a thing to offer a confident-looking Save button for when the click
                  would write back exactly what is already there. */}
              <button
                type="button"
                disabled={busy || !dirty}
                onClick={() => void save()}
                className={cn(
                  'rounded-full px-4 py-1.5 text-[12px] font-semibold transition-colors',
                  dirty && !busy
                    ? 'bg-[#E07A5F] text-white hover:bg-[#E07A5F]/90'
                    : 'cursor-not-allowed border border-border-subtle bg-card/60 text-muted',
                )}
              >
                {busy ? 'সেভ হচ্ছে…' : 'সেভ করুন'}
              </button>
              {saved && <span className="text-[12px] text-emerald-500">সেভ হয়েছে — পরের কল থেকেই চালু।</span>}
            </div>

            {problem && <p className="mt-2 tone-red rounded-xl border px-3 py-2 text-[12px]">{problem}</p>}
          </Panel>

          {data.seenDids.length > 0 && (
            <Panel title="যেসব নম্বরে সত্যিই কল এসেছে">
              <p className="mb-3 text-[12px] leading-relaxed text-muted">
                আমাদের নিজের কল লগ থেকে। মনে করে টাইপ করার দরকার নেই — একটা ভুল সংখ্যা মানে
                সারিটা কখনো মিলবেই না, আর সেটা কেউ ফোন করার আগে ধরা পড়ে না।
              </p>
              <ul className="flex flex-wrap gap-1.5">
                {data.seenDids.map((d) => (
                  <li key={d.did}>
                    <button
                      type="button"
                      disabled={known.has(d.did.replace(/\D/g, '').slice(-9))}
                      onClick={() => add(d.did)}
                      className="rounded-full border border-border-subtle bg-card/60 px-3 py-1 text-[11px] text-muted transition-colors hover:border-[#E07A5F]/40 hover:text-cream disabled:opacity-40"
                    >
                      {d.did} · {d.calls}টি কল
                    </button>
                  </li>
                ))}
              </ul>
            </Panel>
          )}
        </div>
      )}
    </>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-[11px] text-muted">{label}</span>
      {children}
    </label>
  )
}

function Input({ value, onChange, placeholder }: { value: string; onChange: (v: string) => void; placeholder?: string }) {
  return (
    <input
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      spellCheck={false}
      className="w-full rounded-xl border border-border-subtle bg-card/60 px-3 py-2 text-sm text-cream placeholder:text-muted focus:border-[#E07A5F]/40 focus:outline-none"
    />
  )
}
