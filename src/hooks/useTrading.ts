'use client'
import { useCallback } from 'react'
import { api } from '@/lib/api'
import { useBusiness } from '@/contexts/BusinessContext'
import { useMutation, useQuery } from '@/hooks/useQuery'
import type { TradingAccountInput, TradingAnalyticsFilters, TradingBkashSummaryInput, TradingCapitalInput, TradingEmployeeReportInput, TradingExpenseInput, TradingHrProfileInput, TradingPartnershipSettleInput, TradingTradeActionInput, TradingTradeInput } from '@/types/trading'

export function useTradingAnalytics(filters?: TradingAnalyticsFilters) {
  const { businessId } = useBusiness()
  return useQuery(
    () => businessId === 'ALMA_TRADING' ? api.trading.analytics(filters) : Promise.resolve(null),
    [businessId, filters?.startDate, filters?.endDate, filters?.staffId, filters?.accountId, filters?.status, filters?.profitability, filters?.minRoi, filters?.maxRoi],
    { enabled: businessId === 'ALMA_TRADING', cacheKey: `trading-analytics:${businessId}:${JSON.stringify(filters || {})}`, cacheMs: 10_000 },
  )
}

export function useTradingDashboard() {
  const { businessId } = useBusiness()
  return useQuery(
    () => businessId === 'ALMA_TRADING' ? api.trading.dashboard() : Promise.resolve(null),
    [businessId],
    { enabled: businessId === 'ALMA_TRADING', cacheKey: `trading-dashboard:${businessId}`, cacheMs: 10_000 },
  )
}

export function useTradingSummary() {
  const { businessId } = useBusiness()
  return useQuery(
    () => businessId === 'ALMA_TRADING' ? api.trading.summary() : Promise.resolve(null),
    [businessId],
    { enabled: businessId === 'ALMA_TRADING', cacheKey: `trading-summary:${businessId}`, cacheMs: 10_000 },
  )
}

export function useTradingStaffSummary() {
  const { businessId } = useBusiness()
  return useQuery(
    () => businessId === 'ALMA_TRADING' ? api.trading.staffSummary() : Promise.resolve(null),
    [businessId],
    { enabled: businessId === 'ALMA_TRADING', cacheKey: `trading-staff-summary:${businessId}`, cacheMs: 10_000 },
  )
}

export function useTradingHr() {
  const { businessId } = useBusiness()
  return useQuery(
    () => businessId === 'ALMA_TRADING' ? api.trading.hr() : Promise.resolve(null),
    [businessId],
    { enabled: businessId === 'ALMA_TRADING', cacheKey: `trading-hr:${businessId}`, cacheMs: 10_000 },
  )
}

export function useTradingEmployeeReports(userId?: string) {
  const { businessId } = useBusiness()
  return useQuery(
    () => businessId === 'ALMA_TRADING' ? api.trading.employeeReports({ userId, limit: 40 }) : Promise.resolve({ reports: [] }),
    [businessId, userId],
    { enabled: businessId === 'ALMA_TRADING', cacheKey: `trading-hr-reports:${businessId}:${userId || 'all'}`, cacheMs: 10_000 },
  )
}

export function useTradingAccounts(filters?: { search?: string; status?: string }) {
  const { businessId } = useBusiness()
  return useQuery(
    () => businessId === 'ALMA_TRADING' ? api.trading.accounts(filters) : Promise.resolve(null),
    [businessId, filters?.search, filters?.status],
    { enabled: businessId === 'ALMA_TRADING', cacheKey: `trading-accounts:${businessId}:${filters?.search || ''}:${filters?.status || ''}`, cacheMs: 10_000 },
  )
}

export function useTradingAccountDetail(id: string | null) {
  const { businessId } = useBusiness()
  return useQuery(
    () => businessId === 'ALMA_TRADING' && id ? api.trading.accountDetail(id) : Promise.resolve(null),
    [businessId, id],
    { enabled: businessId === 'ALMA_TRADING' && Boolean(id), cacheKey: `trading-account:${businessId}:${id || ''}`, cacheMs: 10_000 },
  )
}

export function useTradingStaff() {
  const { businessId } = useBusiness()
  return useQuery(
    () => businessId === 'ALMA_TRADING' ? api.trading.staff() : Promise.resolve({ staff: [] }),
    [businessId],
    { enabled: businessId === 'ALMA_TRADING', cacheKey: `trading-staff:${businessId}`, cacheMs: 60_000 },
  )
}

export function useCreateTradingAccount() {
  return useMutation(useCallback((payload: TradingAccountInput) => api.trading.createAccount(payload), []))
}

export function useSaveTradingHrProfile() {
  return useMutation(useCallback((payload: TradingHrProfileInput) => api.trading.saveHrProfile(payload), []))
}

export function useSubmitTradingEmployeeReport() {
  return useMutation(useCallback((payload: TradingEmployeeReportInput) => api.trading.submitEmployeeReport(payload), []))
}

export function useUpdateTradingAccount() {
  return useMutation(useCallback((id: string, payload: Partial<TradingAccountInput> & { action?: 'update' | 'archive' }) => api.trading.updateAccount(id, payload), []))
}

export function useSubmitTradingTrade() {
  return useMutation(useCallback((payload: TradingTradeInput) => api.trading.submitTrade(payload), []))
}

export function useUpdateTradingTrade() {
  return useMutation(useCallback((id: string, payload: TradingTradeActionInput) => api.trading.updateTrade(id, payload), []))
}

export function useAddTradingExpense() {
  return useMutation(useCallback((payload: TradingExpenseInput) => api.trading.addExpense(payload), []))
}

export function useTradingPartnership(accountId: string) {
  return useQuery(
    () => (accountId ? api.trading.partnership(accountId) : Promise.resolve(null)),
    [accountId],
    { enabled: Boolean(accountId), cacheKey: `trading-partnership:${accountId}`, cacheMs: 15_000 },
  )
}

export function useSettleTradingPartnership() {
  return useMutation(useCallback((accountId: string, payload: TradingPartnershipSettleInput) => api.trading.settlePartnership(accountId, payload), []))
}

export function useAddTradingCapital() {
  return useMutation(useCallback((payload: TradingCapitalInput) => api.trading.addCapital(payload), []))
}

export function useAddTradingBkashSummary() {
  return useMutation(useCallback((payload: TradingBkashSummaryInput) => api.trading.addBkashSummary(payload), []))
}

export function useUploadTradingPerformanceScreenshot() {
  return useMutation(useCallback((accountId: string, file: File, payload: { shotDate?: string; note?: string; fingerprint?: string }) => api.trading.uploadPerformanceScreenshot(accountId, file, payload), []))
}

export function useUploadTradingAttachment() {
  return useMutation(useCallback((file: File) => api.trading.uploadAttachment(file), []))
}
