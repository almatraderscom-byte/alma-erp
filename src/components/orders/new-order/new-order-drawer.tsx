'use client'

import { motion } from 'framer-motion'
import { Button, Spinner } from '@/components/ui'
import { Money } from '@/components/ui'
import { NewOrderFormFields } from './new-order-form-fields'
import { useNewOrderForm } from './use-new-order-form'

export function NewOrderDrawer({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const { form, errors, touched, loading, set, touch, handleSubmit, sellPriceComputed } = useNewOrderForm(() => {
    onCreated()
    onClose()
  })

  return (
    <motion.div
      className="fixed inset-0 z-50 flex justify-end"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
    >
      <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" onClick={onClose} />

      <motion.div
        className="relative w-full max-w-lg bg-surface border-l border-border"
        style={{ height: '100dvh', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}
        initial={{ x: '100%' }}
        animate={{ x: 0 }}
        exit={{ x: '100%' }}
        transition={{ type: 'spring', damping: 28, stiffness: 300 }}
      >
        <div style={{ flexShrink: 0 }} className="bg-surface/95 backdrop-blur border-b border-border">
          <div className="flex items-center justify-between px-4 py-3 sm:px-5 sm:py-4">
            <div>
              <p className="text-[10px] font-bold tracking-[0.14em] uppercase text-gold mb-0.5">New Order</p>
              <p className="text-sm font-bold text-cream">Create Order</p>
            </div>
            <button
              type="button"
              onClick={onClose}
              className="w-9 h-9 rounded-xl border border-border flex items-center justify-center text-zinc-400 hover:text-cream hover:bg-white/[0.04] transition-colors text-lg"
            >
              ×
            </button>
          </div>
          <div className="h-px bg-gradient-to-r from-transparent via-gold-dim to-transparent" />
        </div>

        <form
          onSubmit={handleSubmit}
          style={{
            flex: '1 1 0',
            minHeight: 0,
            overflowY: 'auto',
            WebkitOverflowScrolling: 'touch',
            overscrollBehavior: 'contain',
          }}
          className="scrollbar-gold"
        >
          <NewOrderFormFields
            form={form}
            errors={errors}
            touched={touched}
            set={set}
            touch={touch}
            sellPriceComputed={sellPriceComputed}
          />
        </form>

        <div
          style={{ flexShrink: 0, position: 'sticky', bottom: 0, paddingBottom: 'max(12px, env(safe-area-inset-bottom))' }}
          className="border-t border-border bg-surface/95 backdrop-blur px-4 pt-3 sm:px-5 sm:pt-4 space-y-2"
        >
          {Number(form.sell_price) > 0 && (
            <div className="flex items-center gap-2 px-3 py-1.5 bg-gold/5 border border-gold-dim/20 rounded-xl text-xs">
              <span className="text-zinc-500 truncate max-w-[100px]">{form.product || 'Product'}</span>
              <span className="text-zinc-600">×{form.qty || 1}</span>
              <Money amount={Number(form.sell_price)} className="ml-auto font-bold text-gold" />
              {form.customer && <span className="text-zinc-500 truncate max-w-[70px]">→ {form.customer.split(' ')[0]}</span>}
            </div>
          )}

          <div className="flex gap-2">
            <Button type="button" variant="ghost" className="flex-1 justify-center py-3 sm:py-2" onClick={onClose} disabled={loading}>
              Cancel
            </Button>
            <button
              type="button"
              disabled={loading}
              onClick={handleSubmit}
              className="flex-1 flex items-center justify-center gap-2 px-4 py-3 sm:py-2.5 rounded-xl border border-gold-dim/50 bg-gold/10 text-gold-lt text-sm font-bold hover:bg-gold/20 transition-all disabled:opacity-50 disabled:cursor-not-allowed active:scale-[0.98]"
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
        </div>
      </motion.div>
    </motion.div>
  )
}
