'use client'

import { useEffect, useRef } from 'react'

const GOLDS = ['#ffd97a', '#f3b13a', '#ffe6ad', '#e8a73a', '#fff0c4']

/**
 * Gold confetti overlay — a React port of the demo's makeConfetti(). Renders the
 * `.confetti` box and injects animated pieces on mount. `mini` uses fewer pieces
 * (for the small staff award card).
 */
export default function Confetti({ mini = false }: { mini?: boolean }) {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const box = ref.current
    if (!box) return
    box.innerHTML = ''
    const n = mini ? 14 : 26
    for (let i = 0; i < n; i++) {
      const p = document.createElement('i')
      p.style.left = Math.random() * 100 + '%'
      p.style.background = GOLDS[i % GOLDS.length]
      p.style.animationDuration = 2.6 + Math.random() * 2.4 + 's'
      p.style.animationDelay = -Math.random() * 4 + 's'
      p.style.width = 5 + Math.random() * 5 + 'px'
      p.style.height = 8 + Math.random() * 8 + 'px'
      if (Math.random() > 0.6) p.style.borderRadius = '50%'
      box.appendChild(p)
    }
    return () => {
      box.innerHTML = ''
    }
  }, [mini])

  return <div className="confetti" ref={ref}></div>
}
