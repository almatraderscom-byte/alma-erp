'use client'

import { usePathname } from 'next/navigation'
import { useEffect } from 'react'

/**
 * Premium page-enter fade WITHOUT wrapping the page in a layout box (which would
 * risk breaking the app's many full-height / flex / scroll layouts). Instead, on
 * each route change it re-triggers a pure-opacity CSS animation on the EXISTING
 * content element(s) marked `[data-page-fade]`. Opacity only — no transform, no
 * size — so it can never shift or collapse a layout. Reduced-motion users get
 * nothing (handled in CSS).
 */
export function PageFade() {
  const pathname = usePathname()

  useEffect(() => {
    const els = document.querySelectorAll<HTMLElement>('[data-page-fade]')
    els.forEach((el) => {
      el.classList.remove('alma-page-enter')
      // Force a reflow so removing + re-adding the class restarts the animation.
      void el.offsetWidth
      el.classList.add('alma-page-enter')
    })
  }, [pathname])

  return null
}
