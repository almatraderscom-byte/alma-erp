'use client'

import { useEffect, useMemo, useState } from 'react'
import type { CallRow, Period } from '@/agent/lib/phone-console'
import { useJson } from './useJson'
import {
  ConsoleButton, DirectionMark, EmptyState, ErrorNote, PageHead, Panel, PeriodTabs, Pill,
  Segmented, TableWrap, Td, TextField, Th, clockBn, secs,
} from './ui'

type CallsResponse = { calls: CallRow[]; total: number; page: number; perPage: number }

const DIRECTIONS = [
  { value: 'all', label: 'সব' },
  { value: 'inbound', label: 'ইনকামিং' },
  { value: 'outbound', label: 'আউটগোয়িং' },
] as const
const STATUSES = [
  { value: 'all', label: 'সব' },
  { value: 'answered', label: 'ধরা হয়েছে' },
  { value: 'unreached', label: 'পৌঁছায়নি' },
  { value: 'recorded', label: 'রেকর্ডিং আছে' },
] as const

export default function CallLogView() {
  const [period, setPeriod] = useState<Period>('7d')
  const [direction, setDirection] = useState<(typeof DIRECTIONS)[number]['value']>('all')
  const [status, setStatus] = useState<(typeof STATUSES)[number]['value']>('all')
  const [number, setNumber] = useState('')
  const [debounced, setDebounced] = useState('')
  const [page, setPage] = useState(1)
  const [openId, setOpenId] = useState<string | null>(null)

  // Typing a number should not fire a query per keystroke.
  useEffect(() => {
    const t = setTimeout(() => setDebounced(number), 350)
    return () => clearTimeout(t)
  }, [number])
  // Any filter change invalidates the page cursor — page 7 of a narrower result is empty.
  useEffect(() => { setPage(1) }, [period, direction, status, debounced])

  const query = useMemo(() => {
    const q = new URLSearchParams({ period, direction, status, page: String(page), perPage: '25' })
    if (debounced.replace(/\D/g, '').length >= 6) q.set('number', debounced)
    return q.toString()
  }, [period, direction, status, page, debounced])

  const { data, error, loading } = useJson<CallsResponse>(`/api/assistant/phone-console/calls?${query}`)
  const total = data?.total ?? 0
  const pages = Math.max(1, Math.ceil(total / (data?.perPage ?? 25)))

  return (
    <>
      <PageHead
        title="কল লগ"
        subtitle="প্রতিটি কল — কে, কখন, কতক্ষণ, কী অবস্থায় শেষ হলো, আর কেন কাটল।"
        actions={<ConsoleButton href={`/api/assistant/phone-console/calls?${query}&format=csv`} download>CSV নামান</ConsoleButton>}
      />

      <Panel title="ছাঁকনি" className="mb-4">
        <div className="flex flex-wrap items-end gap-3">
          <div>
            <p className="mb-1 text-[11px] text-muted">সময়</p>
            <PeriodTabs value={period} onChange={setPeriod} />
          </div>
          <div>
            <p className="mb-1 text-[11px] text-muted">ধরন</p>
            <Segmented items={DIRECTIONS} value={direction} onChange={setDirection} size="sm" />
          </div>
          <div>
            <p className="mb-1 text-[11px] text-muted">অবস্থা</p>
            <Segmented items={STATUSES} value={status} onChange={setStatus} size="sm" />
          </div>
          <div className="min-w-[180px] flex-1">
            <TextField label="নম্বর" value={number} onChange={setNumber} placeholder="01… বা শেষ কয়েক ডিজিট" />
          </div>
        </div>
      </Panel>

      {error && <div className="mb-4"><ErrorNote>কল লগ আনা যায়নি: {error}</ErrorNote></div>}

      <Panel title="কলের তালিকা" badge={loading ? 'আনা হচ্ছে…' : `${total}টি কল`}>
        {!error && total === 0 && !loading && <EmptyState>এই ছাঁকনিতে কোনো কল নেই।</EmptyState>}

        {(data?.calls.length ?? 0) > 0 && (
          <TableWrap>
            <thead>
              <tr>
                <Th className="w-8" />
                <Th>নম্বর / নাম</Th>
                <Th>শুরু</Th>
                <Th>দৈর্ঘ্য</Th>
                <Th>অবস্থা</Th>
                <Th>কেন কাটল</Th>
                <Th>অডিও</Th>
                <Th className="w-8" />
              </tr>
            </thead>
            <tbody>
              {data?.calls.map((c) => (
                <CallRowView key={c.id} call={c} open={openId === c.id} onToggle={() => setOpenId(openId === c.id ? null : c.id)} />
              ))}
            </tbody>
          </TableWrap>
        )}

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

export function CallRowView({ call, open, onToggle }: { call: CallRow; open: boolean; onToggle: () => void }) {
  return (
    <>
      <tr className="cursor-pointer hover:bg-card/60" onClick={onToggle}>
        <Td><DirectionMark direction={call.direction} /></Td>
        <Td>
          <span className="font-semibold">{call.number}</span>
          {call.name && <span className="block truncate text-[11px] text-muted">{call.name}</span>}
        </Td>
        <Td className="whitespace-nowrap text-muted">{clockBn(call.startedAt)}</Td>
        <Td className="tabular-nums">{secs(call.durationSecs)}</Td>
        <Td><Pill tone={call.reached ? 'green' : 'red'}>{call.statusLabel}</Pill></Td>
        <Td className="text-muted">{call.hangupCauseLabel ?? call.hangupCauseTxt ?? '—'}</Td>
        <Td>
          {call.audio
            ? <span className={call.audio.underruns > 0 ? 'text-danger' : 'text-muted'}>{call.audio.underruns} / {call.audio.dropped}</span>
            : <span className="text-muted">—</span>}
        </Td>
        <Td className="text-muted">{open ? '▴' : '▾'}</Td>
      </tr>
      {open && (
        <tr>
          <td colSpan={8} className="border-b border-border-subtle/60 bg-card/40 px-3 py-3">
            <CallDetail call={call} />
          </td>
        </tr>
      )}
    </>
  )
}

export function CallDetail({ call }: { call: CallRow }) {
  return (
    <div className="space-y-3">
      {call.recordingUrl
        // eslint-disable-next-line jsx-a11y/media-has-caption
        ? <audio controls preload="none" src={call.recordingUrl} className="w-full" />
        : <p className="text-[11px] text-muted">এই কলের রেকর্ডিং নেই।</p>}

      <dl className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-[11px] md:grid-cols-4">
        <Fact k="ধরেছে" v={call.answeredAt ? clockBn(call.answeredAt) : '—'} />
        <Fact k="শেষ" v={call.endedAt ? clockBn(call.endedAt) : '—'} />
        <Fact k="কারণের কোড" v={call.hangupCause != null ? String(call.hangupCause) : '—'} />
        <Fact k="DID" v={call.did ?? '—'} />
        {call.transferredTo && <Fact k="ট্রান্সফার" v={`${call.transferredTo} · ${secs(call.transferTalkSecs)}`} />}
        {call.audio && (
          <>
            <Fact k="কেটেছে" v={`${call.audio.underruns} বার`} />
            <Fact k="ফ্রেম বাদ" v={String(call.audio.dropped)} />
            <Fact k="কুশন" v={`${call.audio.cushionFrames}f`} />
            <Fact k="বাধা দেওয়া" v={String(call.audio.bargeIns)} />
          </>
        )}
      </dl>

      {!call.audio && (
        <p className="text-[10px] text-muted">অডিওর হিসাব নেই — এই কলটা গেটওয়ের নতুন কোডের আগের।</p>
      )}

      {call.summary && (
        <p className="rounded-lg border border-border-subtle bg-card/70 px-3 py-2 text-[12px] leading-relaxed text-cream">
          {call.summary}
        </p>
      )}

      {call.transcript && (
        <details className="rounded-lg border border-border-subtle bg-card/70 px-3 py-2">
          <summary className="cursor-pointer text-[11px] text-muted">কথোপকথন ({call.transcript.length})</summary>
          <div className="mt-2 space-y-1.5">
            {call.transcript.map((t, i) => (
              <p key={i} className="text-[12px] leading-relaxed">
                <span className="text-muted">{t.role === 'user' ? 'কলার: ' : 'এজেন্ট: '}</span>
                <span className="text-cream">{t.message}</span>
              </p>
            ))}
          </div>
        </details>
      )}
    </div>
  )
}

function Fact({ k, v }: { k: string; v: string }) {
  return (
    <div>
      <dt className="text-muted">{k}</dt>
      <dd className="truncate text-cream">{v}</dd>
    </div>
  )
}
