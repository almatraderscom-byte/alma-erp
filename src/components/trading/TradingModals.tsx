'use client'
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import toast from 'react-hot-toast'
import { Button, Card, Input, Select, Spinner } from '@/components/ui'
import { useAddTradingBkashSummary, useAddTradingCapital, useAddTradingExpense, useCreateTradingAccount, useSubmitTradingTrade, useUpdateTradingAccount, useUploadTradingAttachment } from '@/hooks/useTrading'
import type { TradingAccount, TradingAccountInput, TradingCapitalEntryType, TradingMutationResponse, TradingUser } from '@/types/trading'
import { EXPENSE_TYPES, n, signedClass } from '@/components/trading/trading-utils'
import { tradingDrafts } from '@/lib/trading-drafts'
import { MobileModalPortal } from '@/components/mobile/MobileModalPortal'

export function ModalFrame({
  title,
  desc,
  open,
  onClose,
  children,
  footer,
}: {
  title: string
  desc?: string
  open: boolean
  onClose: () => void
  children: ReactNode
  footer?: ReactNode
}) {
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])
  if (!open) return null
  return (
    <MobileModalPortal open zIndex={10000} onBackdropClick={onClose} aria-label={title}>
      <Card className="mobile-modal-shell relative w-full rounded-b-none border-gold-dim/30 shadow-2xl sm:max-w-xl sm:rounded-2xl">
        <div className="mobile-modal-header flex items-start justify-between gap-3 border-b border-border p-4 pb-3 sm:p-5 sm:pb-3">
          <div>
            <p className="text-sm font-bold text-cream">{title}</p>
            {desc && <p className="mt-1 text-[11px] text-zinc-500">{desc}</p>}
          </div>
          <Button size="xs" variant="ghost" onClick={onClose}>Close</Button>
        </div>
        <div className="mobile-modal-body p-4 sm:p-5">
          {children}
        </div>
        {footer ? (
          <div className="mobile-modal-footer px-4 pt-3 sm:px-5 sm:pt-3">
            {footer}
          </div>
        ) : null}
      </Card>
    </MobileModalPortal>
  )
}

