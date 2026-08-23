'use client'

import Link from 'next/link'
import { useEffect, useState } from 'react'

type FocusPayload = {
  state: 'found' | 'deleted' | 'not_found' | 'forbidden' | 'unauthorized' | 'error'
  entity?: {
    id: string
    title: string
    label: string
    status: string
    fallbackPath: string
    fields: Record<string, unknown>
  }
}

export default function ReferenceFocusView({
  namespace,
  id,
  businessId,
}: {
  namespace: string
  id: string
  businessId?: string
}) {
  const [payload, setPayload] = useState<FocusPayload | null>(null)
  useEffect(() => {
    const query = businessId ? `?business_id=${encodeURIComponent(businessId)}` : ''
    const controller = new AbortController()
    void fetch(`/api/assistant/references/${encodeURIComponent(namespace)}/${encodeURIComponent(id)}${query}`, {
      cache: 'no-store',
      signal: controller.signal,
    })
      .then(async (response) => {
        const body = await response.json().catch(() => ({})) as FocusPayload
        setPayload(body.state ? body : { state: response.status === 403 ? 'forbidden' : response.status === 404 ? 'not_found' : 'error' })
      })
      .catch((error) => { if (error?.name !== 'AbortError') setPayload({ state: 'error' }) })
    return () => controller.abort()
  }, [businessId, id, namespace])

  if (!payload) return <StateCard title="লোড হচ্ছে…" detail="নির্দিষ্ট রেকর্ড যাচাই করা হচ্ছে।" />
  if (payload.state !== 'found' || !payload.entity) {
    const copy = payload.state === 'deleted'
      ? ['রেকর্ডটি মুছে/আর্কাইভ করা হয়েছে', 'পুরোনো reference রাখা হয়েছে, কিন্তু কোনো mutation করা হয়নি।']
      : payload.state === 'forbidden' || payload.state === 'unauthorized'
        ? ['এই রেকর্ড দেখার অনুমতি নেই', 'আপনার বর্তমান role/business scope এই reference-টি খুলতে দেয় না।']
        : payload.state === 'not_found'
          ? ['রেকর্ড পাওয়া যায়নি', 'ID বা source record আর বর্তমান store-এ নেই।']
          : ['রেকর্ড লোড করা যায়নি', 'সাময়িক সমস্যা হয়েছে—পরে আবার চেষ্টা করুন।']
    return <StateCard title={copy[0]} detail={copy[1]} />
  }

  const entity = payload.entity
  return (
    <main className="mx-auto min-h-screen max-w-3xl px-5 py-10">
      <div className="rounded-2xl border border-border bg-card p-6 shadow-sm">
        <div className="mb-1 text-xs font-semibold uppercase tracking-[0.16em] text-[#E07A5F]">{entity.label}</div>
        <h1 className="text-2xl font-semibold text-cream">{entity.title}</h1>
        <div className="mt-1 font-mono text-xs text-muted">{entity.id}</div>
        <dl className="mt-6 grid gap-3 sm:grid-cols-2">
          {Object.entries(entity.fields).filter(([key]) => key !== 'id').map(([key, value]) => (
            <div key={key} className="rounded-xl border border-border-subtle bg-bg-1 p-3">
              <dt className="text-[11px] uppercase tracking-wide text-muted">{key}</dt>
              <dd className="mt-1 break-words text-sm text-cream">{String(value ?? '—')}</dd>
            </div>
          ))}
        </dl>
        <Link href={entity.fallbackPath} className="mt-6 inline-flex text-sm font-semibold text-[#E07A5F] underline underline-offset-4">
          তালিকা/সেকশনে ফিরে যান
        </Link>
      </div>
    </main>
  )
}

function StateCard({ title, detail }: { title: string; detail: string }) {
  return (
    <main className="mx-auto min-h-screen max-w-2xl px-5 py-12">
      <div className="rounded-2xl border border-border bg-card p-6">
        <h1 className="text-xl font-semibold text-cream">{title}</h1>
        <p className="mt-2 text-sm text-muted-hi">{detail}</p>
        <Link href="/agent" className="mt-5 inline-flex text-sm font-semibold text-[#E07A5F] underline underline-offset-4">Agent-এ ফিরুন</Link>
      </div>
    </main>
  )
}
