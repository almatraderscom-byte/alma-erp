'use client'
import { api } from '@/lib/api'
import { useQuery, useMutation } from './useQuery'
import { useDateRange } from '@/contexts/DateRangeContext'

export function useHREmployees() {
  return useQuery(() => api.hr.employees(), [], { pollMs: 90_000 })
}

/** Full payroll timeline for one employee — not scoped to global date filter. */
export function useHRPayrollForEmployee(empId: string | null) {
  return useQuery(
    () => (empId ? api.hr.payroll({ emp_id: empId }) : Promise.resolve(null)),
    [empId],
    { enabled: empId !== null, pollMs: 45_000 },
  )
}

export function useHRDashboard() {
  const { range } = useDateRange()
  return useQuery(
    () => api.hr.dashboard({ startDate: range.start, endDate: range.end }),
    [range.start, range.end],
    { pollMs: 60_000 },
  )
}

export function useHrSaveEmployee() {
  return useMutation((body: Record<string, unknown>) => api.hr.saveEmployee(body))
}

export function useHrAddPayroll() {
  return useMutation((body: Record<string, unknown>) => api.hr.addPayroll(body))
}