export function TradingAccountModal({
  open,
  account,
  staff,
  canManageTargets = false,
  onClose,
  onSaved,
}: {
  open: boolean
  account?: TradingAccount | null
  staff: TradingUser[]
  canManageTargets?: boolean
  onClose: () => void
  onSaved: () => void
}) {
  const { mutate: create, loading: creating } = useCreateTradingAccount()
  const { mutate: update, loading: updating } = useUpdateTradingAccount()
  const formRef = useRef<HTMLFormElement>(null)
  const [form, setForm] = useState<TradingAccountInput>({
    accountTitle: '',
    binanceUid: '',
    accountType: 'BINANCE_P2P',
    status: 'ACTIVE',
    startingCapital: 0,
    merchantTarget: null,
    commissionType: 'NONE',
    commissionRate: 0,
    fixedCommission: 0,
    completionBonus: 0,
    startDate: new Date().toISOString().slice(0, 10),
    assignedUserId: '',
    notes: '',
  })
  useEffect(() => {
    if (!open) return
    setForm({
      accountTitle: account?.accountTitle || '',
      binanceUid: account?.binanceUid || '',
      accountType: account?.accountType || 'BINANCE_P2P',
      status: account?.status || 'ACTIVE',
      startingCapital: n(account?.startingCapital),
      merchantTarget: account?.merchantTarget == null ? null : n(account.merchantTarget),
      commissionType: account?.commissionType || 'NONE',
      commissionRate: n(account?.commissionRate),
      fixedCommission: n(account?.fixedCommission),
      completionBonus: n(account?.completionBonus),
      startDate: account?.startDate ? account.startDate.slice(0, 10) : new Date().toISOString().slice(0, 10),
      completedDate: account?.completedDate ? account.completedDate.slice(0, 10) : null,
      assignedUserId: account?.assignedUserId || '',
      notes: account?.notes || '',
    })
  }, [account, open])

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (!form.accountTitle.trim()) { toast.error('Account title required'); return }
    if (n(form.startingCapital) <= 0) { toast.error('Initial Capital (BDT) is required'); return }
    const payload = { ...form }
    if (!canManageTargets) delete payload.merchantTarget
    const res = account
      ? await update(account.id, payload)
      : await create(payload)
    if (!res?.ok) { toast.error('Could not save account'); return }
    toast.success(account ? 'Trading account updated' : 'Trading account created')
    onSaved()
    onClose()
  }

  const saving = creating || updating
  return (
    <ModalFrame
      open={open}
      onClose={onClose}
      title={account ? 'Edit trading account' : 'Create trading account'}
      desc="Independent merchant wallet with its own capital, staff, expenses, and ROI."
      footer={
        <Button
          type="button"
          variant="gold"
          className="w-full justify-center"
          disabled={saving}
          onClick={() => formRef.current?.requestSubmit()}
        >
          {saving ? <><Spinner /> Saving</> : 'Save account'}
        </Button>
      }
    >
      <form ref={formRef} id="trading-account-form" onSubmit={e => void submit(e)} className="space-y-3">
        <Input value={form.accountTitle} onChange={e => setForm(f => ({ ...f, accountTitle: e.target.value }))} placeholder="Account Name *" />
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Input inputMode="decimal" type="number" min="0" step="0.01" value={form.startingCapital ?? ''} onChange={e => setForm(f => ({ ...f, startingCapital: Number(e.target.value) }))} placeholder="Initial Capital (BDT) *" />
          <Select value={form.accountType || 'BINANCE_P2P'} onChange={v => setForm(f => ({ ...f, accountType: v as never }))} options={[
            { label: 'Binance P2P', value: 'BINANCE_P2P' },
            { label: 'Merchant', value: 'MERCHANT' },
            { label: 'Staff operated', value: 'STAFF_OPERATED' },
            { label: 'Other', value: 'OTHER' },
          ]} />
          <Input value={form.binanceUid || ''} onChange={e => setForm(f => ({ ...f, binanceUid: e.target.value }))} placeholder="Binance UID" />
          {canManageTargets ? (
            <Input inputMode="decimal" type="number" min="0" step="0.01" value={form.merchantTarget ?? ''} onChange={e => setForm(f => ({ ...f, merchantTarget: e.target.value ? Number(e.target.value) : null }))} placeholder="Merchant Goal / Monthly Target" />
          ) : account?.merchantTarget != null ? (
            <p className="rounded-xl border border-border bg-black/20 px-4 py-3 text-sm text-zinc-400">Monthly target: {n(account.merchantTarget)} BDT (Super Admin only)</p>
          ) : null}
          <Select value={form.status || 'ACTIVE'} onChange={v => setForm(f => ({ ...f, status: v as never }))} options={[
            { label: 'Active', value: 'ACTIVE' },
            { label: 'Paused', value: 'PAUSED' },
            { label: 'Completed', value: 'COMPLETED' },
            { label: 'Closed', value: 'CLOSED' },
          ]} />
        </div>
        <Select value={form.assignedUserId || ''} onChange={v => setForm(f => ({ ...f, assignedUserId: v || null }))} options={[
          { label: 'Unassigned', value: '' },
          ...staff.map(s => ({ label: `${s.name}${s.role ? ` · ${s.role}` : ''}`, value: s.id })),
        ]} className="w-full" />
        <div className="rounded-2xl border border-border bg-black/20 p-3">
          <p className="mb-3 text-[10px] font-black uppercase tracking-[0.14em] text-zinc-500">Optional Staff Commission</p>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Select value={form.commissionType || 'NONE'} onChange={v => setForm(f => ({ ...f, commissionType: v as never }))} options={[
              { label: 'No commission', value: 'NONE' },
              { label: 'Percentage of profit', value: 'PERCENTAGE' },
              { label: 'Fixed per profitable sell', value: 'FIXED' },
            ]} />
            <Input inputMode="decimal" type="number" min="0" step="0.01" value={form.commissionRate ?? 0} onChange={e => setForm(f => ({ ...f, commissionRate: Number(e.target.value) }))} placeholder="Commission % of profit" />
            <Input inputMode="decimal" type="number" min="0" step="0.01" value={form.fixedCommission ?? 0} onChange={e => setForm(f => ({ ...f, fixedCommission: Number(e.target.value) }))} placeholder="Fixed commission BDT" />
            <Input inputMode="decimal" type="number" min="0" step="0.01" value={form.completionBonus ?? 0} onChange={e => setForm(f => ({ ...f, completionBonus: Number(e.target.value) }))} placeholder="Merchant completion bonus BDT" />
          </div>
        </div>
        <textarea value={form.notes || ''} onChange={e => setForm(f => ({ ...f, notes: e.target.value }))} className="min-h-20 w-full rounded-xl border border-border bg-card px-4 py-3 text-sm text-cream outline-none focus:border-gold-dim/60" placeholder="Notes" />
        <p className="text-[11px] text-zinc-500">Wallet formula: Initial Capital + Net Profit - Expenses - Withdrawals. Account expenses also feed global finance and management reports.</p>
      </form>
    </ModalFrame>
  )
}

