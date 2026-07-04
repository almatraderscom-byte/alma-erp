'use client'

import { useRef } from 'react'
import { Button, Spinner, Card } from '@/components/ui'
import { Money } from '@/components/ui'
import { MobileModalPortal } from '@/components/mobile/MobileModalPortal'
import { useModalSheetDrag } from '@/hooks/useModalSheetDrag'
import { NewOrderFormFields } from './new-order-form-fields'
import { useNewOrderForm } from './use-new-order-form'

export function NewOrderDrawer({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const formRef = useRef<HTMLFormElement>(null)
  const { sheetRef, handleProps } = useModalSheetDrag(onClose)
  const { form, errors, touched, loading, catalogLoading, set, setItem, addItem, removeItem, touch, handleSubmit, totals, stockItems } = useNewOrderForm(() => {
    onCreated()
    onClose()
  })

  return (
    <MobileModalPortal
      open
      zIndex={120}
      onBackdropClick={onClose}
      backdropClassName="md:backdrop-blur-none"
      className="md:items-stretch md:justify-end md:p-0"
      aria-label="Create Order"
    >
      <Card ref={sheetRef} className="mobile-modal-shell w-full max-w-lg border-border shadow-2xl md:h-[100dvh] md:max-h-[100dvh] md:rounded-none md:rounded-l-2xl md:border-l md:border-y-0">
        <div className="mobile-modal-header border-b border-border bg-surface/95 backdrop-blur md:backdrop-blur-none">
          <div {...handleProps} className="flex justify-center pt-2 sm:hidden">
            <span className="h-1 w-10 rounded-full bg-border-strong" />
          </div>
          <div className="flex items-center justify-between px-4 py-3 sm:px-5 sm:py-4">
            <div>
              <p className="text-[10px] font-bold tracking-[0.14em] uppercase text-gold mb-0.5">New Order</p>
              <p className="text-sm font-bold text-cream">Create Order</p>
            </div>
            <button
              type="button"
              onClick={onClose}
              aria-label="বন্ধ করুন"
              className="alma-frost alma-pod flex h-9 w-9 shrink-0 items-center justify-center text-muted transition-all hover:text-cream active:scale-95"
            >
              <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>
            </button>
          </div>
          <div className="h-px bg-gradient-to-r from-transparent via-gold-dim to-transparent" />
        </div>

        <form
          ref={formRef}
          id="new-order-form"
          onSubmit={e => void handleSubmit(e)}
          className="flex min-h-0 flex-1 flex-col"
        >
          <div className="mobile-modal-body scrollbar-gold touch-pan-y [overflow-anchor:none]">
            <NewOrderFormFields
              form={form}
              errors={errors}
              touched={touched}
              set={set}
              setItem={setItem}
              addItem={addItem}
              removeItem={removeItem}
              touch={touch}
              totals={totals}
              stockItems={stockItems}
              catalogLoading={catalogLoading}
            />
          </div>

          <div className="mobile-modal-footer border-t border-border bg-surface/95 px-4 pt-3 backdrop-blur sm:px-5 sm:pt-4 md:backdrop-blur-none space-y-2">
            {totals.payable > 0 && (
              <div className="flex items-center gap-2 px-3 py-1.5 bg-gold/5 border border-gold-dim/20 rounded-xl text-xs">
                <span className="text-muted truncate max-w-[100px]">{form.items[0]?.product || 'Items'}</span>
                <span className="text-muted-hi">×{totals.totalQty || 1}</span>
                <Money amount={totals.payable} className="ml-auto font-bold text-gold" />
                {form.customer && <span className="text-muted truncate max-w-[70px]">→ {form.customer.split(' ')[0]}</span>}
              </div>
            )}

            <div className="flex gap-2">
              <Button type="button" variant="ghost" className="flex-1 justify-center py-3 sm:py-2" onClick={onClose} disabled={loading}>
                Cancel
              </Button>
              <button
                type="button"
                disabled={loading}
                onClick={() => formRef.current?.requestSubmit()}
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
        </form>
      </Card>
    </MobileModalPortal>
  )
}
