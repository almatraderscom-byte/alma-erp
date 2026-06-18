'use client'

import Link from 'next/link'
import { Card, Empty, Money, Skeleton } from '@/components/ui'
import { signedClass } from '@/components/trading/trading-utils'
import type { TradingAccount } from '@/types/trading'
import type { TradingWorkflowAction } from '@/components/trading/TradingWorkflowActions'

type AccountRow = {
  id: string
  accountTitle: string
  currentBalance: number
  dailyPl: number
  health: string
  screenshotToday?: boolean
  screenshotCompliance?: 'COMPLETE' | 'DUE' | 'OVERDUE' | 'NOT_REQUIRED'
}

function complianceBadge(status?: AccountRow['screenshotCompliance'], today?: boolean) {
  if (today || status === 'COMPLETE') {
    return <span className="rounded-full border border-green-200 bg-green-50 px-2 py-0.5 text-[9px] font-bold text-green-600">Today ✓</span>
  }
  if (status === 'OVERDUE') {
    return <span className="rounded-full border border-red-200 bg-red-50 px-2 py-0.5 text-[9px] font-bold text-red-600">Screenshot overdue</span>
  }
  if (status === 'DUE') {
    return <span className="rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5 text-[9px] font-bold text-amber-600">Screenshot due</span>
  }
  return null
}

export function MyTradingAccounts({
  accounts,
  performance,
  loading,
  onAction,
}: {
  accounts: TradingAccount[]
  performance: AccountRow[]
  loading: boolean
  onAction: (action: Exclude<TradingWorkflowAction, 'accounts'>, accountId: string) => void
}) {
  const perfById = new Map(performance.map(row => [row.id, row]))

  return (
    <Card className="overflow-hidden rounded-2xl">
      <div className="flex items-center justify-between border-b border-white/[0.06] px-4 py-3">
        <div>
          <p className="text-sm font-bold text-cream">My accounts</p>
          <p className="text-[11px] text-muted">Daily ops · screenshot status per account</p>
        </div>
        <Link href="/trading/accounts" className="text-[11px] font-bold text-gold">
          View all
        </Link>
      </div>
      {loading ? (
        <div className="space-y-2 p-4">
          <Skeleton className="h-20" />
          <Skeleton className="h-20" />
        </div>
      ) : !accounts.length ? (
        <Empty icon="◇" title="No active accounts assigned" />
      ) : (
        <div className="divide-y divide-white/[0.06]">
          {accounts.slice(0, 12).map(account => {
            const perf = perfById.get(account.id)
            const needsScreenshot = perf?.screenshotCompliance === 'DUE' || perf?.screenshotCompliance === 'OVERDUE'
            return (
              <div key={account.id} className="px-4 py-3">
                <Link href={`/trading/accounts/${account.id}`} className="block min-w-0">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-bold text-cream">{account.accountTitle}</p>
                      <div className="mt-1 flex flex-wrap items-center gap-1.5">
                        <p className="text-[10px] text-muted">{account.binanceUid || 'No UID'}</p>
                        {complianceBadge(perf?.screenshotCompliance, perf?.screenshotToday)}
                      </div>
                    </div>
                    <div className="shrink-0 text-right">
                      <p className="text-xs font-bold text-gold">
                        <Money amount={perf?.currentBalance ?? Number(account.startingCapital || 0)} />
                      </p>
                      {perf && (
                        <p className={`mt-0.5 text-[10px] font-bold tabular-nums ${signedClass(perf.dailyPl)}`}>
                          Today <Money amount={perf.dailyPl} />
                        </p>
                      )}
                    </div>
                  </div>
                </Link>
                <div className="mt-3 grid grid-cols-3 gap-2">
                  <MiniAction label="Trade" onClick={() => onAction('trade', account.id)} />
                  <MiniAction
                    label="Screenshot"
                    emphasis={needsScreenshot}
                    onClick={() => onAction('screenshot', account.id)}
                  />
                  <MiniAction label="Summary" onClick={() => onAction('summary', account.id)} />
                </div>
              </div>
            )
          })}
        </div>
      )}
    </Card>
  )
}

function MiniAction({ label, onClick, emphasis }: { label: string; onClick: () => void; emphasis?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`min-h-[40px] touch-manipulation rounded-xl border px-2 py-2 text-[10px] font-bold uppercase tracking-wide active:bg-white/[0.06] ${
        emphasis ? 'trading-upload-emphasis border-gold/25 bg-gold/8 text-gold' : 'border-white/[0.06] bg-card/85 text-muted'
      }`}
    >
      {label}
    </button>
  )
}
