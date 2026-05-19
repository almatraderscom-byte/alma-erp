'use client'

import { TradingPageShell } from '@/components/trading/TradingPageShell'
import { TradingTelegramAdmin } from '@/components/trading/TradingTelegramAdmin'
import { useActor } from '@/contexts/ActorContext'

export default function TradingTelegramPage() {
  const { role, userId } = useActor()
  const isAdmin = role === 'SUPER_ADMIN' || role === 'ADMIN'
  const isSuperAdmin = role === 'SUPER_ADMIN'
  const canReviewDrafts = role !== 'VIEWER'

  const subtitle = isAdmin
    ? 'Monitor Telegram capture · staff confirm their own drafts to ledger'
    : 'Review and confirm your Telegram trades — balances update only after you confirm'

  return (
    <TradingPageShell title="Telegram Quick Entry" subtitle={subtitle}>
      <TradingTelegramAdmin
        userId={userId}
        isAdmin={isAdmin}
        isSuperAdmin={isSuperAdmin}
        canReviewDrafts={canReviewDrafts}
      />
    </TradingPageShell>
  )
}
