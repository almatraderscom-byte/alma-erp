'use client'

import { FinancePageChrome } from '@/components/finance/FinancePageChrome'
import { PaymentAccountsPanel } from '@/components/portal/PaymentAccountsPanel'
import { useBusiness } from '@/contexts/BusinessContext'
import { useSession } from 'next-auth/react'
import { isSystemOwner } from '@/lib/roles'
import Link from 'next/link'

export default function PaymentAccountsPage() {
  const { business } = useBusiness()
  const { data: session } = useSession()
  const systemOwner = isSystemOwner(session)

  if (systemOwner) {
    return (
      <FinancePageChrome title="Payment accounts" subtitle="">
        <p className="text-sm text-muted p-4">
          System owner accounts do not use employee payout profiles.{' '}
          <Link href="/portal" className="text-gold-lt font-bold">
            Back to My Desk
          </Link>
        </p>
      </FinancePageChrome>
    )
  }

  return (
    <FinancePageChrome title="Payment accounts" subtitle="Manage how you receive salary and wallet payouts">
      <div className="p-4 md:p-6 max-w-2xl">
        <PaymentAccountsPanel businessId={business.id} />
      </div>
    </FinancePageChrome>
  )
}
