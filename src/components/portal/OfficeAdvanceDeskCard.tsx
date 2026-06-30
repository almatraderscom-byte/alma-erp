'use client'

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { Card, Button, Money } from '@/components/ui'
import { safeFetchJson } from '@/lib/safe-fetch'

type AdvanceRow = {
  id: string
  amount: number
  purpose: string | null
  status: string
  approvedAt: string | null
  createdAt: string
}
type AdvanceResponse = {
  ok?: boolean
  advances?: AdvanceRow[]
  outstanding?: { count: number; total: number }
}

/**
 * My Desk indicator for admins: office-fund advances they have drawn that are
 * still OUTSTANDING (approved, money received, not yet reconciled). Renders
 * nothing until it knows there is something outstanding — keeps the desk quiet
 * for admins who owe no account. Admin-only API; non-admins get 403 → hidden.
 */
export function OfficeAdvanceDeskCard({ businessId }: { businessId: string }) {
  const [outstanding, setOutstanding] = useState<{ count: number; total: number }>({ count: 0, total: 0 })
  const [rows, setRows] = useState<AdvanceRow[]>([])
  const [ready, setReady] = useState(false)

  const load = useCallback(async () => {
    const result = await safeFetchJson<AdvanceResponse>(
      `/api/finance/office-advance?business_id=${encodeURIComponent(businessId)}`,
      { cache: 'no-store' },
    )
    if (result.ok) {
      setOutstanding(result.data.outstanding || { count: 0, total: 0 })
      setRows((result.data.advances || []).filter((a) => a.status === 'OUTSTANDING'))
    }
    setReady(true)
  }, [businessId])

  useEffect(() => {
    void load()
  }, [load])

  // Hidden entirely unless the admin has an outstanding office account to settle.
  if (!ready || outstanding.count === 0) return null

  return (
    <Card className="p-5 border-sky-400/25 bg-card/78">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[10px] font-black uppercase tracking-[0.14em] text-sky-400">অফিস অ্যাডভান্স — হিসাব বাকি</p>
          <p className="mt-1 text-[11px] text-muted">
            অফিসের কাজে নেওয়া টাকার হিসাব দিন — কত খরচ হয়েছে আর কত ফেরত, তা জানান।
          </p>
        </div>
        <div className="shrink-0 text-right">
          <span className="text-lg font-bold txt-neg"><Money amount={outstanding.total} /></span>
          <p className="text-[10px] text-muted">{outstanding.count} টি বকেয়া</p>
        </div>
      </div>
      {rows.length > 0 && (
        <div className="mt-3 divide-y divide-border-subtle">
          {rows.slice(0, 3).map((a) => (
            <div key={a.id} className="flex items-center justify-between gap-3 py-2">
              <p className="min-w-0 truncate text-[11px] text-muted-hi">{a.purpose || 'অফিস অ্যাডভান্স'}</p>
              <span className="shrink-0 text-[12px] font-bold text-cream"><Money amount={a.amount} /></span>
            </div>
          ))}
        </div>
      )}
      <div className="mt-3 flex justify-end">
        <Link href="/finance/office-fund">
          <Button size="sm" variant="gold">হিসাব দিন →</Button>
        </Link>
      </div>
    </Card>
  )
}
