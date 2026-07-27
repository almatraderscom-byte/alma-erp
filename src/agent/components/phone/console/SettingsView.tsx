'use client'

/**
 * The generic settings editor. Every settings sub-page is this component with a group name.
 *
 * Two decisions worth keeping:
 *
 * ONE FIELD, ONE SAVE. A form with eight boxes and a single button produces an audit row
 * nobody can read back and, on a live phone line, an unanswerable "what did I just change".
 * Each field saves itself and says what happened.
 *
 * THE SCREEN NEVER LIES ABOUT WHEN A CHANGE LANDS. An app-scoped value applies to the very
 * next call. A gateway-scoped one waits for the VPS to pull it, up to a minute — so it says
 * so, and shows when the gateway last pulled. Step 1's whole lesson was that our own belief
 * about the phone system is not evidence.
 */

import { useCallback, useMemo, useState } from 'react'
import { cn } from '@/lib/utils'
import {
  LOCKED_AUDIO,
  SETTING_GROUPS,
  settingsInGroup,
  type SettingDef,
  type SettingGroup,
  type SettingView,
  type SettingsPayload,
} from '@/agent/lib/phone-settings-types'
import { WEEKDAYS } from '@/agent/lib/phone-routing-types'
import { useJson } from './useJson'
import { EmptyState, ErrorNote, PageHead, Panel } from './ui'

const ENDPOINT = '/api/assistant/phone-console/settings'

export function SettingsView({ group }: { group: SettingGroup }) {
  const { data, error, loading, reload } = useJson<SettingsPayload>(ENDPOINT)
  const meta = SETTING_GROUPS.find((g) => g.id === group)!
  const defs = useMemo(() => settingsInGroup(group), [group])

  const byKey = useMemo(() => {
    const m = new Map<string, SettingView>()
    for (const s of data?.settings ?? []) m.set(s.key, s)
    return m
  }, [data])

  const hasGateway = defs.some((d) => d.scope !== 'app')

  return (
    <>
      <PageHead title={meta.title} subtitle={meta.blurb} />

      {error && <div className="mb-3"><ErrorNote>সেটিংস আনা যায়নি: {error}</ErrorNote></div>}
      {loading && !data && <Panel><EmptyState>আনা হচ্ছে…</EmptyState></Panel>}

      {data && (
        <div className="space-y-3">
          {hasGateway && <GatewayNote payload={data} />}

          {defs.map((def) => (
            <Field key={def.key} def={def} current={byKey.get(def.key)} onSaved={reload} />
          ))}

          {group === 'limits' && <LockedAudio />}
        </div>
      )}
    </>
  )
}

// ── one setting ──────────────────────────────────────────────────────────────

const SOURCE_LABEL: Record<SettingView['source'], string> = {
  kv: 'আপনার সেট করা',
  env: 'সার্ভারের পুরনো মান',
  default: 'কোডের ডিফল্ট',
}

