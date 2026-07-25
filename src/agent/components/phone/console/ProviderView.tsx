'use client'

/**
 * The provider's own registration table.
 *
 * WHY THIS IS WORTH A LOGIN: the provider keeps exactly ONE registration binding per SIP
 * account and the last registrant owns it. Our own Asterisk has reported
 * "Registered (exp. 3227s)" while their table did not list us at all, and every outbound call
 * placed in that state went out from an address that was not the current binding and quietly
 * died — roughly half of all outbound calls, for days, looking exactly like a provider fault.
 * Our side is not evidence. This screen is the only place in the ERP that shows theirs.
 *
 * The password is typed by the owner, stored encrypted, and never shown again — not here, not
 * in any response. When their page cannot be read the screen says what came back instead of
 * showing an empty table, because a silent blank here is what a lie looks like.
 */

import { useCallback, useState } from 'react'
import type { ProviderState } from '@/agent/lib/phone-settings-types'
import { useJson } from './useJson'
import { ConsoleButton, EmptyState, ErrorNote, PageHead, Panel, Pill, TableWrap, Td, Th } from './ui'

const ENDPOINT = '/api/assistant/phone-console/settings/provider'

/** Our VPS. Seeing this IP hold the binding is the whole point of the screen. */
const OUR_IP = '31.97.237.40'

type Payload = {
  provider: ProviderState & { sample?: string | null }
  urls: { loginUrl: string; statusUrl: string }
  encryptionReady: boolean
}

export function ProviderView() {
  const { data, error, loading, reload } = useJson<Payload>(ENDPOINT)
  const [checking, setChecking] = useState(false)
  const [checked, setChecked] = useState<Payload['provider'] | null>(null)

  const check = useCallback(async () => {
    setChecking(true)
    try {
      const res = await fetch(`${ENDPOINT}?check=1`, { cache: 'no-store' })
      const body = (await res.json()) as Payload
      setChecked(body.provider)
    } catch { /* the panel below shows the stored last-check state */ } finally {
      setChecking(false)
    }
  }, [])

  const provider = checked ?? data?.provider
  const rows = provider?.registrations ?? []

  return (
    <>
      <PageHead
        title="প্রোভাইডারের রেজিস্ট্রেশন"
        subtitle="লাইনটা এই মুহূর্তে কার দখলে — আমাদের নিজের হিসাব নয়, ওদের নিজের টেবিল।"
        actions={provider?.stored ? <ConsoleButton onClick={() => void check()}>{checking ? 'দেখছি…' : 'এখনই দেখো'}</ConsoleButton> : undefined}
      />

      {error && <div className="mb-3"><ErrorNote>{error}</ErrorNote></div>}
      {loading && !data && <Panel><EmptyState>আনা হচ্ছে…</EmptyState></Panel>}

      {data && (
        <div className="space-y-3">
          <Panel title="কেন এই পাতাটা দরকার">
            <p className="text-[12px] leading-relaxed text-muted">
              প্রোভাইডার এক অ্যাকাউন্টে একটাই রেজিস্ট্রেশন রাখে, আর যে সবশেষে রেজিস্টার করে
              লাইনটা তারই। আমাদের Asterisk “Registered” দেখানোর পরেও ওদের টেবিলে আমরা ছিলাম না —
              আর সেই অবস্থায় করা আউটবাউন্ড কলগুলো চুপচাপ মারা যাচ্ছিল। তাই “আমরা রেজিস্টার্ড”
              কোনো প্রমাণ নয়; নিচের টেবিলটাই প্রমাণ।
            </p>
          </Panel>

          {provider?.stored && (
            <Panel
              title="ওদের টেবিল"
              badge={provider.lastCheckAt ? new Date(provider.lastCheckAt).toLocaleString('bn-BD', { timeZone: 'Asia/Dhaka', hour: 'numeric', minute: '2-digit' }) : 'এখনো দেখা হয়নি'}
            >
              {provider.lastError && <ErrorNote>{provider.lastError}</ErrorNote>}

              {rows.length > 0 ? (
                <TableWrap>
                  <thead>
                    <tr><Th>IP</Th><Th>কে</Th><Th>বাকি সময়</Th><Th>সময়</Th></tr>
                  </thead>
                  <tbody>
                    {rows.map((r, i) => {
                      const ours = (r.ip ?? '').startsWith(OUR_IP)
                      return (
                        <tr key={`${r.ip}-${i}`}>
                          <Td>{r.ip ?? '—'}</Td>
                          <Td>
                            {ours
                              ? <Pill tone="green">আমাদের VPS</Pill>
                              : <Pill tone="amber">{r.userAgent ?? 'অন্য কেউ'}</Pill>}
                            {r.userAgent && <span className="ml-2 text-muted">{r.userAgent}</span>}
                          </Td>
                          <Td className="tabular-nums">{r.expiresIn != null ? `${r.expiresIn}s` : '—'}</Td>
                          <Td>{r.at ?? '—'}</Td>
                        </tr>
                      )
                    })}
                  </tbody>
                </TableWrap>
              ) : (
                <EmptyState>{provider.lastError ? 'সারি পড়া যায়নি।' : '“এখনই দেখো” চাপুন।'}</EmptyState>
              )}

              {provider.sample && (
                <details className="mt-3">
                  <summary className="cursor-pointer text-[11px] text-muted">ওদের সাইট আসলে কী পাঠিয়েছে</summary>
                  <pre className="mt-2 overflow-x-auto rounded-xl border border-border-subtle bg-card/60 p-3 text-[10px] text-muted">{provider.sample}</pre>
                </details>
              )}
            </Panel>
          )}

          <CredentialForm data={data} onSaved={reload} />
        </div>
      )}
    </>
  )
}

