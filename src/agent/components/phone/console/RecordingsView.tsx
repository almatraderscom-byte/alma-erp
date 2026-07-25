'use client'

import { useEffect, useMemo, useState } from 'react'
import type { CallRow, Period } from '@/agent/lib/phone-console'
import { useJson } from './useJson'
import { CallDetail } from './CallLogView'
import {
  ConsoleButton, DirectionMark, EmptyState, ErrorNote, PageHead, Panel, PeriodTabs,
  TextField, clockBn, secs,
} from './ui'

type CallsResponse = { calls: CallRow[]; total: number; page: number; perPage: number }

/**
 * Recordings, laid out for listening rather than for scanning: one row per call, the player
 * one click away, the Bangla summary and transcript underneath. Links are re-signed on every
 * load, so an old call plays instead of failing silently on an expired URL.
 */
export default function RecordingsView() {
  const [period, setPeriod] = useState<Period>('7d')
  const [number, setNumber] = useState('')
  const [debounced, setDebounced] = useState('')
  const [page, setPage] = useState(1)
  const [openId, setOpenId] = useState<string | null>(null)

  useEffect(() => {
    const t = setTimeout(() => setDebounced(number), 350)
    return () => clearTimeout(t)
  }, [number])
  useEffect(() => { setPage(1) }, [period, debounced])

  const query = useMemo(() => {
    const q = new URLSearchParams({ period, status: 'recorded', page: String(page), perPage: '15' })
    if (debounced.replace(/\D/g, '').length >= 6) q.set('number', debounced)
    return q.toString()
  }, [period, page, debounced])

  const { data, error, loading } = useJson<CallsResponse>(`/api/assistant/phone-console/calls?${query}`)
  const total = data?.total ?? 0
  const pages = Math.max(1, Math.ceil(total / (data?.perPage ?? 15)))

  return (
    <>
      <PageHead
        title="রেকর্ডিং"
        subtitle="কলের রেকর্ডিং, বাংলা সারাংশ আর কথোপকথন — একসাথে। রেকর্ডিং ৩০ দিন থাকে।"
        actions={<PeriodTabs value={period} onChange={setPeriod} />}
      />

      <div className="mb-4 max-w-xs">
        <TextField label="নম্বর দিয়ে খুঁজুন" value={number} onChange={setNumber} placeholder="01…" />
      </div>

      {error && <div className="mb-4"><ErrorNote>রেকর্ডিং আনা যায়নি: {error}</ErrorNote></div>}

      <Panel title="রেকর্ড করা কল" badge={loading ? 'আনা হচ্ছে…' : `${total}টি`}>
        {!error && !loading && total === 0 && <EmptyState>এই সময়ে কোনো রেকর্ডিং নেই।</EmptyState>}

        <div className="space-y-2">
          {data?.calls.map((c) => {
            const open = openId === c.id
            return (
              <article key={c.id} className="rounded-xl border border-border-subtle bg-card/60">
                <button
                  type="button"
                  onClick={() => setOpenId(open ? null : c.id)}
                  className="flex w-full items-center gap-3 px-3 py-2.5 text-left"
                >
                  <DirectionMark direction={c.direction} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13px] font-semibold text-cream">{c.name || c.number}</span>
                    <span className="block truncate text-[11px] text-muted">{c.number} • {clockBn(c.startedAt)}</span>
                  </span>
                  <span className="shrink-0 text-[11px] tabular-nums text-muted">
                    {secs(c.recordingSecs ?? c.durationSecs)}
                  </span>
                  <span className="shrink-0 text-muted">{open ? '▴' : '▾'}</span>
                </button>
                {open && <div className="border-t border-border-subtle px-3 py-3"><CallDetail call={c} /></div>}
              </article>
            )
          })}
        </div>

        {pages > 1 && (
          <div className="mt-3 flex items-center justify-between text-[12px]">
            <ConsoleButton onClick={() => setPage((p) => Math.max(1, p - 1))}>← আগের</ConsoleButton>
            <span className="text-muted">পাতা {page} / {pages}</span>
            <ConsoleButton onClick={() => setPage((p) => Math.min(pages, p + 1))}>পরের →</ConsoleButton>
          </div>
        )}
      </Panel>
    </>
  )
}