function Field({
  def, current, onSaved,
}: { def: SettingDef; current: SettingView | undefined; onSaved: () => void }) {
  const saved = current?.value ?? ''
  const [draft, setDraft] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const [done, setDone] = useState<string | null>(null)

  const value = draft ?? saved
  const dirty = draft != null && draft.trim() !== saved.trim()

  const save = useCallback(async () => {
    setBusy(true)
    setProblem(null)
    setDone(null)
    try {
      const res = await fetch(ENDPOINT, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: def.key, value }),
      })
      const body = (await res.json()) as { ok: boolean; error?: string; warning?: string | null; applies?: string }
      if (!res.ok || !body.ok) { setProblem(body.error ?? `HTTP ${res.status}`); return }
      setDraft(null)
      setDone(
        (body.warning ? `${body.warning} ` : '')
        + (body.applies === 'next_call' ? 'সেভ হয়েছে — পরের কল থেকেই চালু।' : 'সেভ হয়েছে — এক মিনিটের মধ্যে গেটওয়ে নিয়ে নেবে।'),
      )
      onSaved()
    } catch (err) {
      setProblem(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }, [def.key, value, onSaved])

  return (
    <Panel
      title={def.label}
      badge={current ? SOURCE_LABEL[current.source] : undefined}
      actions={def.scope !== 'app' ? <ScopeChip /> : undefined}
    >
      <p className="mb-3 text-[12px] leading-relaxed text-muted">{def.help}</p>

      {def.kind === 'weekdays' ? (
        <div className="flex flex-wrap gap-1.5">
          {WEEKDAYS.map((d) => {
            const picked = value.split(',').map((x) => x.trim()).filter(Boolean)
            const on = picked.includes(d.value)
            return (
              <button
                key={d.value}
                type="button"
                onClick={() => {
                  const next = on ? picked.filter((x) => x !== d.value) : [...picked, d.value]
                  setDraft(next.join(','))
                  setDone(null)
                }}
                className={cn(
                  'rounded-full border px-3 py-1.5 text-[12px] transition-colors',
                  on ? 'border-[#E07A5F]/50 bg-[#E07A5F]/[0.16] font-semibold text-cream' : 'border-border-subtle bg-card/60 text-muted hover:text-cream',
                )}
              >
                {d.label}
              </button>
            )
          })}
        </div>
      ) : def.kind === 'ranges' ? (
        <textarea
          value={value}
          onChange={(e) => { setDraft(e.target.value); setDone(null) }}
          rows={3}
          placeholder={def.placeholder}
          spellCheck={false}
          className="w-full rounded-xl border border-border-subtle bg-card/60 px-3 py-2 font-mono text-[12px] text-cream placeholder:text-muted focus:border-[#E07A5F]/40 focus:outline-none"
        />
      ) : def.kind === 'enum' ? (
        <div className="inline-flex flex-wrap gap-1 rounded-full border border-border-subtle bg-card/60 p-1">
          {(def.options ?? []).map((o) => (
            <button
              key={o.value}
              type="button"
              onClick={() => { setDraft(o.value); setDone(null) }}
              className={cn(
                'rounded-full px-3 py-1.5 text-[12px] transition-colors',
                value === o.value ? 'bg-[#E07A5F]/[0.16] font-semibold text-cream shadow-sm' : 'text-muted hover:text-cream',
              )}
            >
              {o.label}
            </button>
          ))}
        </div>
      ) : (
        <input
          value={value}
          onChange={(e) => { setDraft(e.target.value); setDone(null) }}
          type={def.kind === 'number' ? 'number' : 'text'}
          min={def.min}
          max={def.max}
          placeholder={def.placeholder}
          spellCheck={false}
          className="w-full rounded-xl border border-border-subtle bg-card/60 px-3 py-2 text-sm text-cream placeholder:text-muted focus:border-[#E07A5F]/40 focus:outline-none"
        />
      )}

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button
          type="button"
          disabled={!dirty || busy}
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
        {dirty && !busy && (
          <button type="button" onClick={() => { setDraft(null); setProblem(null) }} className="text-[12px] text-muted hover:text-cream">
            বাতিল
          </button>
        )}
        {done && <span className="text-[12px] txt-pos">{done}</span>}
      </div>

      {problem && <p className="mt-2 tone-red rounded-xl border px-3 py-2 text-[12px]">{problem}</p>}
    </Panel>
  )
}

function ScopeChip() {
  return (
    <span className="rounded-full border border-border-subtle bg-card/60 px-2 py-0.5 text-[10px] text-muted" title="এই মানটা VPS-এর গেটওয়ে পড়ে, তাই বদল কার্যকর হতে এক মিনিট পর্যন্ত লাগে">
      গেটওয়ে
    </span>
  )
}

function GatewayNote({ payload }: { payload: SettingsPayload }) {
  const at = payload.gatewayPulledAt
    ? new Date(payload.gatewayPulledAt).toLocaleTimeString('bn-BD', { timeZone: 'Asia/Dhaka', hour: 'numeric', minute: '2-digit', second: '2-digit' })
    : null

  return (
    <div className={cn('rounded-2xl border px-4 py-3 text-[12px]', payload.gatewayReachable ? 'border-border-subtle bg-card/60' : 'tone-amber')}>
      <p className="font-semibold text-cream">“গেটওয়ে” লেখা সেটিংগুলো VPS পড়ে</p>
      <p className="mt-1 text-muted">
        সেভ করলে সাথে সাথে নয় — VPS প্রতি মিনিটে নিজে থেকে টেনে নেয়।
        {at ? ` শেষবার নিয়েছে ${at}-এ।` : ' এখনো একবারও নেয়নি — নতুন কোড VPS-এ যাওয়ার পরই শুরু হবে।'}
        {!payload.gatewayReachable && ' এই মুহূর্তে গেটওয়ের সাথে যোগাযোগ নেই।'}
      </p>
    </div>
  )
}

// ── the values that have no editor ───────────────────────────────────────────

function LockedAudio() {
  return (
    <Panel title="কল অডিওর টিউনিং" badge="তালাবন্ধ">
      <p className="mb-3 text-[12px] leading-relaxed text-muted">
        ২৬ জুলাই ২০২৬-এ লাইভ কল শুনে আপনি কণ্ঠটা “পারফেক্ট” বলেছেন — সেই মানগুলোই নিচে।
        এগুলো ইচ্ছে করেই কোডের ভেতরে, কোনো সার্ভার-সেটিং দিয়ে বদলানো যায় না, যেন SSH দিয়ে
        চুপচাপ কেউ বদলাতে না পারে। বদলাতে হলে আপনার কানে এক-একটা পরিবর্তন, একটা করে কল।
      </p>
      <dl className="space-y-2">
        {LOCKED_AUDIO.map((row) => (
          <div key={row.label} className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 border-b border-border-subtle/60 pb-2 last:border-0 last:pb-0">
            <dt className="text-[12px] font-medium text-cream">{row.label}</dt>
            <dd className="text-[12px] font-semibold tabular-nums text-cream">{row.value}</dd>
            <p className="w-full text-[11px] text-muted">{row.why}</p>
          </div>
        ))}
      </dl>
    </Panel>
  )
}
