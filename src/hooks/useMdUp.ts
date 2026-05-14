'use client'
import { useLayoutEffect, useState } from 'react'

/** True when viewport is Tailwind `md` (768px) or wider. */
export function useMdUp() {
  const [mdUp, setMdUp] = useState(false)
  useLayoutEffect(() => {
    const mq = window.matchMedia('(min-width: 768px)')
    const apply = () => setMdUp(mq.matches)
    apply()
    mq.addEventListener('change', apply)
    return () => mq.removeEventListener('change', apply)
  }, [])
  return mdUp
}
