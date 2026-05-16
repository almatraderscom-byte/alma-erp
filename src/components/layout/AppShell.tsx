'use client'
import type { ReactNode } from 'react'

/** @deprecated ERP chrome is composed in AppProviders — this is a compatibility no-op wrapper. */
export function AppShell({ children }: { children: ReactNode }) {
  return <>{children}</>
}
