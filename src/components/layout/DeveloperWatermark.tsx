'use client'

import { useEffect, useState } from 'react'
import { usePathname } from 'next/navigation'
import { PLATFORM_Z } from '@/lib/platform-z-index'
import { cn } from '@/lib/utils'

const PUBLIC_PREFIXES = ['/login', '/forgot-password', '/reset-password', '/invoice/share']
const FULL_TEXT = 'Developed by Maruf'
const TYPING_MS = 80
const SESSION_KEY = 'alma-developer-watermark-typed'

function useCompactBottom(): boolean {
  const pathname = usePathname() ?? ''
  return PUBLIC_PREFIXES.some(prefix => pathname.startsWith(prefix))
}

function StaticWatermarkText() {
  return (
    <>
      Developed by{' '}
      <span className="font-semibold tracking-[0.08em] text-gold/60 md:text-gold/65">Maruf</span>
    </>
  )
}

/**
 * Global developer credit — fixed, non-interactive, above mobile bottom nav.
 * Mounted from root layout via GlobalPlatformChrome (never per-page).
 */
export function DeveloperWatermark() {
  const compactBottom = useCompactBottom()
  const [displayed, setDisplayed] = useState('')
  const [typingComplete, setTypingComplete] = useState(false)
  const [clientReady, setClientReady] = useState(false)

  useEffect(() => {
    setClientReady(true)
    if (typeof window === 'undefined') return

    if (sessionStorage.getItem(SESSION_KEY) === '1') {
      setDisplayed(FULL_TEXT)
      setTypingComplete(true)
      return
    }

    let i = 0
    const interval = window.setInterval(() => {
      i += 1
      setDisplayed(FULL_TEXT.slice(0, i))
      if (i >= FULL_TEXT.length) {
        window.clearInterval(interval)
        sessionStorage.setItem(SESSION_KEY, '1')
        setTypingComplete(true)
      }
    }, TYPING_MS)

    return () => window.clearInterval(interval)
  }, [])

  const watermarkClass = cn(
    'developer-watermark pointer-events-none fixed right-3 select-none',
    'text-[10px] font-medium leading-none tracking-[0.14em] md:right-5 md:text-[11px]',
    'text-zinc-400/55 md:text-zinc-400/60',
    'print:hidden',
    compactBottom
      ? 'bottom-[max(0.75rem,env(safe-area-inset-bottom))]'
      : 'bottom-[calc(5.25rem+env(safe-area-inset-bottom))] md:bottom-5',
  )

  if (!clientReady) {
    return null
  }

  return (
    <p
      data-platform-watermark="true"
      style={{ zIndex: PLATFORM_Z.watermark }}
      className={watermarkClass}
      aria-hidden="true"
    >
      {typingComplete ? (
        <StaticWatermarkText />
      ) : (
        <>
          {displayed}
          <span className="animate-pulse">|</span>
        </>
      )}
    </p>
  )
}
