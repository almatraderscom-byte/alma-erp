'use client'

import { createContext, useContext, type ReactNode } from 'react'
import useApprovalPendingCount from '@/hooks/useApprovalPendingCount'

type ApprovalCountValue = {
  count: number
  refresh: () => Promise<void>
}

const ApprovalCountContext = createContext<ApprovalCountValue | null>(null)

export function ApprovalCountProvider({ children }: { children: ReactNode }) {
  const value = useApprovalPendingCount()
  return <ApprovalCountContext.Provider value={value}>{children}</ApprovalCountContext.Provider>
}

export function useApprovalCount(): ApprovalCountValue {
  const ctx = useContext(ApprovalCountContext)
  if (!ctx) {
    throw new Error('useApprovalCount must be used within ApprovalCountProvider')
  }
  return ctx
}
