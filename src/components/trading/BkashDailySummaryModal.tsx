'use client'

import { useEffect, useRef, useState } from 'react'
import toast from 'react-hot-toast'
import { Button, Input, Select, Spinner } from '@/components/ui'
import { ModalFrame } from '@/components/trading/TradingModals'
import { useAddTradingBkashSummary } from '@/hooks/useTrading'
import { n, signedClass } from '@/components/trading/trading-utils'
import { tradingDrafts } from '@/lib/trading-drafts'
import type { TradingAccount, TradingMutationResponse } from '@/types/trading'

export function BkashDailySummaryModal({
  open,
  accounts,
  defaultAccountId,
  onClose,
  onCreated,
}: {
  open: boolean
  accounts: TradingAccount[]
  defaultAccountId?: string
  onClose: () => void
  onCreated: (res: TradingMutationResponse) => void
}) {
  const { mutate, loading } = useAddTradingBkashSummary()
  const formRef = useRef<HTMLFormElement>(null)
  const [accountId, setAccountId] = useState('')
  const [summaryDate, setSummaryDate] = useState(() => new Date().toISOString().slice(0, 10))
  const [totalOrders, setTotalOrders] = useState('')
  const [totalProfitBdt, setTotalProfitBdt] = useState('')
  const [totalLossBdt, setTotalLossBdt] = useState('')
  const [notes, setNotes] = useState('')

  useEffect(() => {
    if (!open) return
    const draft = tradingDrafts.summary.load()
    setAccountId(defaultAccountId || draft?.tradingAccountId || accounts[0]?.id || '')
    setSummaryDate(draft?.summaryDate || new Date().toISOString().slice(0, 10))
    setTotalOrders(draft?.totalOrders || '')
    setTotalProfitBdt(draft?.totalProfitBdt || '')
    setTotalLossBdt(draft?.totalLossBdt || '')
    setNotes(draft?.notes || '')
  }, [accounts, defaultAccountId, open])

  useEffect(() => {
    if (!open) return
    const t = window.setTimeout(() => {
      tradingDrafts.summary.save({
        tradingAccountId: accountId,
        summaryDate,
        totalOrders,
        totalProfitBdt,
        totalLossBdt,
        notes,
        savedAt: new Date().toISOString(),
      })
    }, 400)
    return () => window.clearTimeout(t)
  }, [accountId, notes, open, summaryDate, totalLossBdt, totalOrders, totalProfitBdt])

  const net = n(totalProfitBdt) - n(totalLossBdt)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (!accountId) {
      toast.error('Select an account')
      return
    }
    const profit = n(totalProfitBdt)
    const loss = n(totalLossBdt)
    if (profit < 0 || loss < 0) {
      toast.error('Profit and loss must be 0 or greater')
      return
    }
    if (!profit && !loss) {
      toast.error('Enter daily profit or loss')
      return
    }
    const res = await mutate({
      tradingAccountId: accountId,
      summaryDate,
      totalOrders: Number(totalOrders || 0),
      totalProfitBdt: profit,
      totalLossBdt: loss,
      notes,
    })
    if (!res?.ok) return
    tradingDrafts.summary.clear()
    toast.success('Daily summary saved')
    onCreated(res)
    onClose()
  }

  return (
    <ModalFrame
      open={open}
      onClose={onClose}
      title="Daily summary"
      desc="Bkash quick result — profit, loss, and order count"
      footer={
        <Button
          type="button"
          variant="gold"
          className="min-h-[48px] w-full justify-center"
          disabled={loading}
          onClick={() => formRef.current?.requestSubmit()}
        >
          {loading ? <><Spinner /> Saving…</> : 'Save daily summary'}
        </Button>
      }
    >
      <form ref={formRef} id="bkash-daily-summary-form" onSubmit={e => void submit(e)} className="space-y-3">
        <Select
          value={accountId}
          onChange={setAccountId}
          options={[
            { label: 'Select account', value: '' },
            ...accounts.map(a => ({ label: a.accountTitle, value: a.id })),
          ]}
          className="w-full"
        />
        <Input type="date" value={summaryDate} onChange={e => setSummaryDate(e.target.value)} />
        <Input
          inputMode="numeric"
          type="number"
          min="0"
          step="1"
          value={totalOrders}
          onChange={e => setTotalOrders(e.target.value)}
          placeholder="Total orders (optional)"
        />
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Input
            autoFocus
            inputMode="decimal"
            type="number"
            min="0"
            step="0.01"
            value={totalProfitBdt}
            onChange={e => setTotalProfitBdt(e.target.value)}
            placeholder="Total profit (BDT)"
            className="text-lg font-bold tabular-nums"
          />
          <Input
            inputMode="decimal"
            type="number"
            min="0"
            step="0.01"
            value={totalLossBdt}
            onChange={e => setTotalLossBdt(e.target.value)}
            placeholder="Total loss (BDT)"
            className="text-lg font-bold tabular-nums"
          />
        </div>
        <div className={`rounded-2xl border p-4 ${net >= 0 ? 'border-green-400/25 bg-green-400/10' : 'border-red-400/25 bg-red-400/10'}`}>
          <p className="text-[10px] font-black uppercase tracking-[0.16em] text-zinc-500">Net result</p>
          <p className={`mt-1 text-2xl font-black tabular-nums ${signedClass(net)}`}>
            {net >= 0 ? '+' : '-'}৳{Math.abs(net).toLocaleString('en-BD')}
          </p>
        </div>
        <textarea
          value={notes}
          onChange={e => setNotes(e.target.value)}
          rows={2}
          placeholder="Optional notes"
          className="w-full rounded-xl border border-border bg-black/30 px-3 py-2 text-sm text-cream"
        />
      </form>
    </ModalFrame>
  )
}
