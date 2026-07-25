'use client'

import { useEffect, useState } from 'react'
import { motion } from 'framer-motion'
import type { LineView } from '@/agent/lib/phone-console'
import { useJson } from './useJson'
import { LineStrip } from './LineStrip'
import {
  DirectionMark, EmptyState, ErrorNote, PageHead, Panel, Pill, TableWrap, Td, Th, secs,
} from './ui'

const STATE_BN: Record<string, string> = {
  ringing: 'রিং হচ্ছে',
  talking: 'কথা হচ্ছে',
  hold: 'হোল্ডে',
  transferring: 'ট্রান্সফার হচ্ছে',
  voicemail: 'ভয়েসমেইল',
  message: 'বার্তা শোনানো হচ্ছে',
}

export default function LiveView() {
  const { data, error } = useJson<{ line: LineView }>('/api/assistant/phone-console/overview?lineOnly=1', 3_000)
  // The clock ticks on its own so a call's elapsed time counts up smoothly instead of
  // jumping every poll.
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1_000)
    return () => clearInterval(t)
  }, [])

  const line = data?.line
  const active = line?.active ?? []
  const count = line?.counts.active ?? 0

  return (
    <>
      <PageHead
        title="লাইভ চ্যানেল"
        subtitle="এই মুহূর্তে লাইনে কে আছে, কোন অবস্থায়, কতক্ষণ ধরে। প্রতি ৩ সেকেন্ডে নিজে থেকে হালনাগাদ হয়।"
        actions={count > 0 ? (
          <span className="inline-flex items-center gap-2 text-[12px] text-cream">
            <motion.span
              animate={{ opacity: [1, 0.3, 1] }}
              transition={{ duration: 1.6, repeat: Infinity }}
              className="h-2 w-2 rounded-full bg-[#E07A5F]"
            />
            {count}টি চলছে
          </span>
        ) : undefined}
      />

      <LineStrip line={line} />
      {error && <div className="mb-4"><ErrorNote>গেটওয়ে থেকে উত্তর আসেনি: {error}</ErrorNote></div>}

      <Panel title="চলমান কল" badge={count}>
        {count === 0 && <EmptyState>এখন কোনো কল চলছে না।</EmptyState>}

        {count > 0 && !line?.liveDetail && (
          <EmptyState>
            {count}টি কল চলছে, কিন্তু বিস্তারিত দেখাতে VPS-এর গেটওয়েতে নতুন কোডটা লাগবে।
          </EmptyState>
        )}

        {active.length > 0 && (
          <TableWrap>
            <thead>
              <tr>
                <Th className="w-8" />
                <Th>কে</Th>
                <Th>নম্বর</Th>
                <Th>অবস্থা</Th>
                <Th>সময়</Th>
                <Th>অডিও</Th>
              </tr>
            </thead>
            <tbody>
              {active.map((c) => {
                const started = c.answeredAt ?? c.startedAt
                const elapsed = started ? Math.round((now - started) / 1000) : null
                const dir = c.direction === 'inbound' ? 'inbound' : c.direction === 'outbound' ? 'outbound' : 'unknown'
                return (
                  <tr key={c.id}>
                    <Td><DirectionMark direction={dir} /></Td>
                    <Td>
                      <span className="font-semibold">{c.name || '—'}</span>
                      {c.transferredTo && <span className="block text-[11px] text-muted">→ {c.transferredTo}</span>}
                    </Td>
                    <Td>
                      {(c.direction === 'inbound' ? c.from : c.to) || '—'}
                      {c.did && <span className="block text-[11px] text-muted">DID {c.did}</span>}
                    </Td>
                    <Td><Pill tone={c.state === 'talking' ? 'green' : c.state === 'hold' ? 'amber' : 'slate'}>{STATE_BN[c.state] ?? c.state}</Pill></Td>
                    <Td className="tabular-nums">{secs(elapsed)}</Td>
                    <Td>
                      {c.audio
                        ? <span className={c.audio.underruns > 0 ? 'text-danger' : 'text-muted'}>
                            {c.audio.underruns} কাটা · {c.audio.dropped} বাদ
                          </span>
                        : <span className="text-muted">—</span>}
                    </Td>
                  </tr>
                )
              })}
            </tbody>
          </TableWrap>
        )}
      </Panel>

      {line?.hourly && (
        <p className="mt-3 text-[11px] text-muted">
          এই ঘণ্টায় দেওয়া কল {line.hourly.placed} / {line.hourly.cap} · একসাথে সর্বোচ্চ {line.counts.maxConcurrent ?? '—'}টি লাইন।
        </p>
      )}
    </>
  )
}