function CredentialForm({ data, onSaved }: { data: Payload; onSaved: () => void }) {
  const [username, setUsername] = useState(data.provider.username ?? '')
  const [secret, setSecret] = useState('')
  const [loginUrl, setLoginUrl] = useState(data.urls.loginUrl)
  const [statusUrl, setStatusUrl] = useState(data.urls.statusUrl)
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)

  const save = useCallback(async () => {
    setBusy(true)
    setProblem(null)
    try {
      const res = await fetch(ENDPOINT, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, secret, loginUrl, statusUrl }),
      })
      const body = (await res.json()) as { ok: boolean; error?: string }
      if (!res.ok || !body.ok) { setProblem(body.error ?? `HTTP ${res.status}`); return }
      setSecret('')
      onSaved()
    } catch (err) {
      setProblem(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }, [username, secret, loginUrl, statusUrl, onSaved])

  const forget = useCallback(async () => {
    setBusy(true)
    await fetch(ENDPOINT, { method: 'DELETE' }).catch(() => {})
    setSecret('')
    setBusy(false)
    onSaved()
  }, [onSaved])

  return (
    <Panel title="amarip.net-এর লগইন" badge={data.provider.stored ? 'সেভ করা আছে' : 'দেওয়া হয়নি'}>
      <p className="mb-3 text-[12px] leading-relaxed text-muted">
        পাসওয়ার্ডটা আপনি নিজে লিখবেন — এনক্রিপ্ট হয়ে সেভ হবে, আর কোথাও কখনো দেখানো হবে না।
        সার্ভার শুধু ওদের সাইটেই পাঠাবে, অন্য কোথাও নয়।
        {data.provider.updatedAt && ` শেষ সেভ: ${new Date(data.provider.updatedAt).toLocaleString('bn-BD', { timeZone: 'Asia/Dhaka', day: 'numeric', month: 'short' })}।`}
      </p>

      {!data.encryptionReady && (
        <ErrorNote>সার্ভারে এনক্রিপশন কী নেই, তাই পাসওয়ার্ড সেভ করা যাবে না।</ErrorNote>
      )}

      <div className="grid gap-3 md:grid-cols-2">
        <Labelled label="ইউজারনেম">
          <Input value={username} onChange={setUsername} autoComplete="off" />
        </Labelled>
        <Labelled label={data.provider.stored ? 'নতুন পাসওয়ার্ড (বদলাতে চাইলে)' : 'পাসওয়ার্ড'}>
          <Input value={secret} onChange={setSecret} type="password" autoComplete="new-password" />
        </Labelled>
        <Labelled label="লগইন লিংক">
          <Input value={loginUrl} onChange={setLoginUrl} autoComplete="off" />
        </Labelled>
        <Labelled label="রেজিস্ট্রেশন টেবিলের লিংক">
          <Input value={statusUrl} onChange={setStatusUrl} autoComplete="off" />
        </Labelled>
      </div>

      <p className="mt-2 text-[11px] text-muted">
        লিংক দুটো আন্দাজ করা — ওদের প্যানেলের আসল ঠিকানা আলাদা হলে এখানেই ঠিক করে দিন,
        কোড বদলানোর দরকার নেই।
      </p>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button
          type="button"
          disabled={busy || !username || !secret || !data.encryptionReady}
          onClick={() => void save()}
          className="rounded-full bg-[#E07A5F] px-4 py-1.5 text-[12px] font-semibold text-white transition-colors hover:bg-[#E07A5F]/90 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {busy ? 'সেভ হচ্ছে…' : 'সেভ করে পরীক্ষা করো'}
        </button>
        {data.provider.stored && (
          <button type="button" disabled={busy} onClick={() => void forget()} className="text-[12px] text-muted hover:text-cream">
            মুছে ফেলো
          </button>
        )}
      </div>

      {problem && <p className="mt-2 tone-red rounded-xl border px-3 py-2 text-[12px]">{problem}</p>}
    </Panel>
  )
}

function Labelled({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-[11px] text-muted">{label}</span>
      {children}
    </label>
  )
}

function Input({
  value, onChange, type = 'text', autoComplete,
}: { value: string; onChange: (v: string) => void; type?: string; autoComplete?: string }) {
  return (
    <input
      value={value}
      onChange={(e) => onChange(e.target.value)}
      type={type}
      autoComplete={autoComplete}
      spellCheck={false}
      className="w-full rounded-xl border border-border-subtle bg-card/60 px-3 py-2 text-sm text-cream placeholder:text-muted focus:border-[#E07A5F]/40 focus:outline-none"
    />
  )
}
