'use client'

import { useMemo, useState } from 'react'
import type { Period, QualityDay, QualityWorst } from '@/agent/lib/phone-console-types'
import { useJson } from './useJson'
import {
  EmptyState, ErrorNote, Kpi, KpiRow, MiniBars, PageHead, Panel, PeriodTabs,
  TableWrap, Td, Th, clockBn, secs,
} from './ui'

type QualityResponse = { daily: QualityDay[]; worst: QualityWorst[]; days: number }

/**
 * Audio quality as a graph instead of as the owner's ear. An underrun is the playout queue
 * running dry mid-sentence — about 200 ms of dead air dropped into the middle of a word,
 * which is exactly what "কথার মাঝখানে কেটে যাচ্ছে" describes. Only calls the gateway actually
 * measured are counted, so old history does not dilute the numbers into looking fine.
 */
export default function QualityView() {
  const [period, setPeriod] = useState<Period>('30d')
  const { data, error, loading } = useJson<QualityResponse>(`/api/assistant/phone-console/quality?period=${period}`)

  const totals = useMemo(() => {
    const d = data?.daily ?? []
    return {
      measured: d.reduce((s, x) => s + x.measured, 0),
      withUnderruns: d.reduce((s, x) => s + x.withUnderruns, 0),
      underruns: d.reduce((s, x) => s + x.underruns, 0),
      dropped: d.reduce((s, x) => s + x.dropped, 0),
      measuredNetwork: d.reduce((s, x) => s + x.measuredNetwork, 0),
      lostPct: d.reduce((s, x) => s + x.avgRxLostPct * x.measuredNetwork, 0),
      jitter: d.reduce((s, x) => s + x.avgRxJitterMs * x.measuredNetwork, 0),
      worstLostPct: d.reduce((s, x) => Math.max(s, x.worstRxLostPct), 0),
    }
  }, [data])

  const pct = totals.measured ? Math.round((totals.withUnderruns / totals.measured) * 100) : 0

  return (
    <>
      <PageHead
        title="অডিও কোয়ালিটি"
        subtitle="কল শুনে নয়, সংখ্যা দেখে বোঝা — কথার মাঝখানে কতবার কেটেছে, কত ফ্রেম বাদ গেছে।"
        actions={<PeriodTabs value={period} onChange={setPeriod} />}
      />

      {error && <div className="mb-4"><ErrorNote>হিসাব আনা যায়নি: {error}</ErrorNote></div>}

      <KpiRow>
        <Kpi label="মাপা কল" value={totals.measured} sub="গেটওয়ে যেগুলোর হিসাব পাঠিয়েছে" />
        <Kpi
          label="অডিও কেটেছে"
          value={totals.withUnderruns}
          sub={totals.measured ? `মাপা কলের ${pct}%` : undefined}
          tone={totals.withUnderruns > 0 ? 'amber' : 'green'}
        />
        <Kpi label="মোট কাটা" value={totals.underruns} sub="একটা কাটা ≈ ০.২ সেকেন্ড নীরবতা" tone={totals.underruns > 0 ? 'amber' : 'slate'} />
        <Kpi label="বাদ যাওয়া ফ্রেম" value={totals.dropped} sub="পিছিয়ে পড়া সামলাতে এগিয়ে যাওয়া" />
      </KpiRow>

      {/* The network half, which no recording can contain: a call's audio is recorded inside
          our own server, before it ever goes on the wire. */}
      <div className="mt-3">
        <KpiRow>
          <Kpi
            label="নেটওয়ার্ক মাপা কল"
            value={totals.measuredNetwork}
            sub="যেগুলোর প্যাকেটের হিসাব আছে"
          />
          <Kpi
            label="গড়ে প্যাকেট হারানো"
            value={totals.measuredNetwork ? `${(totals.lostPct / totals.measuredNetwork).toFixed(2)}%` : '—'}
            sub="ওদের দিক থেকে আসা অডিওতে"
            tone={totals.measuredNetwork && totals.lostPct / totals.measuredNetwork > 1 ? 'red' : 'slate'}
          />
          <Kpi
            label="সবচেয়ে খারাপ কল"
            value={totals.worstLostPct ? `${totals.worstLostPct.toFixed(2)}%` : '—'}
            sub="এক কলে সর্বোচ্চ হারানো"
            tone={totals.worstLostPct > 2 ? 'amber' : 'slate'}
          />
          <Kpi
            label="গড় jitter"
            value={totals.measuredNetwork ? `${(totals.jitter / totals.measuredNetwork).toFixed(1)}ms` : '—'}
            sub="অডিও কতটা অসমান এসেছে"
          />
        </KpiRow>
      </div>

      <div className="mt-4 grid gap-4">
        <Panel title="দিনে দিনে">
          {loading && <EmptyState>আনা হচ্ছে…</EmptyState>}
          {!loading && totals.measured === 0 && (
            <EmptyState>
              এখনো কোনো কলের অডিও-হিসাব জমা হয়নি। গেটওয়ের নতুন কোড ওঠার পরের কল থেকে এখানে আসবে।
            </EmptyState>
          )}
          {totals.measured > 0 && (
            <MiniBars
              label="মোট মাপা কল — হালকা অংশ = যেগুলোর অডিও কেটেছে"
              data={(data?.daily ?? []).map((d) => ({ date: d.date, value: d.measured, sub: d.withUnderruns }))}
            />
          )}
        </Panel>

        <Panel title="সবচেয়ে খারাপ কল" badge={data?.worst.length ?? 0}>
          {(data?.worst.length ?? 0) === 0 && <EmptyState>কোনো কলে অডিও কাটেনি।</EmptyState>}
          {(data?.worst.length ?? 0) > 0 && (
            <TableWrap>
              <thead>
                <tr>
                  <Th>নম্বর</Th>
                  <Th>কখন</Th>
                  <Th>দৈর্ঘ্য</Th>
                  <Th>কেটেছে</Th>
                  <Th>ফ্রেম বাদ</Th>
                  <Th>প্যাকেট হারানো</Th>
                  <Th>কুশন</Th>
                </tr>
              </thead>
              <tbody>
                {data?.worst.map((w) => (
                  <tr key={w.id}>
                    <Td className="font-semibold">{w.number}</Td>
                    <Td className="whitespace-nowrap text-muted">{clockBn(w.startedAt)}</Td>
                    <Td className="tabular-nums">{secs(w.durationSecs)}</Td>
                    <Td className="tabular-nums text-danger">{w.underruns}</Td>
                    <Td className="tabular-nums">{w.dropped}</Td>
                    <Td className="tabular-nums">{w.rxLostPct != null ? `${w.rxLostPct.toFixed(2)}%` : '—'}</Td>
                    <Td className="tabular-nums">{w.cushionFrames}f</Td>
                  </tr>
                ))}
              </tbody>
            </TableWrap>
          )}
        </Panel>
      </div>

      <p className="mt-3 text-[11px] leading-relaxed text-muted">
        উপরের সারির সংখ্যা <b>আমাদের নিজের</b> — গেটওয়ে ঠিকমতো অডিও দিতে পেরেছে কিনা। নিচের সারি
        <b> নেটওয়ার্কের</b> — অডিও তারে ওঠার পর কী হয়েছে। এই দুটো আলাদা, কারণ রেকর্ডিং আমাদের
        সার্ভারের ভেতরে নেওয়া হয়, তারে ওঠার আগেই — তাই নেটওয়ার্কের ক্ষতি রেকর্ডিংয়ে কখনো থাকে না।
        সেজন্যই রেকর্ডিং পরিষ্কার শোনালেও কল খারাপ হতে পারে।
      </p>
    </>
  )
}
