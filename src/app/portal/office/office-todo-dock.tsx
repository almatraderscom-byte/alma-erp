'use client'

import { useEffect, useState, type ReactNode } from 'react'

const BN = '০১২৩৪৫৬৭৮৯'
const bn = (n: number) => String(n).replace(/\d/g, (d) => BN[Number(d)])

/**
 * Office todolist DOCK — mirrors the agent chat's todo dock: pinned to the top of
 * the office scroller, collapsed to a one-line summary by default, expands to the
 * full scrollable list via the chevron, and remembers its open/closed state.
 */
export function OfficeTodoDock({
  storageKey,
  total,
  done,
  remaining,
  children,
}: {
  storageKey: string
  total: number
  done: number
  remaining: number
  children: ReactNode
}) {
  const [open, setOpen] = useState(false)
  useEffect(() => {
    try {
      setOpen(sessionStorage.getItem(storageKey) === '1')
    } catch {
      /* ignore */
    }
  }, [storageKey])

  const toggle = () =>
    setOpen((v) => {
      const next = !v
      try {
        sessionStorage.setItem(storageKey, next ? '1' : '0')
      } catch {
        /* ignore */
      }
      return next
    })

  if (total === 0) return null

  return (
    <div className={`todo-dock${open ? ' open' : ''}`}>
      <button className="todo-dock-head" onClick={toggle} aria-expanded={open}>
        <span className="todo-dock-ic" aria-hidden>
          📋
        </span>
        <span className="todo-dock-sum">
          আজকের টুডু
          <span className="muted">
            {' '}· {bn(total)} কাজ · {bn(remaining)} বাকি · {bn(done)} সম্পন্ন
          </span>
        </span>
        <span className="todo-dock-chev" aria-hidden>
          ⌄
        </span>
      </button>
      <div className="todo-dock-body">{children}</div>
    </div>
  )
}
