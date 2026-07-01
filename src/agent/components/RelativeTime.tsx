'use client'

import { useEffect, useState } from 'react'

/**
 * Claude-app-style relative timestamp under chat messages — "৬ মিনিট আগে",
 * "২ ঘণ্টা আগে" — self-refreshing every minute so it never goes stale on screen.
 */

const BN_DIGITS = ['০', '১', '২', '৩', '৪', '৫', '৬', '৭', '৮', '৯'] as const

function bnNum(n: number): string {
  return String(n).replace(/\d/g, (d) => BN_DIGITS[Number(d)])
}

export function formatRelativeBn(iso: string, nowMs = Date.now()): string {
  const t = new Date(iso).getTime()
  if (Number.isNaN(t)) return ''
  const diffMin = Math.floor(Math.max(0, nowMs - t) / 60_000)
  if (diffMin < 1) return 'এইমাত্র'
  if (diffMin < 60) return `${bnNum(diffMin)} মিনিট আগে`
  const hr = Math.floor(diffMin / 60)
  if (hr < 24) return `${bnNum(hr)} ঘণ্টা আগে`
  const day = Math.floor(hr / 24)
  if (day < 7) return `${bnNum(day)} দিন আগে`
  return new Date(t).toLocaleDateString('bn-BD', {
    timeZone: 'Asia/Dhaka',
    day: 'numeric',
    month: 'short',
  })
}

export function RelativeTime({ iso, className }: { iso?: string; className?: string }) {
  const [nowMs, setNowMs] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNowMs(Date.now()), 60_000)
    return () => clearInterval(timer)
  }, [])

  if (!iso) return null
  const label = formatRelativeBn(iso, nowMs)
  if (!label) return null

  return (
    <span
      className={className}
      title={new Date(iso).toLocaleString('bn-BD', { timeZone: 'Asia/Dhaka' })}
    >
      {label}
    </span>
  )
}
