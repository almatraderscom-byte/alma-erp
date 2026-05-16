'use client'
import { api } from '@/lib/api'
import { useQuery, useMutation } from './useQuery'
import type { CditPayment } from '@/types/cdit'
import { useDateRange } from '@/contexts/DateRangeContext'
import { useBusiness } from '@/contexts/BusinessContext'

export function useCditDashboard() {
  const { businessId } = useBusiness()
  return useQuery(() => api.digital.dashboard(), [businessId], { pollMs: 60_000, cacheKey: `cdit-dashboard:${businessId}`, cacheMs: 20_000 })
}

export function useCditClients(search?: string) {
  const { businessId } = useBusiness()
  return useQuery(
    () => api.digital.clients.list(search ? { search } : undefined),
    [businessId, search],
    { pollMs: 60_000, cacheKey: `cdit-clients:${businessId}:${search || ''}`, cacheMs: 20_000 },
  )
}

export function useCditClientDetail(id: string) {
  const { businessId } = useBusiness()
  return useQuery(
    () => api.digital.clients.detail(id),
    [businessId, id],
    { pollMs: 30_000 },
  )
}

export function useCditProjects(filters?: { status?: string; search?: string; client_id?: string }) {
  const { businessId } = useBusiness()
  return useQuery(
    () => api.digital.projects.list(filters),
    [businessId, filters?.status, filters?.search, filters?.client_id],
    { pollMs: 45_000, cacheKey: `cdit-projects:${businessId}:${filters?.status || ''}:${filters?.search || ''}:${filters?.client_id || ''}`, cacheMs: 20_000 },
  )
}

export function useCditInvoices(status?: string, clientId?: string) {
  const { businessId } = useBusiness()
  return useQuery(
    () => api.digital.invoices.list({
      ...(status ? { status } : {}),
      ...(clientId ? { client_id: clientId } : {}),
    }),
    [businessId, status, clientId],
    { pollMs: 45_000, cacheKey: `cdit-invoices:${businessId}:${status || ''}:${clientId || ''}`, cacheMs: 20_000 },
  )
}

export function useFinancialReport() {
  const { range } = useDateRange()
  const { businessId } = useBusiness()
  return useQuery(
    () => api.finance.report({ startDate: range.start, endDate: range.end }),
    [businessId, range.start, range.end],
    { pollMs: 120_000, cacheKey: `financial-report:${businessId}:${range.start}:${range.end}`, cacheMs: 30_000 },
  )
}

export function useCreateCditClient() {
  return useMutation(api.digital.clients.create)
}

export function useCreateCditProject() {
  return useMutation(api.digital.projects.create)
}

export function useCreateCditInvoice() {
  return useMutation(api.digital.invoices.create)
}

export function useCreateCditPayment() {
  return useMutation((p: Partial<CditPayment>) => api.digital.payments.create(p))
}
