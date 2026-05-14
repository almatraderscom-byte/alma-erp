'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useLayoutEffect, useState } from 'react'
import { NewOrderFormFields } from '@/components/orders/new-order/new-order-form-fields'
import { useNewOrderForm } from '@/components/orders/new-order/use-new-order-form'
import { Spinner } from '@/components/ui'
import { useMdUp } from '@/hooks/useMdUp'

export default function NewOrderPage() {
  const router = useRouter()
  const mdUp = useMdUp()
  const [allowRender, setAllowRender] = useState(false)

  useLayoutEffect(() => {
    setAllowRender(true)
  }, [])

  useLayoutEffect(() => {
    if (!allowRender) return
    if (mdUp) router.replace('/orders?new=1')
  }, [allowRender, mdUp, router])

  const { form, errors, touched, loading, set, touch, handleSubmit, sellPriceComputed } = useNewOrderForm(() => {
    router.push('/orders')
  })

  if (!allowRender || mdUp) {
    return (
      <div className="min-h-[50vh] flex items-center justify-center text-zinc-500">
        <Spinner />
      </div>
    )
  }

  return (
    <div className="min-h-0">
      <header
        className="fixed top-0 left-0 right-0 z-[100] border-b border-border bg-surface/95 backdrop-blur-md supports-[backdrop-filter]:bg-surface/80"
        style={{ paddingTop: 'max(12px, env(safe-area-inset-top))' }}
      >
        <div className="flex items-center gap-3 px-4 pb-3">
          <Link
            href="/orders"
            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-border text-zinc-400 transition-colors hover:bg-white/[0.04] hover:text-cream"
            aria-label="Back to orders"
          >
            ←
          </Link>
          <div className="min-w-0 flex-1">
            <p className="text-[10px] font-bold uppercase tracking-[0.14em] text-gold">New order</p>
            <h1 className="truncate text-base font-bold text-cream">Create Order</h1>
          </div>
        </div>
        <div className="h-px bg-gradient-to-r from-transparent via-gold-dim to-transparent" />
      </header>

      <form id="new-order-form" onSubmit={handleSubmit} className="block">
        <div className="px-0 pb-[calc(10rem+env(safe-area-inset-bottom,0px))] pt-[calc(5.75rem+env(safe-area-inset-top,0px))]">
          <NewOrderFormFields
            form={form}
            errors={errors}
            touched={touched}
            set={set}
            touch={touch}
            sellPriceComputed={sellPriceComputed}
          />
        </div>
      </form>

      <footer
        className="fixed bottom-0 left-0 right-0 z-[110] border-t border-border bg-surface/95 backdrop-blur-md supports-[backdrop-filter]:bg-surface/85 shadow-[0_-8px_32px_rgba(0,0,0,0.45)]"
        style={{
          paddingBottom: 'max(12px, env(safe-area-inset-bottom, 0px))',
          paddingTop: 12,
          paddingLeft: 'max(16px, env(safe-area-inset-left, 0px))',
          paddingRight: 'max(16px, env(safe-area-inset-right, 0px))',
        }}
      >
        {Number(form.sell_price) > 0 && (
          <div className="mb-2 flex items-center gap-2 rounded-xl border border-gold-dim/20 bg-gold/5 px-3 py-1.5 text-xs">
            <span className="max-w-[120px] truncate text-zinc-500">{form.product || 'Product'}</span>
            <span className="text-zinc-600">×{form.qty || 1}</span>
            <span className="ml-auto font-bold text-gold">৳{Number(form.sell_price).toLocaleString('en-IN')}</span>
            {form.customer && <span className="max-w-[80px] truncate text-zinc-500">→ {form.customer.split(' ')[0]}</span>}
          </div>
        )}
        <div className="flex gap-2">
          <Link
            href="/orders"
            className={`inline-flex min-h-[48px] flex-1 items-center justify-center rounded-xl border border-border bg-transparent px-4 py-3 text-sm font-semibold text-zinc-400 transition-all hover:bg-white/[0.04] hover:text-cream ${loading ? 'pointer-events-none opacity-50' : ''}`}
          >
            Cancel
          </Link>
          <button
            type="submit"
            form="new-order-form"
            disabled={loading}
            className="flex min-h-[48px] flex-1 items-center justify-center gap-2 rounded-xl border border-gold-dim/50 bg-gold/10 px-4 py-3 text-sm font-bold text-gold-lt transition-all hover:bg-gold/20 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50"
          >
            {loading ? (
              <>
                <Spinner size="sm" />
                <span>Creating…</span>
              </>
            ) : (
              <>
                <span>✦</span>
                <span>Create Order</span>
              </>
            )}
          </button>
        </div>
      </footer>
    </div>
  )
}
