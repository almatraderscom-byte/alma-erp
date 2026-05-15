'use client'

import type { OrderStatus } from '@/types'
import { GoldDivider } from '@/components/ui'
import { CATEGORIES, COURIERS, NEW_ORDER_STATUSES, PAYMENTS, SOURCES } from './constants'
import { NewOrderField, newOrderInputCls, newOrderSelectCls } from './field'
import { BDT_SYMBOL, formatBDT } from '@/lib/currency'
import { Money } from '@/components/ui'
import type { FormErrors, NewOrderForm } from './types'

export function NewOrderFormFields({
  form,
  errors,
  touched,
  set,
  touch,
  sellPriceComputed,
}: {
  form: NewOrderForm
  errors: FormErrors
  touched: Partial<Record<keyof NewOrderForm, boolean>>
  set: <K extends keyof NewOrderForm>(key: K, value: NewOrderForm[K]) => void
  touch: (key: keyof NewOrderForm) => void
  sellPriceComputed: number
}) {
  return (
    <div className="px-4 py-3 space-y-4 sm:px-5 sm:py-5 sm:space-y-5">
      <div>
        <p className="text-[10px] font-bold tracking-[0.14em] uppercase text-gold-dim mb-2 sm:mb-3 flex items-center gap-2">
          <span className="w-4 h-px bg-gold-dim" />
          Customer Info
        </p>
        <div className="space-y-2 sm:space-y-3">
          <NewOrderField label="Customer Name" required error={touched.customer ? errors.customer : undefined}>
            <input
              type="text"
              autoComplete="name"
              value={form.customer}
              onChange={e => set('customer', e.target.value)}
              onBlur={() => touch('customer')}
              placeholder="e.g. Nusrat Jahan"
              className={newOrderInputCls(touched.customer ? errors.customer : undefined)}
            />
          </NewOrderField>

          <div className="grid grid-cols-2 gap-2 sm:gap-3">
            <NewOrderField label="Phone" required error={touched.phone ? errors.phone : undefined}>
              <input
                type="tel"
                inputMode="numeric"
                autoComplete="tel"
                value={form.phone}
                onChange={e => set('phone', e.target.value)}
                onBlur={() => touch('phone')}
                placeholder="01711000000"
                className={newOrderInputCls(touched.phone ? errors.phone : undefined)}
              />
            </NewOrderField>
            <NewOrderField label="Source" required>
              <select value={form.source} onChange={e => set('source', e.target.value)} className={newOrderSelectCls()}>
                {SOURCES.map(s => (
                  <option key={s}>{s}</option>
                ))}
              </select>
            </NewOrderField>
          </div>

          <NewOrderField label="Address" hint="District + area (e.g. Gulshan, Dhaka)">
            <input
              type="text"
              autoComplete="street-address"
              value={form.address}
              onChange={e => set('address', e.target.value)}
              placeholder="Gulshan, Dhaka"
              className={newOrderInputCls()}
            />
          </NewOrderField>
        </div>
      </div>

      <GoldDivider />

      <div>
        <p className="text-[10px] font-bold tracking-[0.14em] uppercase text-gold-dim mb-2 sm:mb-3 flex items-center gap-2">
          <span className="w-4 h-px bg-gold-dim" />
          Product Info
        </p>
        <div className="space-y-2 sm:space-y-3">
          <NewOrderField label="Product Name" required error={touched.product ? errors.product : undefined}>
            <input
              type="text"
              value={form.product}
              onChange={e => set('product', e.target.value)}
              onBlur={() => touch('product')}
              placeholder="e.g. Classic White Punjabi"
              className={newOrderInputCls(touched.product ? errors.product : undefined)}
            />
          </NewOrderField>

          <div className="grid grid-cols-2 gap-2 sm:gap-3">
            <NewOrderField label="Category" required>
              <select value={form.category} onChange={e => set('category', e.target.value)} className={newOrderSelectCls()}>
                {CATEGORIES.map(c => (
                  <option key={c}>{c}</option>
                ))}
              </select>
            </NewOrderField>
            <NewOrderField label="Size / Variant">
              <input
                type="text"
                value={form.size}
                onChange={e => set('size', e.target.value)}
                placeholder="S / M / L / XL"
                className={newOrderInputCls()}
              />
            </NewOrderField>
          </div>

          <NewOrderField label="SKU" hint="Leave blank if not assigned yet">
            <input type="text" value={form.sku} onChange={e => set('sku', e.target.value)} placeholder="PUN-001" className={newOrderInputCls()} />
          </NewOrderField>
        </div>
      </div>

      <GoldDivider />

      <div>
        <p className="text-[10px] font-bold tracking-[0.14em] uppercase text-gold-dim mb-2 sm:mb-3 flex items-center gap-2">
          <span className="w-4 h-px bg-gold-dim" />
          Pricing & Qty
        </p>
        <div className="space-y-2 sm:space-y-3">
          <div className="grid grid-cols-2 gap-2 sm:gap-3">
            <NewOrderField label="Qty" required error={touched.qty ? errors.qty : undefined}>
              <input
                type="number"
                inputMode="numeric"
                min={1}
                value={form.qty}
                onChange={e => set('qty', e.target.value)}
                onBlur={() => touch('qty')}
                className={newOrderInputCls(touched.qty ? errors.qty : undefined)}
              />
            </NewOrderField>
            <NewOrderField label={`Unit Price (${BDT_SYMBOL})`} required error={touched.unit_price ? errors.unit_price : undefined}>
              <input
                type="number"
                inputMode="decimal"
                min={0}
                step="0.01"
                value={form.unit_price}
                onChange={e => set('unit_price', e.target.value)}
                onBlur={() => touch('unit_price')}
                placeholder="0"
                className={newOrderInputCls(touched.unit_price ? errors.unit_price : undefined)}
              />
            </NewOrderField>
          </div>

          <NewOrderField
            label={`Sell Price (${BDT_SYMBOL})`}
            required
            error={touched.sell_price ? errors.sell_price : undefined}
            hint={sellPriceComputed > 0 && !touched.sell_price ? `Auto: ${formatBDT(sellPriceComputed)}` : undefined}
          >
            <input
              type="number"
              inputMode="decimal"
              min={0}
              step="0.01"
              value={form.sell_price}
              onChange={e => set('sell_price', e.target.value)}
              onBlur={() => touch('sell_price')}
              placeholder="Auto-calculated"
              className={newOrderInputCls(touched.sell_price ? errors.sell_price : undefined)}
            />
          </NewOrderField>

          <div className="grid grid-cols-3 gap-1.5 sm:gap-3">
            <NewOrderField label={`COGS (${BDT_SYMBOL})`} hint="Cost">
              <input
                type="number"
                inputMode="decimal"
                min={0}
                value={form.cogs}
                onChange={e => set('cogs', e.target.value)}
                placeholder="0"
                className={newOrderInputCls()}
              />
            </NewOrderField>
            <NewOrderField label={`Courier (${BDT_SYMBOL})`} hint="Charge">
              <input
                type="number"
                inputMode="decimal"
                min={0}
                value={form.courier_charge}
                onChange={e => set('courier_charge', e.target.value)}
                className={newOrderInputCls()}
              />
            </NewOrderField>
            <NewOrderField label={`Ship (${BDT_SYMBOL})`} hint="Collected">
              <input
                type="number"
                inputMode="decimal"
                min={0}
                value={form.shipping_fee}
                onChange={e => set('shipping_fee', e.target.value)}
                placeholder="0"
                className={newOrderInputCls()}
              />
            </NewOrderField>
          </div>

          {Number(form.sell_price) > 0 && Number(form.cogs) > 0 && (
            <div className="flex items-center justify-between px-3 py-2 bg-black/40 border border-border rounded-xl text-xs">
              <span className="text-zinc-500">Est. profit</span>
              <Money
                amount={Number(form.sell_price) - Number(form.cogs) - Number(form.courier_charge) + Number(form.shipping_fee)}
                className="font-bold text-green-400"
              />
            </div>
          )}
        </div>
      </div>

      <GoldDivider />

      <div>
        <p className="text-[10px] font-bold tracking-[0.14em] uppercase text-gold-dim mb-2 sm:mb-3 flex items-center gap-2">
          <span className="w-4 h-px bg-gold-dim" />
          Delivery & Payment
        </p>
        <div className="space-y-2 sm:space-y-3">
          <div className="grid grid-cols-2 gap-2 sm:gap-3">
            <NewOrderField label="Payment Method" required>
              <select value={form.payment} onChange={e => set('payment', e.target.value)} className={newOrderSelectCls()}>
                {PAYMENTS.map(p => (
                  <option key={p}>{p}</option>
                ))}
              </select>
            </NewOrderField>
            <NewOrderField label="Courier" required>
              <select value={form.courier} onChange={e => set('courier', e.target.value)} className={newOrderSelectCls()}>
                <option value="">Not assigned</option>
                {COURIERS.map(c => (
                  <option key={c}>{c}</option>
                ))}
              </select>
            </NewOrderField>
          </div>

          <NewOrderField label="Status">
            <select value={form.status} onChange={e => set('status', e.target.value as OrderStatus)} className={newOrderSelectCls()}>
              {NEW_ORDER_STATUSES.map(s => (
                <option key={s}>{s}</option>
              ))}
            </select>
          </NewOrderField>

          <NewOrderField label="Notes" hint="Gift wrap, size notes, etc.">
            <textarea
              value={form.notes}
              onChange={e => set('notes', e.target.value)}
              placeholder="Any special instructions…"
              rows={2}
              className={`${newOrderInputCls()} resize-none`}
            />
          </NewOrderField>
        </div>
      </div>
    </div>
  )
}
