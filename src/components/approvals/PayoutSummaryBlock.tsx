type Payout = {
  label?: string
  accountHolder?: string | null
  accountNumber?: string
  accountNumberMasked?: string
  isVerified?: boolean
  status?: string
}

export function PayoutSummaryBlock({ payout }: { payout?: Payout | null }) {
  if (!payout || payout.status === 'MISSING') {
    return (
      <p className="mt-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-2 py-1.5 text-[10px] font-bold text-amber-200">
        No payout method on file
      </p>
    )
  }

  const number = payout.accountNumber || payout.accountNumberMasked || '—'
  return (
    <div className="mt-2 rounded-lg border border-gold/25 bg-gold/5 px-2.5 py-2 text-[10px]">
      <p className="font-black uppercase tracking-wide text-gold-lt">Preferred payout</p>
      <p className="mt-1 font-bold text-cream">{payout.label}</p>
      {payout.accountHolder && <p className="text-zinc-400">{payout.accountHolder}</p>}
      <p className="font-mono text-sm text-gold-lt">{number}</p>
      <p className={`mt-1 font-bold ${payout.isVerified ? 'text-green-300' : 'text-amber-300'}`}>
        {payout.isVerified ? 'Verified' : 'Not verified'}
      </p>
    </div>
  )
}
