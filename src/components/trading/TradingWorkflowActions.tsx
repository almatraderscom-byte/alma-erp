'use client'

import Link from 'next/link'
import { cn } from '@/lib/utils'

export type TradingWorkflowAction = 'trade' | 'screenshot' | 'summary' | 'accounts'

const ACTIONS: Array<{
  id: TradingWorkflowAction
  label: string
  short: string
  icon: string
  tone: string
}> = [
  { id: 'trade', label: 'Add Trade', short: 'Trade', icon: '＋', tone: 'border-gold/25 bg-gold/8 text-gold' },
  { id: 'screenshot', label: 'Upload Screenshot', short: 'Screenshot', icon: '▣', tone: 'border-blue-200 bg-blue-50 text-blue-600' },
  { id: 'summary', label: 'Daily Summary', short: 'Summary', icon: '◫', tone: 'border-green-200 bg-green-50 text-green-600' },
  { id: 'accounts', label: 'Accounts', short: 'Accounts', icon: '◧', tone: 'border-white/[0.06] bg-card/85 text-cream' },
]

export function TradingQuickActions({
  onAction,
  className,
  highlightScreenshot = false,
}: {
  onAction: (action: TradingWorkflowAction) => void
  className?: string
  highlightScreenshot?: boolean
}) {
  return (
    <div className={cn('grid grid-cols-2 gap-2 sm:grid-cols-4 sm:gap-3', className)}>
      {ACTIONS.map(action => {
        const body = (
          <>
            <span className="text-xl leading-none" aria-hidden>{action.icon}</span>
            <span className="mt-2 block text-sm font-bold leading-tight">{action.label}</span>
            <span className="mt-0.5 hidden text-[10px] font-medium text-muted sm:block">One tap · daily ops</span>
          </>
        )
        const cls = cn(
          'flex min-h-[88px] min-w-0 flex-col items-start justify-center rounded-2xl border px-4 py-3 text-left transition-colors active:scale-[0.98]',
          'touch-manipulation',
          action.tone,
          action.id === 'screenshot' && highlightScreenshot && 'trading-upload-emphasis',
        )
        if (action.id === 'accounts') {
          return (
            <Link key={action.id} href="/trading/accounts" className={cls}>
              {body}
            </Link>
          )
        }
        return (
          <button key={action.id} type="button" onClick={() => onAction(action.id)} className={cls}>
            {body}
          </button>
        )
      })}
    </div>
  )
}

export function TradingStickyBar({
  onAction,
  highlightScreenshot = false,
}: {
  onAction: (action: TradingWorkflowAction) => void
  highlightScreenshot?: boolean
}) {
  return (
    <div className="fixed inset-x-0 bottom-[calc(4rem+env(safe-area-inset-bottom))] z-[51] border-t border-white/[0.06] bg-transparent px-2 py-2 backdrop-blur-md md:hidden md:bottom-0 md:pb-[calc(0.5rem+env(safe-area-inset-bottom))]">
      <div className="mx-auto grid max-w-lg grid-cols-4 gap-1">
        {ACTIONS.map(action => {
          if (action.id === 'accounts') {
            return (
              <Link
                key={action.id}
                href="/trading/accounts"
                className="flex min-h-[52px] flex-col items-center justify-center rounded-xl text-[10px] font-bold text-muted active:bg-white/[0.06]"
              >
                <span className="text-base">{action.icon}</span>
                {action.short}
              </Link>
            )
          }
          return (
            <button
              key={action.id}
              type="button"
              onClick={() => onAction(action.id)}
              className={cn(
                'flex min-h-[52px] flex-col items-center justify-center rounded-xl text-[10px] font-bold active:bg-white/[0.06]',
                action.id === 'trade' ? 'text-gold' : action.id === 'screenshot' && highlightScreenshot ? 'text-gold trading-upload-emphasis' : 'text-muted',
              )}
            >
              <span className="text-base">{action.icon}</span>
              {action.short}
            </button>
          )
        })}
      </div>
    </div>
  )
}
