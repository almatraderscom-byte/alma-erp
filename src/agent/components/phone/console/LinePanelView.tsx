'use client'

import type { LineView } from '@/agent/lib/phone-console-types'
import { useJson } from './useJson'
import { CORAL, ErrorNote, Kpi, KpiRow, PageHead, Panel, Pill, clockBn } from './ui'

/**
 * The trunk page. Everything here is what OUR Asterisk believes, and the page says so in as
 * many words: the provider keeps exactly one registration binding per SIP account and the
 * last registrant owns it, so their table is the only evidence of who holds the line. Ours
 * once read "Registered (exp. 3227s)" while theirs did not list us at all — that reading cost
 * two sessions and roughly half of all outbound calls for days.
 */
export default function LinePanelView() {
  const { data, error } = useJson<{ line: LineView; fetchedAt: string }>(
    '/api/assistant/phone-console/overview?lineOnly=1', 10_000,
  )
  const line = data?.line
  const reg = line?.registration
  const unknown = !line || reg?.registered == null
  const ok = reg?.registered === true
  const longBinding = reg?.expiresIn != null && reg.expiresIn > 120

  return (
    <>
      <PageHead
        title="লাইন ও ট্রাঙ্ক"
        subtitle="আমাদের নিজের Asterisk কী দেখছে — রেজিস্ট্রেশন, একসাথে কয়টা লাইন, স্টাফ ফোনের স্তর।"
        actions={data?.fetchedAt ? <span className="text-[11px] text-muted">হালনাগাদ {clockBn(data.fetchedAt)}</span> : undefined}
      />

      {error && <div className="mb-4"><ErrorNote>গেটওয়ে থেকে উত্তর আসেনি: {error}</ErrorNote></div>}
      {line && !line.configured && (
        <div className="mb-4"><ErrorNote>এই এনভায়রনমেন্টে ফোন গেটওয়ে সেট করা নেই (SIP_GATEWAY_BASE)।</ErrorNote></div>
      )}

      <KpiRow>
        <Kpi
          label="রেজিস্ট্রেশন"
          value={unknown ? 'জানা যায়নি' : ok ? 'আছে' : 'নেই'}
          sub={reg?.status ?? undefined}
          tone={unknown ? 'slate' : ok ? 'green' : 'red'}
        />
        <Kpi
          label="বাইন্ডিং বাকি"
          value={reg?.expiresIn != null ? `${reg.expiresIn}সে` : '—'}
          sub={longBinding ? 'অনেক লম্বা — ঝুঁকি' : '৬০ সেকেন্ড থেকে নামছে = সুস্থ'}
          tone={longBinding ? 'amber' : 'slate'}
        />
        <Kpi
          label="চলমান লাইন"
          value={`${line?.counts.active ?? 0} / ${line?.counts.maxConcurrent ?? '—'}`}
          sub="ট্রাঙ্কের সীমার সমান রাখা হয়েছে"
        />
        <Kpi
          label="স্টাফ ফোন"
          value={line?.softphone.healthy == null ? '—' : line.softphone.healthy ? 'ঠিক আছে' : 'সমস্যা'}
          sub={line?.softphone.repairs != null ? `নিজে সারিয়েছে ${line.softphone.repairs} বার` : undefined}
          tone={line?.softphone.healthy === false ? 'red' : 'slate'}
        />
      </KpiRow>

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <Panel title="প্রোভাইডারের টেবিলই একমাত্র সত্য">
          <p className="tone-amber rounded-xl border px-3 py-2.5 text-[12px] leading-relaxed">
            উপরের সবটাই <b>আমাদের সার্ভারের দাবি</b> — প্রমাণ নয়। প্রোভাইডার এক অ্যাকাউন্টে একটাই
            রেজিস্ট্রেশন রাখে, আর <b>শেষ যে রেজিস্টার করে লাইনটা তার</b>। একবার আমাদের Asterisk
            &ldquo;Registered&rdquo; দেখিয়েছিল অথচ ওদের টেবিলে আমরা ছিলামই না — ওই ভুল পড়াতেই দিনের পর দিন
            আউটগোয়িং কলের প্রায় অর্ধেক মারা যাচ্ছিল।
          </p>
          <p className="mt-2 text-[12px] text-muted">
            কে আসলে লাইন ধরে আছে দেখতে:{' '}
            <a href="https://amarip.net" target="_blank" rel="noreferrer" className="underline decoration-dotted" style={{ color: CORAL }}>
              amarip.net → SIP Users
            </a>
            । ওটা এই পাতায় আনা <b>ধাপ ২</b>-এর কাজ, কারণ তাতে ওদের লগইন লাগে।
          </p>
        </Panel>

        <Panel title="বিস্তারিত">
          <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-[12px]">
            <Fact k="গেটওয়ে" v={line?.reachable ? 'সাড়া দিচ্ছে' : 'সাড়া নেই'} />
            <Fact k="লাইভ বিস্তারিত" v={line?.liveDetail ? 'পাওয়া যাচ্ছে' : 'গেটওয়ে পুরনো'} />
            <Fact k="পরপর ব্যর্থ পরীক্ষা" v={reg?.consecutiveFailures != null ? String(reg.consecutiveFailures) : '—'} />
            <Fact
              k="শেষ পাহারা"
              v={reg?.lastWatchdogCheck ? clockBn(new Date(reg.lastWatchdogCheck).toISOString()) : '—'}
            />
            <Fact k="এই ঘণ্টায় কল" v={line?.hourly ? `${line.hourly.placed} / ${line.hourly.cap}` : '—'} />
            <Fact k="স্টাফ ফোনের অবস্থা" v={line?.softphone.status ?? '—'} />
          </dl>
          <div className="mt-3 flex flex-wrap gap-2">
            <Pill tone="slate">ট্রাঙ্ক বদলানো — ধাপ ৫</Pill>
            <Pill tone="slate">দ্বিতীয় ট্রাঙ্ক / ফেইলওভার — ধাপ ৫</Pill>
          </div>
        </Panel>
      </div>
    </>
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