export function TradeEntryModal({
  open,
  account,
  accounts,
  initialMode = 'BANK',
  onClose,
  onCreated,
}: {
  open: boolean
  account: TradingAccount | null
  accounts?: TradingAccount[]
  initialMode?: 'BKASH' | 'BANK'
  onClose: () => void
  onCreated: (res: TradingMutationResponse) => void
}) {
  const { mutate, loading, error: mutationError } = useSubmitTradingTrade()
  const { mutate: addBkashSummary, loading: savingBkash } = useAddTradingBkashSummary()
  const bkashFormRef = useRef<HTMLFormElement>(null)
  const bankFormRef = useRef<HTMLFormElement>(null)
  const [selectedAccountId, setSelectedAccountId] = useState('')
  const activeAccount = useMemo(
    () => account ?? accounts?.find(a => a.id === selectedAccountId) ?? accounts?.[0] ?? null,
    [account, accounts, selectedAccountId],
  )
  const [entryMode, setEntryMode] = useState<'BKASH' | 'BANK'>('BANK')
  const [form, setForm] = useState({ tradeType: 'BUY' as 'BUY' | 'SELL', usdtAmount: '', bdtRate: '', feeUsdt: '', notes: '' })
  const [submitError, setSubmitError] = useState<string | null>(null)
  const [bkashForm, setBkashForm] = useState({
    summaryDate: new Date().toISOString().slice(0, 10),
    totalProfitBdt: '',
    totalLossBdt: '',
    notes: '',
  })
  useEffect(() => {
    if (!open) return
    const draft = tradingDrafts.trade.load()
    setSelectedAccountId(account?.id || draft?.tradingAccountId || accounts?.[0]?.id || '')
    setEntryMode(draft?.entryMode || initialMode)
    setForm(draft?.form || { tradeType: 'BUY', usdtAmount: '', bdtRate: '', feeUsdt: '', notes: '' })
    setBkashForm(draft?.bkashForm || { summaryDate: new Date().toISOString().slice(0, 10), totalProfitBdt: '', totalLossBdt: '', notes: '' })
    setSubmitError(null)
  }, [account?.id, accounts, initialMode, open])

  useEffect(() => {
    if (!open) return
    const t = window.setTimeout(() => {
      tradingDrafts.trade.save({
        tradingAccountId: selectedAccountId || account?.id || accounts?.[0]?.id || '',
        entryMode,
        form,
        bkashForm,
        savedAt: new Date().toISOString(),
      })
    }, 400)
    return () => window.clearTimeout(t)
  }, [account?.id, accounts, bkashForm, entryMode, form, open, selectedAccountId])
  useEffect(() => {
    if (!mutationError) return
    setSubmitError(mutationError)
    toast.error(mutationError)
  }, [mutationError])
  const calc = useMemo(() => {
    const usdtAmount = n(form.usdtAmount)
    const rate = n(form.bdtRate)
    const totalBdt = usdtAmount * rate
    const feeBdt = n(form.feeUsdt) * rate
    const avgCostRate = n(activeAccount?.usdtBalance) > 0 ? n(activeAccount?.inventoryCostBdt) / n(activeAccount?.usdtBalance) : 0
    const costBasis = form.tradeType === 'SELL' ? usdtAmount * avgCostRate : totalBdt + feeBdt
    const netBdt = form.tradeType === 'BUY' ? totalBdt + feeBdt : totalBdt - feeBdt
    return { totalBdt, feeBdt, netBdt, costBasis, net: form.tradeType === 'SELL' ? netBdt - costBasis : 0, avgCostRate }
  }, [activeAccount?.inventoryCostBdt, activeAccount?.usdtBalance, form])

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (loading) return
    setSubmitError(null)
    if (!activeAccount) {
      const msg = 'Select a trading account first.'
      setSubmitError(msg)
      toast.error(msg)
      return
    }
    const usdtAmount = n(form.usdtAmount)
    const bdtRate = n(form.bdtRate)
    const feeUsdt = n(form.feeUsdt)
    if (usdtAmount <= 0 || bdtRate <= 0) {
      const msg = 'Enter a valid USDT amount and BDT rate before submitting.'
      setSubmitError(msg)
      toast.error(msg)
      return
    }
    if (feeUsdt < 0) {
      const msg = 'Binance fee must be 0 or greater.'
      setSubmitError(msg)
      toast.error(msg)
      return
    }
    if (form.tradeType === 'SELL' && usdtAmount > n(activeAccount.usdtBalance)) {
      const msg = 'Sell USDT exceeds account USDT balance.'
      setSubmitError(msg)
      toast.error(msg)
      return
    }
    const res = await mutate({ tradingAccountId: activeAccount.id, tradeType: form.tradeType, usdtAmount, bdtRate, feeUsdt, notes: form.notes.trim() })
    if (!res?.ok) {
      const msg = mutationError || 'Trade submit failed. Please retry; if it repeats, check server logs.'
      setSubmitError(msg)
      toast.error(msg)
      console.error('[trading.trade.submit_failed]', { accountId: activeAccount.id, tradeType: form.tradeType, message: msg })
      return
    }
    tradingDrafts.trade.clear()
    toast.success(form.tradeType === 'BUY' ? `Buy cost ৳${calc.netBdt.toLocaleString('en-BD')}` : calc.net >= 0 ? `Sell profit ৳${calc.net.toLocaleString('en-BD')}` : `Sell loss ৳${Math.abs(calc.net).toLocaleString('en-BD')}`)
    onCreated(res)
    onClose()
  }

  async function submitBkash(e: React.FormEvent) {
    e.preventDefault()
    if (!activeAccount) {
      toast.error('Select a trading account first.')
      return
    }
    const profit = n(bkashForm.totalProfitBdt)
    const loss = n(bkashForm.totalLossBdt)
    if (profit < 0 || loss < 0) { toast.error('Profit and loss must be 0 or greater'); return }
    if (!profit && !loss) { toast.error('Enter daily profit or loss'); return }
    const res = await addBkashSummary({
      tradingAccountId: activeAccount.id,
      summaryDate: bkashForm.summaryDate,
      totalOrders: 0,
      totalProfitBdt: profit,
      totalLossBdt: loss,
      notes: bkashForm.notes,
    })
    if (!res?.ok) { toast.error('Bkash summary save failed'); return }
    const net = profit - loss
    tradingDrafts.trade.clear()
    toast.success(net >= 0 ? `Bkash net profit ৳${net.toLocaleString('en-BD')}` : `Bkash net loss ৳${Math.abs(net).toLocaleString('en-BD')}`)
    onCreated(res)
    onClose()
  }

  const bkashNet = n(bkashForm.totalProfitBdt) - n(bkashForm.totalLossBdt)

  return (
    <ModalFrame
      open={open}
      onClose={onClose}
      title="Add Trade Entry"
      desc={activeAccount?.accountTitle || 'Choose account · Bkash summary or Bank/P2P'}
      footer={
        entryMode === 'BKASH' ? (
          <Button
            type="button"
            variant="gold"
            className="w-full justify-center"
            disabled={savingBkash}
            onClick={() => bkashFormRef.current?.requestSubmit()}
          >
            {savingBkash ? <><Spinner /> Saving</> : 'Save Bkash summary'}
          </Button>
        ) : (
          <Button
            type="button"
            variant="gold"
            className="w-full justify-center"
            disabled={loading}
            onClick={() => bankFormRef.current?.requestSubmit()}
          >
            {loading ? <><Spinner /> Submitting trade...</> : 'Submit trade'}
          </Button>
        )
      }
    >
      {!account && accounts && accounts.length > 1 && (
        <Select
          value={selectedAccountId}
          onChange={setSelectedAccountId}
          options={accounts.map(a => ({ label: a.accountTitle, value: a.id }))}
          className="mb-4 w-full"
        />
      )}
      <div className="mb-4 rounded-2xl border border-border bg-black/20 p-2">
        <p className="mb-2 px-1 text-[10px] font-black uppercase tracking-[0.14em] text-zinc-500">Trade Type</p>
        <div className="grid grid-cols-2 gap-2">
          <button
            type="button"
            onClick={() => setEntryMode('BKASH')}
            className={`rounded-xl px-3 py-3 text-left transition-colors ${entryMode === 'BKASH' ? 'border border-gold-dim/50 bg-gold/15 text-gold-lt' : 'border border-border bg-card text-zinc-400 hover:text-cream'}`}
          >
            <span className="block text-sm font-black">BKASH</span>
            <span className="mt-1 block text-[10px] text-zinc-500">Fast daily profit/loss summary</span>
          </button>
          <button
            type="button"
            onClick={() => setEntryMode('BANK')}
            className={`rounded-xl px-3 py-3 text-left transition-colors ${entryMode === 'BANK' ? 'border border-gold-dim/50 bg-gold/15 text-gold-lt' : 'border border-border bg-card text-zinc-400 hover:text-cream'}`}
          >
            <span className="block text-sm font-black">BANK / P2P</span>
            <span className="mt-1 block text-[10px] text-zinc-500">USDT, rates, fees, P/L engine</span>
          </button>
        </div>
      </div>

      {entryMode === 'BKASH' ? (
      <form ref={bkashFormRef} id="trade-entry-bkash-form" onSubmit={e => void submitBkash(e)} className="space-y-3">
        <div className="rounded-2xl border border-gold-dim/20 bg-gold/[0.04] p-3">
          <p className="text-xs font-bold text-cream">Bkash Quick Daily Result</p>
          <p className="mt-1 text-[11px] text-zinc-500">Use this for 200-300+ tiny merchant actions. No USDT, rate, or fee fields are required.</p>
        </div>
        <Input type="date" value={bkashForm.summaryDate} onChange={e => setBkashForm(f => ({ ...f, summaryDate: e.target.value }))} />
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Input autoFocus inputMode="decimal" type="number" min="0" step="0.01" value={bkashForm.totalProfitBdt} onChange={e => setBkashForm(f => ({ ...f, totalProfitBdt: e.target.value }))} placeholder="Total daily profit (BDT)" className="text-lg font-bold tabular-nums" />
          <Input inputMode="decimal" type="number" min="0" step="0.01" value={bkashForm.totalLossBdt} onChange={e => setBkashForm(f => ({ ...f, totalLossBdt: e.target.value }))} placeholder="Total daily loss (BDT)" className="text-lg font-bold tabular-nums" />
        </div>
        <div className={`rounded-2xl border p-4 ${bkashNet >= 0 ? 'border-green-400/25 bg-green-400/10' : 'border-red-400/25 bg-red-400/10'}`}>
          <p className="text-[10px] font-black uppercase tracking-[0.16em] text-zinc-500">Net result = profit - loss</p>
          <p className={`mt-1 text-3xl font-black tabular-nums ${signedClass(bkashNet)}`}>{bkashNet >= 0 ? '+' : '-'}৳{Math.abs(bkashNet).toLocaleString('en-BD')}</p>
        </div>
        <textarea value={bkashForm.notes} onChange={e => setBkashForm(f => ({ ...f, notes: e.target.value }))} className="min-h-20 w-full rounded-xl border border-border bg-card px-4 py-3 text-sm text-cream outline-none focus:border-gold-dim/60" placeholder="Optional notes" />
      </form>
      ) : (
      <form ref={bankFormRef} id="trade-entry-bank-form" noValidate onSubmit={e => void submit(e)} className="space-y-3">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-4">
          <Select value={form.tradeType} onChange={v => setForm(f => ({ ...f, tradeType: v as 'BUY' | 'SELL' }))} options={[
            { label: 'BUY', value: 'BUY' },
            { label: 'SELL', value: 'SELL' },
          ]} />
          <Input autoFocus inputMode="decimal" type="number" min="0" step="any" value={form.usdtAmount} onChange={e => setForm(f => ({ ...f, usdtAmount: e.target.value }))} placeholder="USDT amount" className="text-lg font-bold tabular-nums" />
          <Input inputMode="decimal" type="number" min="0" step="any" value={form.bdtRate} onChange={e => setForm(f => ({ ...f, bdtRate: e.target.value }))} placeholder="BDT Rate" className="text-lg font-bold tabular-nums" />
          <Input inputMode="decimal" type="number" min="0" step="any" value={form.feeUsdt} onChange={e => setForm(f => ({ ...f, feeUsdt: e.target.value }))} placeholder="Binance Fee (USDT)" className="text-lg font-bold tabular-nums" />
        </div>
        <div className="grid grid-cols-2 gap-2 text-center text-[11px] sm:grid-cols-4">
          <div className="rounded-xl border border-border bg-black/20 p-2"><p className="text-zinc-500">{form.tradeType === 'BUY' ? 'Total BDT' : 'Sell BDT'}</p><p className="font-bold text-cream">৳{calc.totalBdt.toLocaleString('en-BD')}</p></div>
          <div className="rounded-xl border border-border bg-black/20 p-2"><p className="text-zinc-500">Fee BDT</p><p className="font-bold text-amber-300">৳{calc.feeBdt.toLocaleString('en-BD')}</p></div>
          <div className="rounded-xl border border-border bg-black/20 p-2"><p className="text-zinc-500">{form.tradeType === 'BUY' ? 'Net Buy Cost' : 'Net Receive'}</p><p className="font-bold text-gold-lt">৳{calc.netBdt.toLocaleString('en-BD')}</p></div>
          <div className="rounded-xl border border-border bg-black/20 p-2"><p className="text-zinc-500">Avg Cost</p><p className="font-bold text-zinc-300">৳{calc.avgCostRate.toLocaleString('en-BD', { maximumFractionDigits: 4 })}</p></div>
        </div>
        <div className={`rounded-2xl border p-4 ${calc.net >= 0 ? 'border-green-400/25 bg-green-400/10' : 'border-red-400/25 bg-red-400/10'}`}>
          <p className="text-[10px] font-black uppercase tracking-[0.16em] text-zinc-500">{form.tradeType === 'BUY' ? 'Net cost' : 'Live profit / loss'}</p>
          <p className={`mt-1 text-3xl font-black tabular-nums ${form.tradeType === 'BUY' ? 'text-gold-lt' : signedClass(calc.net)}`}>{form.tradeType === 'BUY' ? '' : calc.net >= 0 ? '+' : '-'}৳{Math.abs(form.tradeType === 'BUY' ? calc.netBdt : calc.net).toLocaleString('en-BD')}</p>
        </div>
        <textarea value={form.notes} onChange={e => setForm(f => ({ ...f, notes: e.target.value }))} className="min-h-20 w-full rounded-xl border border-border bg-card px-4 py-3 text-sm text-cream outline-none focus:border-gold-dim/60" placeholder="Notes" />
        {(submitError || mutationError) && <p className="rounded-xl border border-red-400/25 bg-red-400/10 px-3 py-2 text-xs font-semibold text-red-200">{submitError || mutationError}</p>}
      </form>
      )}
    </ModalFrame>
  )
}

