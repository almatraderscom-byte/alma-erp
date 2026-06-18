'use client'

import { useRef, type ReactNode } from 'react'
import { ScrollAffordances } from '@/agent/components/ScrollAffordances'

/**
 * Client wrapper that owns the scroll container ref so we can attach the
 * floating top/bottom scroll buttons to the page-level scroll on the long
 * staff-monitor page.
 */
export function StaffMonitorScrollWrapper({ children }: { children: ReactNode }) {
  const scrollRef = useRef<HTMLDivElement>(null)
  return (
    <>
      <div ref={scrollRef} className="h-full min-h-0 overflow-y-auto">
        {children}
      </div>
      <ScrollAffordances containerRef={scrollRef} bottomThreshold={400} />
    </>
  )
}
