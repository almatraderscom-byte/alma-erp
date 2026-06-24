'use client'

import { usePathname } from 'next/navigation'
import { MobileNav } from '@/components/layout/Sidebar'

const HIDE_PREFIXES = ['/orders/new', '/agent', '/portal/office']

function useHideMobileChrome() {
  const path = usePathname() ?? ''
  return HIDE_PREFIXES.some((prefix) => path.startsWith(prefix))
}

/** Extra scroll room above the fixed bottom tab bar (hidden on full-screen flows). */
export function MobileBottomSpacer() {
  const hide = useHideMobileChrome()
  if (hide) return null
  return <div className="h-[calc(6rem+env(safe-area-inset-bottom))] shrink-0 md:hidden" aria-hidden />
}

export function MobileNavBar() {
  const hide = useHideMobileChrome()
  if (hide) return null
  return <MobileNav />
}