export function ExpenseEntryModal({ open, account, accounts, onClose, onCreated }: { open: boolean; account?: TradingAccount | null; accounts?: TradingAccount[]; onClose: () => void; onCreated: (res: TradingMutationResponse) => void }) {
  const { mutate, loading } = useAddTradingExpense()
  const { mutate: upload, loading: uploading } = useUploadTradingAttachment()
  const formRef = useRef<HTMLFormElement>(null)
  const [form, setForm] = useState({ tradingAccountId: '', expenseType: 'Mobile', amount: '', notes: '', attachmentUrl: '' })
  useEffect(() => { if (open) setForm(f => ({ ...f, tradingAccountId: account?.id || accounts?.[0]?.id || '', amount: '', notes: '', attachmentUrl: '' })) }, [account?.id, accounts, open])

  async function onFile(file?: File) {
    if (!file) return
    const res = await upload(file)
    if (res?.ok) {
      setForm(f => ({ ...f, attachmentUrl: res.attachment.url }))
      toast.success('Attachment uploaded')
    }
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (!form.tradingAccountId || n(form.amount) <= 0) { toast.error('Account and amount required'); return }
    const res = await mutate({ tradingAccountId: form.tradingAccountId, expenseType: form.expenseType, amount: n(form.amount), notes: form.notes, attachmentUrl: form.attachmentUrl || null })
    if (!res?.ok) { toast.error('Expense save failed'); return }
    toast.success('Expense added')
    onCreated(res)
    onClose()
  }

  return (
    <ModalFrame
      open={open}
      onClose={onClose}
      title={account ? 'Add account expense' : 'Expense entry'}
      desc="Account ledger expense. It also feeds global finance, analytics, and management reports."
      footer={
        <Button
          type="button"
          variant="gold"
          className="w-full justify-center"
          disabled={loading || uploading}
          onClick={() => formRef.current?.requestSubmit()}
        >
          {loading ? <><Spinner /> Saving</> : 'Add expense'}
        </Button>
      }
    >
      <form ref={formRef} id="expense-entry-form" onSubmit={e => void submit(e)} className="space-y-3">
        {!account && <Select value={form.tradingAccountId} onChange={v => setForm(f => ({ ...f, tradingAccountId: v }))} options={(accounts ?? []).map(a => ({ label: a.accountTitle, value: a.id }))} className="w-full" />}
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Select value={form.expenseType} onChange={v => setForm(f => ({ ...f, expenseType: v }))} options={EXPENSE_TYPES.map(t => ({ label: t, value: t }))} />
          <Input inputMode="decimal" type="number" min="0" step="0.01" value={form.amount} onChange={e => setForm(f => ({ ...f, amount: e.target.value }))} placeholder="Expense Amount (BDT)" />
        </div>
        <input type="file" accept="image/*,application/pdf" onChange={e => void onFile(e.target.files?.[0])} className="w-full rounded-xl border border-border bg-card px-3 py-2 text-xs text-zinc-400 file:mr-3 file:rounded-lg file:border-0 file:bg-gold/10 file:px-3 file:py-1.5 file:text-gold-lt" />
        {uploading && <p className="text-[11px] text-zinc-500">Uploading attachment...</p>}
        {form.attachmentUrl && <p className="text-[11px] text-green-400">Attachment ready</p>}
        <textarea value={form.notes} onChange={e => setForm(f => ({ ...f, notes: e.target.value }))} className="min-h-20 w-full rounded-xl border border-border bg-card px-4 py-3 text-sm text-cream outline-none focus:border-gold-dim/60" placeholder="Notes" />
      </form>
    </ModalFrame>
  )
}

