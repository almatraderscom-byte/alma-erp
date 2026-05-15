'use client'
import { api } from '@/lib/api'
import { useQuery, useMutation } from './useQuery'
import type { CditPayment } from '@/types/cdit'
import { useDateRange } from '@/contexts/DateRangeContext'

export function useCditDashboard() {
  return useQuery(() => api.digital.dashboard(), [], { pollMs: 60_000 })
}

export function useCditClients(search?: string) {
  return useQuery(
    () => api.digital.clients.list(search ? { search } : undefined),
    [search],
    { pollMs: 60_000 },
  )
}

export function useCditClientDetail(id: string) {
  return useQuery(
    () => api.digital.clients.detail(id),
    [id],
    { pollMs: 30_000 },
  )
}

export function useCditProjects(filters?: { status?: string; search?: string; client_id?: string }) {
  return useQuery(
    () => api.digital.projects.list(filters),
    [filters?.status, filters?.search, filters?.client_id],
    { pollMs: 45_000 },
  )
}

export function useCditInvoices(status?: string, clientId?: string) {
  return useQuery(
    () => api.digital.invoices.list({
      ...(status ? { status } : {}),
      ...(clientId ? { client_id: clientId } : {}),
    }),
    [status, clientId],
    { pollMs: 45_000 },
  )
}

export function useFinancialReport() {
  const { range } = useDateRange()
  return useQuery(
    () => api.finance.report({ startDate: range.start, endDate: range.end }),
    [range.start, range.end],
    { pollMs: 120_000 },
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
