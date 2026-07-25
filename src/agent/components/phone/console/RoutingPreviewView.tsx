'use client'

/**
 * "A call from 01712345678 at 21:30 would reach …"
 *
 * The roadmap asked for this by name, and it is the most useful screen in step 4 for one
 * reason: routing bugs are invisible until a customer hits them. A wrong office-hour window,
 * a holiday typed as 15/08/2026, a DID with a digit missing — none of those look wrong on
 * the settings screen. They look wrong here, on the day you change them, at the hour you
 * will never be in the office to test.
 *
 * It calls the SAME functions the live inbound route calls. Nothing on this page re-derives
 * a rule, because a preview with its own copy of the rules is the most confident liar you
 * can put in front of someone.
 */

import { useCallback, useState } from 'react'
import type { InboundDecision, OutboundDecision } from '@/agent/lib/phone-routing-types'
import { ErrorNote, PageHead, Panel, Pill } from './ui'

const ENDPOINT = '/api/assistant/phone-console/routing/preview'

type Result = {
  inbound: InboundDecision
  outbound: OutboundDecision | null
  evaluatedAt: { ymd: string; hour: number; minute: number; weekday: string }
}

const WEEKDAY_BN: Record<string, string> = {
  sun: 'রবিবার', mon: 'সোমবার', tue: 'মঙ্গলবার', wed: 'বুধবার', thu: 'বৃহস্পতিবার', fri: 'শুক্রবার', sat: 'শনিবার',
}

function todayDhaka(): string {
  return new Date(Date.now() + 6 * 3_600_000).toISOString().slice(0, 10)
}

export function RoutingPreviewView() {
  const [caller, setCaller] = useState('01712345678')
  const [did, setDid] = useState('09649777738')
  const [date, setDate] = useState(todayDhaka())
  const [at, setAt] = useState('21:30')
  const [outboundTo, setOutboundTo] = useState('')
  const [result, setResult] = useState<Result | null>(null)
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)

  const run = useCallback(async () => {
    setBusy(true)
    setProblem(null)
    try {
      const res = await fetch(ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ caller, did, date, at, outboundTo }),
      })
      const body = (await res.json()) as Result & { ok: boolean; error?: string }
      if (!res.ok || !body.ok) { setProblem(body.error ?? `HTTP ${res.status}`); return }
      setResult(body)
    } catch (err) {
      setProblem(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }, [caller, did, date, at, outboundTo])

  return (
    <>
      <PageHead
        title="রাউটিং পরীক্ষা"
        subtitle="কল করার আগেই দেখে নিন কী হবে — কোনো কল যায় না, শুধু নিয়মগুলো চালিয়ে দেখা হয়।"
      />

      <div className="space-y-3">
        <Panel title="একটা কল কল্পনা করুন">
          <div className="grid gap-3 md:grid-cols-2">
            <Field label="কে ফোন করছে">
              <Input value={caller} onChange={setCaller} placeholder="01712345678" />
            </Field>
            <Field label="কোন নম্বরে করছে (DID)">
              <Input value={did} onChange={setDid} placeholder="09649777738" />
            </Field>
            <Field label="তারিখ">
              <Input value={date} onChange={setDate} type="date" />
            </Field>
            <Field label="সময় (ঢাকা)">
              <Input value={at} onChange={setAt} type="time" />
            </Field>
            <Field label="আমরা কাকে কল করছি (ঐচ্ছিক)">
              <Input value={outboundTo} onChange={setOutboundTo} placeholder="01712345678" />
            </Field>
          </div>

          <button
            type="button"
            disabled={busy}
            onClick={() => void run()}
            className="mt-3 rounded-full bg-[#E07A5F] px-5 py-2 text-[12px] font-semibold text-white transition-colors hover:bg-[#E07A5F]/90 disabled:opacity-50"
          >
            {busy ? 'দেখছি…' : 'কী হবে দেখাও'}
          </button>

          {problem && <p className="mt-2 tone-red rounded-xl border px-3 py-2 text-[12px]">{problem}</p>}
        </Panel>

        {result && (
          <>
            <Panel
              title="যা হবে"
              badge={`${WEEKDAY_BN[result.evaluatedAt.weekday] ?? ''} ${String(result.evaluatedAt.hour).padStart(2, '0')}:${String(result.evaluatedAt.minute).padStart(2, '0')}`}
            >
              <p className="text-sm leading-relaxed text-cream">{result.inbound.outcome}</p>

              <dl className="mt-4 space-y-2">
                <Line label="সময়ের নিয়ম">
                  {result.inbound.time.open ? <Pill tone="green">অফিস খোলা</Pill> : <Pill tone="amber">অফিস বন্ধ</Pill>}
                  <span className="ml-2 text-muted">{result.inbound.time.reason}</span>
                </Line>
                <Line label="লাইন">
                  {result.inbound.route
                    ? <>{result.inbound.route.label || result.inbound.route.did} — {result.inbound.route.line === 'boss' ? 'বসের লাইন' : 'সাপোর্ট লাইন'}</>
                    : <span className="text-muted">তালিকায় নেই, ডিফল্ট নিয়ম</span>}
                </Line>
                <Line label="কলদাতা">
                  {result.inbound.owner
                    ? <Pill tone="coral">আপনি নিজে</Pill>
                    : result.inbound.blocked
                      ? <Pill tone="red">ব্লক করা</Pill>
                      : <span className="text-muted">সাধারণ কলদাতা</span>}
                </Line>
                <Line label="মানুষে যুক্ত করা">
                  {result.inbound.transferMode === 'direct'
                    ? <span>সরাসরি — {result.inbound.forwardSupport || result.inbound.forwardBoss || 'কোনো নম্বর সেট নেই'}</span>
                    : <span className="text-muted">না, আগে বার্তা নেবে</span>}
                </Line>
              </dl>
            </Panel>

            {result.outbound && (
              <Panel title="আমাদের দিক থেকে কল" badge={result.outbound.allowed ? 'যাবে' : 'যাবে না'}>
                <p className="text-[12px] leading-relaxed text-cream">
                  {result.outbound.allowed
                    ? <>আসলে ডায়াল হবে <span className="font-semibold tabular-nums">{result.outbound.dialled}</span> — {result.outbound.reason}</>
                    : <>আটকে যাবে — {result.outbound.reason}</>}
                </p>
                <p className="mt-2 text-[11px] text-muted">
                  উপরের নম্বরটাই তারের উপর যাবে। প্রিফিক্স বা কাটার নিয়ম বদলানোর পর এখানে
                  একবার দেখে নেওয়াই সবচেয়ে সস্তা পরীক্ষা।
                </p>
              </Panel>
            )}
          </>
        )}
      </div>
    </>
  )
}

function Line({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-b border-border-subtle/60 pb-2 text-[12px] last:border-0 last:pb-0">
      <dt className="w-32 shrink-0 text-muted">{label}</dt>
      <dd className="min-w-0 flex-1 text-cream">{children}</dd>
    </div>
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

function Input({
  value, onChange, placeholder, type = 'text',
}: { value: string; onChange: (v: string) => void; placeholder?: string; type?: string }) {
  return (
    <input
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      type={type}
      spellCheck={false}
      className="w-full rounded-xl border border-border-subtle bg-card/60 px-3 py-2 text-sm text-cream placeholder:text-muted focus:border-[#E07A5F]/40 focus:outline-none"
    />
  )
}
