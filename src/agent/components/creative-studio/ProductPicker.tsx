'use client'

import { useEffect, useState } from 'react'
import { fetchErpProducts } from '@/agent/components/creative-studio/studio-api'
import type { StudioProductOption } from '@/lib/creative-studio/project-contract'

export function ProductPicker({
  open,
  onClose,
  onSelect,
}: {
  open: boolean
  onClose: () => void
  onSelect: (product: StudioProductOption) => Promise<void> | void
}) {
  const [query, setQuery] = useState('')
  const [products, setProducts] = useState<StudioProductOption[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [selecting, setSelecting] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    const timer = window.setTimeout(() => {
      setLoading(true)
      setError(null)
      void fetchErpProducts(query)
        .then(setProducts)
        .catch((reason) => setError(reason instanceof Error ? reason.message : 'প্রোডাক্ট লোড করা যায়নি।'))
        .finally(() => setLoading(false))
    }, 250)
    return () => window.clearTimeout(timer)
  }, [open, query])

  if (!open) return null

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="ERP প্রোডাক্ট বাছাই"
      onClick={onClose}
      className="fixed inset-0 z-[70] flex items-end justify-center bg-black/75 backdrop-blur-sm sm:items-center sm:p-4"
    >
      <div
        onClick={(event) => event.stopPropagation()}
        className="max-h-[86vh] w-full max-w-xl overflow-hidden rounded-t-3xl border border-border-subtle bg-card shadow-2xl sm:rounded-3xl"
      >
        <div className="flex items-center justify-between border-b border-border-subtle px-4 py-3">
          <div>
            <h2 className="text-sm font-bold text-cream">ERP প্রোডাক্ট বেছে নিন</h2>
            <p className="text-[11px] text-muted">Read-only · Studio থেকে ERP data বদলাবে না</p>
          </div>
          <button type="button" onClick={onClose} aria-label="বন্ধ করুন" className="grid h-8 w-8 place-items-center rounded-full bg-white/10 text-muted">
            ✕
          </button>
        </div>

        <div className="p-3">
          <input
            autoFocus
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="কোড, নাম বা category খুঁজুন"
            className="w-full rounded-xl border border-border-subtle bg-bg-1 px-3 py-2.5 text-[12px] text-cream outline-none focus:border-[#E07A5F]"
          />
        </div>

        <div className="max-h-[62vh] overflow-y-auto px-3 pb-5">
          {error && <p role="alert" className="rounded-xl bg-red-500/10 p-3 text-[11px] text-red-300">{error}</p>}
          {loading && <p role="status" className="py-8 text-center text-[11px] text-muted">প্রোডাক্ট লোড হচ্ছে…</p>}
          {!loading && !error && products.length === 0 && (
            <p className="py-8 text-center text-[11px] text-muted">কোনো active ERP প্রোডাক্ট পাওয়া যায়নি।</p>
          )}
          <div className="space-y-2">
            {products.map((product) => (
              <button
                key={product.code}
                type="button"
                disabled={selecting !== null}
                onClick={() => {
                  setSelecting(product.code)
                  void Promise.resolve(onSelect(product))
                    .then(onClose)
                    .catch((reason) => setError(reason instanceof Error ? reason.message : 'প্রোডাক্ট সেভ করা যায়নি।'))
                    .finally(() => setSelecting(null))
                }}
                className="flex w-full items-center gap-3 rounded-xl border border-border-subtle bg-white/[0.03] p-2.5 text-left transition hover:border-[#E07A5F]/60 disabled:opacity-50"
              >
                <div className="grid h-14 w-14 shrink-0 place-items-center overflow-hidden rounded-lg bg-black/30">
                  {product.previewImage ?? product.sourceImage ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={product.previewImage ?? product.sourceImage ?? ''} alt="" className="h-full w-full object-cover" />
                  ) : (
                    <span className="text-lg">📦</span>
                  )}
                </div>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[12px] font-bold text-cream">{product.name}</p>
                  <p className="mt-0.5 text-[11px] font-semibold text-[#E07A5F]">{product.code}</p>
                  <p className="mt-1 text-[11px] text-muted">
                    ৳{product.priceBdt.toLocaleString('bn-BD')}
                    {product.available !== null ? ` · Available ${product.available.toLocaleString('bn-BD')}` : ''}
                  </p>
                </div>
                <span className="text-[11px] text-muted">{selecting === product.code ? 'সেভ হচ্ছে…' : 'বাছাই ›'}</span>
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}
