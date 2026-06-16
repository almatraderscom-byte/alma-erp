'use client'

import { motion } from 'framer-motion'
import { TradingPageShell } from '@/components/trading/TradingPageShell'
import { TradingTelegramAdmin } from '@/components/trading/TradingTelegramAdmin'
import { useActor } from '@/contexts/ActorContext'

const stagger = { hidden: {}, show: { transition: { staggerChildren: 0.03 } } }
const fadeUp = { hidden: { opacity: 0, y: 6 }, show: { opacity: 1, y: 0, transition: { duration: 0.25 } } }

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
      <motion.div variants={stagger} initial="hidden" animate="show" className="space-y-5">
        <motion.div variants={fadeUp}>
          <TradingTelegramAdmin
            userId={userId}
            isAdmin={isAdmin}
            isSuperAdmin={isSuperAdmin}
            canReviewDrafts={canReviewDrafts}
          />
        </motion.div>
      </motion.div>
    </TradingPageShell>
  )
}
