'use client'
import {
  createContext,
  useContext,
  useMemo,
  useRef,
  type ReactNode,
} from 'react'
import { usePathname } from 'next/navigation'
import { useQuery } from '@/hooks/useQuery'
import { api } from '@/lib/api'
import { useBusiness } from '@/contexts/BusinessContext'
import { useDateRange } from '@/contexts/DateRangeContext'
import { filterOrdersByBusiness } from '@/lib/business-filter'
import {
  logOrdersBusinessGuard,
  logOrdersContextInvalid,
  logOrdersProviderMissing,
  logOrdersRouteMismatch,
  ordersDataActiveForRoute,
} from '@/lib/orders-context-log'
import type { Order } from '@/types'
import type { BusinessId } from '@/lib/businesses'

export interface OrdersDataContextValue {
  orders: Order[]
  loading: boolean
  /** True only on first fetch when no cached rows yet — use for skeletons, not refetch/search. */
  initialLoading: boolean
  error: string | null
  refetch: () => void
  /** True when this business/route should load lifestyle orders. */
  enabled: boolean
  /** False for default context fallback (provider not in tree). */
  fromProvider: boolean
}

const EMPTY_ORDERS_VALUE: OrdersDataContextValue = {
  orders: [],
  loading: false,
  initialLoading: false,
  error: null,
  refetch: () => {},
  enabled: false,
  fromProvider: false,
}

/** Default context value — hooks never crash when provider is absent. */
const OrdersDataContext = createContext<OrdersDataContextValue>(EMPTY_ORDERS_VALUE)

function resolveSafeOrdersValue(
  ctx: OrdersDataContextValue,
  pathname: string,
  businessId: BusinessId,
  component: string,
): OrdersDataContextValue {
  const routeActive = ordersDataActiveForRoute(pathname, businessId)

  if (businessId !== 'ALMA_LIFESTYLE') {
    logOrdersBusinessGuard({ pathname, businessId, component })
    return EMPTY_ORDERS_VALUE
  }

  if (!routeActive) {
    logOrdersRouteMismatch({ pathname, businessId, component })
    return EMPTY_ORDERS_VALUE
  }

  if (!ctx.enabled) {
    logOrdersContextInvalid({
      pathname,
      businessId,
      component,
      reason: 'provider_disabled_for_route',
    })
    return EMPTY_ORDERS_VALUE
  }

  return ctx
}

/**
 * Shared lifestyle orders cache — mounted for all authenticated ERP routes.
 * Fetches only when business + route require orders data.
 */
export function OrdersDataProvider({ children }: { children: ReactNode }) {
  const { businessId } = useBusiness()
  const pathname = usePathname()
  const { range } = useDateRange()
  const enabled = ordersDataActiveForRoute(pathname ?? '', businessId)

  const { data, loading, initialLoading, error, refetch } = useQuery(
    () =>
      api.orders.list({
        limit: '5000',
        startDate: range.start,
        endDate: range.end,
      }),
    [businessId, range.start, range.end, enabled],
    {
      pollMs: enabled ? 45_000 : 0,
      cacheKey: enabled ? `orders:${businessId}:${range.start}:${range.end}` : undefined,
      cacheMs: enabled ? 20_000 : 0,
      enabled,
    },
  )

  const orders = useMemo(
    () => (enabled ? filterOrdersByBusiness(data?.orders ?? [], businessId) : []),
    [data, businessId, enabled],
  )

  const value = useMemo(
    (): OrdersDataContextValue => ({
      orders,
      loading: enabled ? loading : false,
      initialLoading: enabled ? initialLoading : false,
      error: enabled ? (error ?? null) : null,
      refetch: enabled ? refetch : () => {},
      enabled,
      fromProvider: true,
    }),
    [orders, loading, initialLoading, error, refetch, enabled],
  )

  return (
    <OrdersDataContext.Provider value={value}>
      {children}
    </OrdersDataContext.Provider>
  )
}

/** Provider-safe orders hook — never throws; returns inert data outside lifestyle routes. */
export function useOrdersData(component = 'useOrdersData'): OrdersDataContextValue {
  const ctx = useContext(OrdersDataContext)
  const pathname = usePathname() ?? ''
  const { businessId } = useBusiness()
  const warnedRef = useRef(false)

  if (!ctx.fromProvider && !warnedRef.current) {
    warnedRef.current = true
    logOrdersProviderMissing({
      pathname,
      businessId,
      component,
      componentStack: component,
    })
  }

  return resolveSafeOrdersValue(ctx, pathname, businessId, component)
}

/** @deprecated Alias for useOrdersData — kept for shared widgets / legacy imports. */
export const useOrdersContext = useOrdersData

/** Order KPI stats derived from shared orders context (never throws). */
export function useOrderStats(component = 'useOrderStats') {
  const { orders, loading, error, enabled } = useOrdersData(component)
  return { orders, loading, error, enabled, count: orders.length }
}

/** Strict semantic alias — same safe behavior as useOrdersData (no throws). */
export function useOrdersDataRequired(component = 'useOrdersDataRequired'): OrdersDataContextValue {
  return useOrdersData(component)
}
