'use client'

import { useState } from 'react'
import Link from 'next/link'
import type { LineView, Period, Tally, TrendDay } from '@/agent/lib/phone-console-types'
import { useJson } from './useJson'
import { LineStrip } from './LineStrip'
import {
  ErrorNote, Kpi, KpiRow, MiniBars, PageHead, Panel, PeriodTabs, Pill, secs,
} from './ui'

type Overview = { line: LineView; tally: Tally | null; trend: TrendDay[] }

export default function DashboardView() {
  const [period, setPeriod] = useState<Period>('today')
  const { data, error, loading } = useJson<Overview>(`/api/assistant/phone-console/overview?period=${period}`, 15_000)
  const t = data?.tally

  return (
    <>
      <PageHead
        title="ড্যাশবোর্ড"
        subtitle="ফোন লাইনের এক নজরে অবস্থা — কত কল, কতটা ধরা হলো, কতটা পৌঁছায়নি।"
        actions={<PeriodTabs value={period} onChange={setPeriod} />}
      />

      <LineStrip line={data?.line} />
      {error && <div className="mb-4"><ErrorNote>তথ্য আনা যায়নি: {error}</ErrorNote></div>}

      <KpiRow>
        <Kpi label="মোট কল" value={t?.total ?? (loading ? '…' : 0)} sub={t ? `${t.inbound} ইন · ${t.outbound} আউট` : undefined} tone="coral" />
        <Kpi label="ধরা হয়েছে" value={t?.answered ?? 0} sub={t ? `সফল ${t.successPct}%` : undefined} tone="green" />
        <Kpi label="পৌঁছায়নি" value={t?.unreached ?? 0} sub="ব্যস্ত / কেউ ধরেনি / ব্যর্থ" tone={t && t.unreached > 0 ? 'red' : 'slate'} />
        <Kpi label="গড় দৈর্ঘ্য" value={secs(t?.avgTalkSecs)} sub={t ? `মোট ${secs(t.talkSecs)}` : undefined} />
      </KpiRow>

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <Panel title="ইনকামিং" badge={t ? `${t.split.inbound.total} কল` : undefined}>
          <SplitBody s={t?.split.inbound} />
        </Panel>
        <Panel title="আউটগোয়িং" badge={t ? `${t.split.outbound.total} কল` : undefined}>
          <SplitBody s={t?.split.outbound} />
        </Panel>
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-3">
        <Panel title="দিনের ধারা" className="lg:col-span-2">
          {data?.trend?.length
            ? <MiniBars label="প্রতিদিনের কল (গাঢ় অংশ = পৌঁছায়নি)" data={data.trend.map((d) => ({ date: d.date, value: d.total, sub: d.unreached }))} />
            : <p className="text-[12px] text-muted">এই সময়ে কোনো কল নেই।</p>}
        </Panel>

        <Panel title="এখন লাইভ" badge={data?.line.counts.active ?? 0}>
          {(data?.line.active.length ?? 0) === 0 && (
            <p className="text-[12px] text-muted">
              {(data?.line.counts.active ?? 0) > 0
                ? `${data?.line.counts.active}টি কল চলছে — বিস্তারিত দেখতে গেটওয়ের নতুন কোড লাগবে।`
                : 'এখন কোনো কল চলছে না।'}
            </p>
          )}
          <div className="space-y-2">
            {data?.line.active.slice(0, 4).map((c) => (
              <div key={c.id} className="rounded-xl border border-border-subtle bg-card/60 px-3 py-2">
                <p className="truncate text-[12px] font-semibold text-cream">{c.name || c.from || c.to || '—'}</p>
                <p className="truncate text-[11px] text-muted">{c.direction === 'inbound' ? c.from : c.to}</p>
              </div>
            ))}
          </div>
          <Link href="/agent/phone-console/live" className="mt-3 inline-block text-[11px] text-[#E07A5F]">লাইভ চ্যানেল দেখুন →</Link>
        </Panel>
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <Panel title="রেকর্ডিং">
          <p className="text-[12px] text-muted">
            এই সময়ে <b className="text-cream">{t?.recorded ?? 0}</b>টি কলের রেকর্ডিং আছে
            {t?.voicemail ? <>, ভয়েসমেইল <b className="text-cream">{t.voicemail}</b>টি</> : null}।
          </p>
          <Link href="/agent/phone-console/recordings" className="mt-2 inline-block text-[11px] text-[#E07A5F]">শুনতে যান →</Link>
        </Panel>
        <Panel title="অডিও কোয়ালিটি">
          {t && t.withUnderruns > 0
            ? <Pill tone="amber">{t.withUnderruns}টি কলে অডিও অন্তত একবার কেটেছে</Pill>
            : <p className="text-[12px] text-muted">মাপা কলগুলোয় অডিও কাটার হিসাব নেই।</p>}
          <Link href="/agent/phone-console/quality" className="mt-2 block text-[11px] text-[#E07A5F]">বিস্তারিত →</Link>
        </Panel>
      </div>
    </>
  )
}

function SplitBody({ s }: { s?: { total: number; answered: number; unreached: number; talkSecs: number } }) {
  if (!s) return <p className="text-[12px] text-muted">—</p>
  return (
    <div className="grid grid-cols-3 gap-3 text-center">
      <div>
        <p className="text-lg font-bold tabular-nums text-cream">{s.answered}</p>
        <p className="text-[11px] text-muted">ধরা হয়েছে</p>
      </div>
      <div>
        <p className="text-lg font-bold tabular-nums text-danger">{s.unreached}</p>
        <p className="text-[11px] text-muted">পৌঁছায়নি</p>
      </div>
      <div>
        <p className="text-lg font-bold tabular-nums text-cream">{secs(s.talkSecs)}</p>
        <p className="text-[11px] text-muted">মোট কথা</p>
      </div>
    </div>
  )
}