export function CapitalEntryModal({ open, account, onClose, onCreated }: { open: boolean; account: TradingAccount | null; onClose: () => void; onCreated: (res: TradingMutationResponse) => void }) {
  const { mutate, loading } = useAddTradingCapital()
  const [form, setForm] = useState<{ entryType: TradingCapitalEntryType; amount: string; notes: string }>({ entryType: 'DEPOSIT', amount: '', notes: '' })
  useEffect(() => { if (open) setForm({ entryType: 'DEPOSIT', amount: '', notes: '' }) }, [open])
  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (!account || n(form.amount) === 0) { toast.error('Amount required'); return }
    const res = await mutate({ tradingAccountId: account.id, entryType: form.entryType, amount: n(form.amount), notes: form.notes })
    if (!res?.ok) { toast.error('Capital entry failed'); return }
    toast.success('Capital entry posted')
    onCreated(res)
    onClose()
  }
  return (
    <ModalFrame open={open} onClose={onClose} title="Capital entry" desc={account?.accountTitle || 'Deposit, withdraw, or adjustment'}>
      <form onSubmit={e => void submit(e)} className="space-y-3">
        <Select value={form.entryType} onChange={v => setForm(f => ({ ...f, entryType: v as TradingCapitalEntryType }))} options={[
          { label: 'Deposit', value: 'DEPOSIT' },
          { label: 'Withdraw', value: 'WITHDRAW' },
          { label: 'Adjustment', value: 'ADJUSTMENT' },
        ]} className="w-full" />
        <Input inputMode="decimal" type="number" step="0.01" value={form.amount} onChange={e => setForm(f => ({ ...f, amount: e.target.value }))} placeholder="Amount" />
        <textarea value={form.notes} onChange={e => setForm(f => ({ ...f, notes: e.target.value }))} className="min-h-20 w-full rounded-xl border border-border bg-card px-4 py-3 text-sm text-cream outline-none focus:border-gold-dim/60" placeholder="Notes" />
        <Button type="submit" variant="gold" className="w-full justify-center" disabled={loading}>{loading ? <><Spinner /> Posting</> : 'Post capital entry'}</Button>
      </form>
    </ModalFrame>
  )
}
