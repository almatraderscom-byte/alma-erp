'use client'

import { useCallback, useEffect, useState } from 'react'
import toast from 'react-hot-toast'

/**
 * SK-8 — who approved the skill that ran, and how to take it back.
 *
 * The screen exists because the gate could not be switched on: with an empty
 * ledger it would disable every skill at once, and nothing could fill the
 * ledger. Approving is an owner act by design, so it is a button he presses,
 * not a script anyone can run.
 *
 * The number that matters is `needsApproval` — how many live skills would stop
 * the moment the gate goes on. It is shown at the top for exactly that reason.
 */

interface Row {
  name: string
  version: string
  status: string
  implicit: boolean
  isolation: 'inline' | 'subagent'
  hashShort: string
  state: 'approved' | 'changed' | 'revoked' | 'unapproved'
  effectiveState: 'approved' | 'changed' | 'revoked' | 'unapproved'
  wouldRun: boolean
  blockedBy: 'draft' | 'never-auto' | 'approval' | 'base' | null
  blockedByName?: string
  approval: {
    version: string
    approvedBy: string
    approvedAt: string
    note?: string
    revokedAt?: string
    revokedReason?: string
  } | null
}

interface View {
  gateOn: boolean
  engineEnabled: boolean
  rows: Row[]
  summary: { total: number; live: number; needsApproval: number; revoked: number }
}

const STATE_TAG: Record<Row['state'], { label: string; cls: string }> = {
  approved: { label: 'অনুমোদিত', cls: 'border-emerald-300/40 bg-emerald-400/10 txt-pos' },
  changed: { label: 'অনুমোদনের পর বদলেছে', cls: 'border-amber-300/40 bg-amber-400/10 txt-warn' },
  revoked: { label: 'অনুমোদন তোলা', cls: 'border-rose-300/40 bg-rose-400/10 txt-neg' },
  unapproved: { label: 'অনুমোদন নেই', cls: 'border-border-subtle bg-white/[0.02] text-muted' },
}

function blockedWhy(r: Row): string {
  switch (r.blockedBy) {
    case 'draft':
      return 'draft — router-এ আসেই না'
    case 'never-auto':
      return 'নিজে থেকে কখনো চলে না (inherit-only)'
    case 'approval':
      return 'gate আটকে রেখেছে'
    case 'base':
      return `base \`${r.blockedByName ?? '?'}\` অনুমোদিত নয়`
    default:
      return ''
  }
}

