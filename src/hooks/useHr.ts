'use client'
import { api } from '@/lib/api'
import { useQuery, useMutation } from './useQuery'
import { useDateRange } from '@/contexts/DateRangeContext'
import { useBusiness } from '@/contexts/BusinessContext'

export function useHREmployees() {
  const { businessId } = useBusiness()
  return useQuery(() => api.hr.employees(), [businessId], { pollMs: 90_000, cacheKey: `hr-employees:${businessId}`, cacheMs: 30_000 })
}

/** Full payroll timeline for one employee — not scoped to global date filter. */
export function useHRPayrollForEmployee(empId: string | null) {
  const { businessId } = useBusiness()
  return useQuery(
    () => (empId ? api.hr.payroll({ emp_id: empId }) : Promise.resolve(null)),
    [businessId, empId],
    { enabled: empId !== null, pollMs: 45_000 },
  )
}

export function useHRDashboard() {
  const { range } = useDateRange()
  const { businessId } = useBusiness()
  return useQuery(
    () => api.hr.dashboard({ startDate: range.start, endDate: range.end }),
    [businessId, range.start, range.end],
    { pollMs: 60_000, cacheKey: `hr-dashboard:${businessId}:${range.start}:${range.end}`, cacheMs: 20_000 },
  )
}

export function useHrSaveEmployee() {
  return useMutation((body: Record<string, unknown>) => api.hr.saveEmployee(body))
}

export function useHrAddPayroll() {
  return useMutation((body: Record<string, unknown>) => api.hr.addPayroll(body))
}
