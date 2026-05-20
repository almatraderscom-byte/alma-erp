'use client'

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import toast from 'react-hot-toast'
import { Button, Card, Input, Skeleton } from '@/components/ui'
import { safeResponseJson } from '@/lib/safe-api-response'

type MethodRow = {
  id: string
  type: string
  provider: string | null
  usageType: string | null
  accountHolderName: string
  accountNumber: string
  accountNumberMasked: string
  bankName: string | null
  branchName: string | null
  routingNumber: string | null
  hasQr: boolean
  isPrimary: boolean
  isVerified: boolean
  status: string
  displayLabel: string
}

const PROVIDER_OPTIONS = [
  { label: 'bKash', value: 'BKASH' },
  { label: 'Nagad', value: 'NAGAD' },
  { label: 'Rocket', value: 'ROCKET' },
  { label: 'Other', value: 'OTHER' },
]

export function PaymentAccountsPanel({ businessId }: { businessId: string }) {
  const [methods, setMethods] = useState<MethodRow[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [form, setForm] = useState<'MOBILE_BANKING' | 'BANK_ACCOUNT' | null>(null)
  const [revealed, setRevealed] = useState<Record<string, boolean>>({})

  const load = useCallback(async () => {
    setLoading(true)
    const res = await fetch(`/api/employee/payment-methods?business_id=${encodeURIComponent(businessId)}`, {
      cache: 'no-store',
    })
    const parsed = await safeResponseJson<{ methods?: MethodRow[] }>(res)
    if (parsed.ok && res.ok) setMethods(parsed.data.methods || [])
    else toast.error('Could not load payment accounts')
    setLoading(false)
  }, [businessId])

  useEffect(() => {
    void load()
  }, [load])

  async function submitMobile(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const fd = new FormData(e.currentTarget)
    setSaving(true)
    const res = await fetch('/api/employee/payment-methods', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        business_id: businessId,
        type: 'MOBILE_BANKING',
        provider: fd.get('provider'),
        usage_type: fd.get('usage_type'),
        account_holder_name: fd.get('account_holder_name'),
        account_number: fd.get('account_number'),
        is_primary: true,
      }),
    })
    const parsed = await safeResponseJson(res)
    setSaving(false)
    if (!parsed.ok || !res.ok) {
      toast.error(String((parsed.data as { message?: string }).message || 'Save failed'))
      return
    }
    toast.success('Mobile account saved')
    setForm(null)
    await load()
  }

  async function submitBank(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const fd = new FormData(e.currentTarget)
    setSaving(true)
    const res = await fetch('/api/employee/payment-methods', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        business_id: businessId,
        type: 'BANK_ACCOUNT',
        bank_name: fd.get('bank_name'),
        branch_name: fd.get('branch_name'),
        account_holder_name: fd.get('account_holder_name'),
        account_number: fd.get('account_number'),
        routing_number: fd.get('routing_number'),
        is_primary: methods.length === 0,
      }),
    })
    const parsed = await safeResponseJson(res)
    setSaving(false)
    if (!parsed.ok || !res.ok) {
      toast.error(String((parsed.data as { message?: string }).message || 'Save failed'))
      return
    }
    toast.success('Bank account saved')
    setForm(null)
    await load()
  }

  async function setPrimary(id: string) {
    const res = await fetch(`/api/employee/payment-methods/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ is_primary: true }),
    })
    const parsed = await safeResponseJson(res)
    if (!parsed.ok || !res.ok) {
      toast.error('Could not set primary')
      return
    }
    toast.success('Default payout updated')
    await load()
  }

  async function remove(id: string) {
    if (!confirm('Remove this payout account?')) return
    const res = await fetch(`/api/employee/payment-methods/${id}`, { method: 'DELETE' })
    const parsed = await safeResponseJson(res)
    if (!parsed.ok || !res.ok) {
      toast.error('Could not remove')
      return
    }
    toast.success('Account removed')
    await load()
  }

  function copyNumber(m: MethodRow) {
    const num = revealed[m.id] ? m.accountNumber : m.accountNumberMasked
    void navigator.clipboard.writeText(num).then(() => toast.success('Copied'))
  }

  return (
    <Card className="p-5 border-gold-dim/25 bg-[#0c0c10] space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-[10px] font-black uppercase tracking-[0.14em] text-gold">Payment accounts</p>
          <p className="mt-1 text-[11px] text-zinc-500">
            Used for salary payouts, wallet advances, and withdrawals. Numbers are masked on shared screens.
          </p>
        </div>
        <Link href="/portal" className="text-[11px] font-bold text-gold-lt hover:underline">
          ← My Desk
        </Link>
      </div>

      {loading ? (
        <Skeleton className="h-32 w-full" />
      ) : (
        <div className="space-y-3">
          {methods.map(m => (
            <div
              key={m.id}
              className={`rounded-2xl border px-4 py-3 ${
                m.isPrimary ? 'border-gold/45 bg-gold/5' : 'border-border bg-black/25'
              }`}
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="rounded-lg bg-zinc-800 px-2 py-0.5 text-[10px] font-black uppercase text-cream">
                    {m.displayLabel}
                  </span>
                  {m.isPrimary && (
                    <span className="rounded-lg bg-gold/15 px-2 py-0.5 text-[10px] font-black text-gold-lt">
                      Primary
                    </span>
                  )}
                  <span
                    className={`rounded-lg px-2 py-0.5 text-[10px] font-black ${
                      m.isVerified ? 'bg-green-500/15 text-green-300' : 'bg-amber-500/15 text-amber-200'
                    }`}
                  >
                    {m.isVerified ? 'Verified' : 'Pending verify'}
                  </span>
                </div>
                <div className="flex flex-wrap gap-2">
                  {!m.isPrimary && (
                    <Button size="xs" variant="ghost" onClick={() => void setPrimary(m.id)}>
                      Set default
                    </Button>
                  )}
                  <Button
                    size="xs"
                    variant="ghost"
                    onClick={() => setRevealed(r => ({ ...r, [m.id]: !r[m.id] }))}
                  >
                    {revealed[m.id] ? 'Hide' : 'Reveal'}
                  </Button>
                  <Button size="xs" variant="ghost" onClick={() => copyNumber(m)}>
                    Copy
                  </Button>
                  <Button size="xs" variant="danger" onClick={() => void remove(m.id)}>
                    Remove
                  </Button>
                </div>
              </div>
              <p className="mt-2 text-sm font-bold text-cream">{m.accountHolderName}</p>
              <p className="font-mono text-lg text-gold-lt tracking-wide">
                {revealed[m.id] ? m.accountNumber : m.accountNumberMasked}
              </p>
              {m.type === 'BANK_ACCOUNT' && m.bankName && (
                <p className="mt-1 text-[11px] text-zinc-500">
                  {m.bankName}
                  {m.branchName ? ` · ${m.branchName}` : ''}
                </p>
              )}
            </div>
          ))}
          {!methods.length && (
            <p className="text-[11px] text-zinc-500">No payout accounts yet. Add bKash, Nagad, Rocket, or a bank account.</p>
          )}
        </div>
      )}

      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant={form === 'MOBILE_BANKING' ? 'gold' : 'secondary'} onClick={() => setForm('MOBILE_BANKING')}>
          + Mobile banking
        </Button>
        <Button size="sm" variant={form === 'BANK_ACCOUNT' ? 'gold' : 'secondary'} onClick={() => setForm('BANK_ACCOUNT')}>
          + Bank account
        </Button>
      </div>

      {form === 'MOBILE_BANKING' && (
        <form onSubmit={submitMobile} className="grid gap-3 rounded-2xl border border-border bg-black/30 p-4">
          <label className="block text-[11px] text-zinc-500">
            Provider
            <select name="provider" className="mt-1 w-full rounded-xl border border-border bg-card px-3 py-2 text-sm text-cream">
              {PROVIDER_OPTIONS.map(o => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
          </label>
          <label className="block text-[11px] text-zinc-500">
            Account type
            <select name="usage_type" className="mt-1 w-full rounded-xl border border-border bg-card px-3 py-2 text-sm text-cream">
              <option value="PERSONAL">Personal</option>
              <option value="BUSINESS">Business</option>
            </select>
          </label>
          <label className="block text-[11px] text-zinc-500">
            Account holder name
            <Input name="account_holder_name" className="mt-1" required />
          </label>
          <label className="block text-[11px] text-zinc-500">
            Mobile number
            <Input name="account_number" className="mt-1" required placeholder="01XXXXXXXXX" />
          </label>
          <Button type="submit" variant="gold" disabled={saving}>
            {saving ? 'Saving…' : 'Save mobile account'}
          </Button>
        </form>
      )}

      {form === 'BANK_ACCOUNT' && (
        <form onSubmit={submitBank} className="grid gap-3 rounded-2xl border border-border bg-black/30 p-4">
          <label className="block text-[11px] text-zinc-500">Bank name<Input name="bank_name" className="mt-1" required /></label>
          <label className="block text-[11px] text-zinc-500">Branch<Input name="branch_name" className="mt-1" /></label>
          <label className="block text-[11px] text-zinc-500">Account name<Input name="account_holder_name" className="mt-1" required /></label>
          <label className="block text-[11px] text-zinc-500">Account number<Input name="account_number" className="mt-1" required /></label>
          <label className="block text-[11px] text-zinc-500">Routing (optional)<Input name="routing_number" className="mt-1" /></label>
          <Button type="submit" variant="gold" disabled={saving}>
            {saving ? 'Saving…' : 'Save bank account'}
          </Button>
        </form>
      )}
    </Card>
  )
}
