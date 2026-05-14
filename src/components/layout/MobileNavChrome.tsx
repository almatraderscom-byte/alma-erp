'use client'

import { usePathname } from 'next/navigation'
import { MobileNav } from '@/components/layout/Sidebar'

const HIDE_PREFIX = '/orders/new'

function useHideMobileChrome() {
  const path = usePathname()
  return path.startsWith(HIDE_PREFIX)
}

/** Extra scroll room above the fixed bottom tab bar (hidden on full-screen flows). */
export function MobileBottomSpacer() {
  const hide = useHideMobileChrome()
  if (hide) return null
  return <div className="h-16 md:hidden shrink-0" aria-hidden />
}

export function MobileNavBar() {
  const hide = useHideMobileChrome()
  if (hide) return null
  return <MobileNav />
}
