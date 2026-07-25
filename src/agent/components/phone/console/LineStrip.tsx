'use client'

import Link from 'next/link'
import type { LineView } from '@/agent/lib/phone-console-types'
import { Pill } from './ui'

/**
 * The one-line answer to "is my phone line up", shown at the top of the pages where it is
 * context rather than the subject. It is always labelled as OUR side's claim: the provider
 * keeps a single registration binding per account and only their table says who holds it —
 * believing our own "Registered" is what hid the outbound failure for two sessions.
 */
export function LineStrip({ line, href = '/agent/phone-console/line' }: { line: LineView | undefined; href?: string }) {
  const reg = line?.registration
  const unknown = !line || reg?.registered == null
  const ok = reg?.registered === true

  return (
    <Link
      href={href}
      className="mb-4 flex flex-wrap items-center gap-x-4 gap-y-2 rounded-2xl border border-border-subtle bg-card/60 px-4 py-2.5 transition-colors hover:border-[#E07A5F]/30"
    >
      <Pill tone={unknown ? 'slate' : ok ? 'green' : 'red'}>
        {unknown ? 'লাইনের খবর নেই' : ok ? 'লাইন রেজিস্টার্ড' : 'রেজিস্ট্রেশন নেই'}
      </Pill>
      {reg?.expiresIn != null && (
        <span className="text-[11px] text-muted">বাইন্ডিং বাকি <b className="text-cream">{reg.expiresIn}সে</b></span>
      )}
      <span className="text-[11px] text-muted">
        চলমান <b className="text-cream">{line?.counts.active ?? 0}</b>
        {line?.counts.maxConcurrent ? ` / ${line.counts.maxConcurrent}` : ''}
      </span>
      {line?.softphone.healthy != null && (
        <span className="text-[11px] text-muted">
          স্টাফ ফোন <b className={line.softphone.healthy ? 'text-cream' : 'text-danger'}>{line.softphone.healthy ? 'ঠিক আছে' : 'সমস্যা'}</b>
        </span>
      )}
      <span className="ml-auto text-[11px] text-muted">আমাদের দিকের হিসাব →</span>
    </Link>
  )
}