export default function SkillApprovalPanel() {
  const [view, setView] = useState<View | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/assistant/skills')
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      setView((await res.json()) as View)
    } catch {
      setView(null)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  async function act(name: string, action: 'approve' | 'revoke') {
    if (busy) return
    setBusy(name)
    try {
      const res = await fetch('/api/assistant/skills', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(
          action === 'approve'
            ? { action, name, note: 'কন্ট্রোল সেন্টার থেকে অনুমোদন' }
            : { action, name, reason: 'কন্ট্রোল সেন্টার থেকে অনুমোদন তুলে নেওয়া' },
        ),
      })
      const data = (await res.json().catch(() => ({}))) as Partial<View> & { error?: string }
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`)
      if (data.rows) setView(data as View)
      toast.success(action === 'approve' ? `${name} অনুমোদিত ✅` : `${name} বন্ধ 🔴`)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="safe-x mx-auto w-full max-w-5xl px-4 pt-4 md:px-6">
      <div className="alma-frost overflow-hidden rounded-[18px]">
        <div className="flex items-center gap-2 px-4 pt-4">
          <span className="text-[15px]">🧾</span>
          <h2 className="text-[15px] font-bold text-cream">Skill অনুমোদন</h2>
          <span className="ml-auto rounded-full border border-border-subtle bg-white/[0.02] px-2 py-0.5 text-[10px] text-muted">
            মালিক নিয়ন্ত্রণ
          </span>
        </div>
        <p className="px-4 pb-3 pt-1 text-[12px] leading-relaxed text-muted">
          কোন version কে অনুমোদন করেছে, আর যেকোনো সময় সেটা তুলে নেওয়া। অনুমোদন দেওয়া হয়
          এখন disk-এ থাকা হুবহু content-কে — ফাইল বদলালে আবার অনুমোদন লাগবে।
        </p>

        {/* The two switches this screen is about */}
        <div className="flex flex-wrap items-center gap-2 border-t border-border-subtle px-4 py-2.5">
          <Pill on={view?.engineEnabled === true} label="Skill engine" />
          <Pill on={view?.gateOn === true} label="অনুমোদন gate" />
          {view && (
            <span className="ml-auto text-[11px] text-muted">
              চলছে {view.summary.live} · অনুমোদন বাকি{' '}
              <b className={view.summary.needsApproval > 0 ? 'txt-warn' : 'text-cream'}>
                {view.summary.needsApproval}
              </b>
              {view.summary.revoked > 0 ? ` · তোলা ${view.summary.revoked}` : ''}
            </span>
          )}
        </div>

        {view && !view.gateOn && view.summary.needsApproval > 0 && (
          <p className="border-t border-border-subtle bg-amber-400/[0.06] px-4 py-2 text-[11.5px] leading-snug txt-warn">
            gate এখন বন্ধ — তাই অনুমোদন ছাড়াও সব চলছে। এখনই চালু করলে{' '}
            {view.summary.needsApproval}টা skill একসাথে বন্ধ হয়ে যাবে।
          </p>
        )}

        <div className="border-t border-border-subtle px-4 pb-4 pt-1.5">
          {loading && <p className="py-2 text-[12px] text-muted">লোড হচ্ছে…</p>}
          {!loading && !view && <p className="py-2 text-[12px] text-muted">Skill তালিকা আনা যায়নি।</p>}
          {view?.rows.map((r) => (
            <div key={r.name} className="flex items-center justify-between gap-3 border-b border-border-subtle/50 py-2.5 last:border-0">
              <div className="min-w-0">
                <p className="flex flex-wrap items-center gap-1.5 text-[13px] font-medium text-cream">
                  <span className="truncate">{r.name}</span>
                  <span className="shrink-0 text-[10px] text-muted">v{r.version}</span>
                  {r.isolation === 'subagent' && (
                    <span className="shrink-0 rounded-full border border-sky-300/40 bg-sky-400/10 px-1.5 py-0.5 text-[9.5px] txt-info">
                      isolated
                    </span>
                  )}
                  <span className={`shrink-0 rounded-full border px-1.5 py-0.5 text-[9.5px] ${STATE_TAG[r.state].cls}`}>
                    {STATE_TAG[r.state].label}
                  </span>
                </p>
                <p className="mt-0.5 truncate text-[11px] text-muted">
                  <span className="font-mono">{r.hashShort}</span>
                  {r.approval && !r.approval.revokedAt && (
                    <> · {r.approval.approvedBy} · {new Date(r.approval.approvedAt).toLocaleDateString('en-GB')}</>
                  )}
                  {r.blockedBy && <> · {blockedWhy(r)}</>}
                  {!r.blockedBy && r.wouldRun && <> · চালু</>}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-1.5">
                <button
                  type="button"
                  disabled={busy !== null || r.state === 'approved'}
                  onClick={() => void act(r.name, 'approve')}
                  className="rounded-full border border-emerald-300/40 bg-emerald-400/10 px-2.5 py-1 text-[11px] font-semibold txt-pos transition-colors hover:bg-emerald-400/20 disabled:opacity-35"
                >
                  {r.state === 'changed' ? 'নতুন version অনুমোদন' : 'অনুমোদন'}
                </button>
                <button
                  type="button"
                  disabled={busy !== null || !r.approval || r.state === 'revoked'}
                  onClick={() => void act(r.name, 'revoke')}
                  className="rounded-full border border-rose-300/40 bg-rose-400/10 px-2.5 py-1 text-[11px] font-semibold txt-neg transition-colors hover:bg-rose-400/20 disabled:opacity-35"
                >
                  তুলে নাও
                </button>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

function Pill({ on, label }: { on: boolean; label: string }) {
  return (
    <span
      className={`rounded-full border px-2 py-0.5 text-[10.5px] font-semibold ${
        on
          ? 'border-emerald-300/40 bg-emerald-400/10 txt-pos'
          : 'border-border-subtle bg-white/[0.02] text-muted'
      }`}
    >
      {label}: {on ? 'চালু' : 'বন্ধ'}
    </span>
  )
}
