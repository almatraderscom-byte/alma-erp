'use client'
import {
  createContext,
  useContext,
  useMemo,
  type ReactNode,
} from 'react'
import { useQuery } from '@/hooks/useQuery'
import { api } from '@/lib/api'
import { useBusiness } from '@/contexts/BusinessContext'
import { useDateRange } from '@/contexts/DateRangeContext'
import { filterOrdersByBusiness } from '@/lib/business-filter'
import type { Order } from '@/types'

interface OrdersDataContextValue {
  orders: Order[]
  loading: boolean
  error: string | null
  refetch: () => void
}

const OrdersDataContext = createContext<OrdersDataContextValue | null>(null)

/** Orders filtered server-side by global date range + business — aligned with dashboard KPI source. */
export function OrdersDataProvider({ children }: { children: ReactNode }) {
  const { businessId } = useBusiness()
  const { range } = useDateRange()

  const { data, loading, error, refetch } = useQuery(
    () =>
      api.orders.list({
        limit: '5000',
        startDate: range.start,
        endDate: range.end,
      }),
    [businessId, range.start, range.end],
    { pollMs: 45_000 },
  )

  const orders = useMemo(
    () => filterOrdersByBusiness(data?.orders ?? [], businessId),
    [data, businessId],
  )

  const value = useMemo(
    () => ({
      orders,
      loading,
      error: error ?? null,
      refetch,
    }),
    [orders, loading, error, refetch],
  )

  return (
    <OrdersDataContext.Provider value={value}>
      {children}
    </OrdersDataContext.Provider>
  )
}

export function useOrdersData() {
  const ctx = useContext(OrdersDataContext)
  if (!ctx) throw new Error('useOrdersData must be used within OrdersDataProvider')
  return ctx
}
