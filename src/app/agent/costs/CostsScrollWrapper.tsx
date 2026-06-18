'use client'

import { useRef, type ReactNode } from 'react'
import { ScrollAffordances } from '@/agent/components/ScrollAffordances'

export function CostsScrollWrapper({ children }: { children: ReactNode }) {
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
