'use client'

import { useEffect, useState } from 'react'
import { usePathname } from 'next/navigation'
import { PLATFORM_Z } from '@/lib/platform-z-index'
import { cn } from '@/lib/utils'

const PUBLIC_PREFIXES = ['/login', '/forgot-password', '/reset-password', '/invoice/share']
const AGENT_PREFIX = '/agent'
const FULL_TEXT = 'Developed by Maruf'
const PREFIX = 'Developed by '
const TYPING_MS = 80
const ERASE_MS = 50
const HOLD_MS = 3_000
const PAUSE_MS = 1_000

type Phase = 'typing' | 'hold' | 'erasing' | 'pause'

function useCompactBottom(): boolean {
  const pathname = usePathname() ?? ''
  return PUBLIC_PREFIXES.some(prefix => pathname.startsWith(prefix))
}

function useAgentRoute(): boolean {
  const pathname = usePathname() ?? ''
  return pathname.startsWith(AGENT_PREFIX)
}

function WatermarkDisplay({ text, showCursor }: { text: string; showCursor: boolean }) {
  const marufStart = PREFIX.length
  if (text.length <= marufStart) {
    return (
      <>
        {text}
        {showCursor ? <span className="animate-pulse">|</span> : null}
      </>
    )
  }
  return (
    <>
      {PREFIX}
      <span className="font-semibold tracking-[0.08em] text-gold/60 md:text-gold/65">
        {text.slice(marufStart)}
      </span>
      {showCursor ? <span className="animate-pulse">|</span> : null}
    </>
  )
}

/**
 * Global developer credit — fixed, non-interactive, above mobile bottom nav.
 * Mounted from root layout via GlobalPlatformChrome (never per-page).
 */
export function DeveloperWatermark() {
  const compactBottom = useCompactBottom()
  const isAgent = useAgentRoute()
  const [displayed, setDisplayed] = useState('')
  const [showCursor, setShowCursor] = useState(true)
  const [clientReady, setClientReady] = useState(false)

  useEffect(() => {
    setClientReady(true)
  }, [])

  useEffect(() => {
    if (!clientReady) return

    let cancelled = false
    let phase: Phase = 'typing'
    let index = 0
    let timer: number

    const schedule = (ms: number, fn: () => void) => {
      timer = window.setTimeout(() => {
        if (!cancelled) fn()
      }, ms)
    }

    const run = () => {
      if (cancelled) return

      switch (phase) {
        case 'typing': {
          setShowCursor(true)
          if (index < FULL_TEXT.length) {
            index += 1
            setDisplayed(FULL_TEXT.slice(0, index))
            schedule(TYPING_MS, run)
          } else {
            phase = 'hold'
            setShowCursor(false)
            schedule(HOLD_MS, run)
          }
          break
        }
        case 'hold': {
          phase = 'erasing'
          setShowCursor(true)
          run()
          break
        }
        case 'erasing': {
          setShowCursor(true)
          if (index > 0) {
            index -= 1
            setDisplayed(FULL_TEXT.slice(0, index))
            schedule(ERASE_MS, run)
          } else {
            phase = 'pause'
            setDisplayed('')
            setShowCursor(false)
            schedule(PAUSE_MS, run)
          }
          break
        }
        case 'pause': {
          phase = 'typing'
          schedule(TYPING_MS, run)
          break
        }
      }
    }

    index = 0
    setDisplayed('')
    setShowCursor(true)
    schedule(TYPING_MS, run)

    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [clientReady])

  const watermarkClass = cn(
    'developer-watermark pointer-events-none fixed right-3 select-none',
    'text-[10px] font-medium leading-none tracking-[0.14em] md:right-5 md:text-[11px]',
    'text-zinc-400/55 md:text-zinc-400/60',
    'print:hidden',
    compactBottom
      ? 'bottom-[max(0.75rem,env(safe-area-inset-bottom))]'
      : 'bottom-[calc(5.25rem+env(safe-area-inset-bottom))] md:bottom-5',
  )

  if (!clientReady || isAgent) {
    return null
  }

  return (
    <p
      data-platform-watermark="true"
      style={{ zIndex: PLATFORM_Z.watermark }}
      className={watermarkClass}
      aria-hidden="true"
    >
      <WatermarkDisplay text={displayed} showCursor={showCursor} />
    </p>
  )
}
