'use client'

import { useEffect } from 'react'
import type React from 'react'
import { useSession } from 'next-auth/react'
import { normalizeAlmaRole } from '@/lib/roles'
import type { OrderStatus, StockItem } from '@/types'
import { GoldDivider } from '@/components/ui'
import { CATEGORIES, COURIERS, NEW_ORDER_STATUSES, PAYMENTS, SOURCES } from './constants'
import { NewOrderField, newOrderInputCls, newOrderSelectCls } from './field'
import { BDT_SYMBOL } from '@/lib/currency'
import { Money } from '@/components/ui'
import type { FormErrors, NewOrderForm, NewOrderItemForm } from './types'
import { orderItemGrossProfit, orderItemSubtotal } from './use-new-order-form'
import {
  MEN_SIZES,
  WOMEN_VARIANT_GROUPS,
  detectCollectionFromStock,
  getCollectionVariantOptions,
  parseCollectionCode,
  type CollectionInfo,
  type CollectionType,
} from './collection-engine'

function itemCollectionInfo(item: NewOrderItemForm, stockItems: StockItem[]): CollectionInfo | null {
  if (item.collection_code && item.collection_type) {
    const code = item.collection_code
    return {
      collectionCode: code,
      collectionType: item.collection_type as CollectionType,
      baseCode: code.endsWith('T') ? code.slice(0, -1) : code,
    }
  }
  return detectCollectionFromStock(stockItems, item.product_code)
    || parseCollectionCode(item.product_code, item.collection_type as CollectionType | undefined)
}

function CustomVariantAutoSelect({
  index,
  item,
  collection,
  stockItems,
  setItem,
}: {
  index: number
  item: NewOrderItemForm
  collection: CollectionInfo
  stockItems: StockItem[]
  setItem: (index: number, key: keyof NewOrderItemForm, value: string) => void
}) {
  const customVariants = getCollectionVariantOptions(stockItems, collection)
  useEffect(() => {
    if (customVariants.length === 1 && !item.variant) {
      setItem(index, 'variant', customVariants[0].value)
    }
  }, [customVariants, index, item.variant, setItem])

  return null
}

export function NewOrderFormFields({
  form,
  errors,
  touched,
  set,
  setItem,
  addItem,
  removeItem,
  touch,
  totals,
  stockItems = [],
  catalogLoading = false,
}: {
  form: NewOrderForm
  errors: FormErrors
  touched: Partial<Record<keyof NewOrderForm, boolean>>
  set: <K extends keyof NewOrderForm>(key: K, value: NewOrderForm[K]) => void
  setItem: (index: number, key: keyof NewOrderItemForm, value: string) => void
  addItem: () => void
  removeItem: (index: number) => void
  touch: (key: keyof NewOrderForm) => void
  totals: {
    subtotal: number
    discount: number
    shipping: number
    payable: number
    paid: number
    due: number
    totalQty: number
    inventoryCost: number
    courierCost: number
    shippingMargin: number
    estimatedProfit: number
  }
  stockItems?: StockItem[]
  catalogLoading?: boolean
}) {
  // Buying price / profit are owner+admin only — staff create orders without seeing margin.
  const { data: session } = useSession()
  const role = normalizeAlmaRole((session?.user as { role?: string } | undefined)?.role)
  const canSeeProfit = role === 'SUPER_ADMIN' || role === 'ADMIN'

  function focusNext(e: React.KeyboardEvent<HTMLElement>) {
    if (e.key !== 'Enter') return
    const target = e.target as HTMLElement
    if (target.tagName === 'TEXTAREA') return
    e.preventDefault()
    const fields = Array.from(document.querySelectorAll<HTMLElement>('[data-order-field="1"]'))
      .filter(el => !el.hasAttribute('disabled'))
    const index = fields.indexOf(target)
    fields[index + 1]?.focus()
  }

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
              data-order-field="1"
              onKeyDown={focusNext}
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
                data-order-field="1"
                onKeyDown={focusNext}
              />
            </NewOrderField>
            <NewOrderField label="Source" required>
              <select value={form.source} onChange={e => set('source', e.target.value)} className={newOrderSelectCls()} data-order-field="1" onKeyDown={focusNext}>
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
              data-order-field="1"
              onKeyDown={focusNext}
            />
          </NewOrderField>
        </div>
      </div>

      <GoldDivider />

      <div>
        <p className="text-[10px] font-bold tracking-[0.14em] uppercase text-gold-dim mb-2 sm:mb-3 flex items-center gap-2">
          <span className="w-4 h-px bg-gold-dim" />
          Items
        </p>
        {catalogLoading && (
          <p className="mb-2 text-[11px] text-amber-300/90">Loading inventory data…</p>
        )}
        <div className="space-y-3">
          {form.items.map((item, index) => {
            const itemError = errors[`item_${index}`]
            const subtotal = orderItemSubtotal(item)
            const itemProfit = orderItemGrossProfit(item)
            const collection = itemCollectionInfo(item, stockItems)
            const isMenCollection = collection?.collectionType === 'MEN' || item.collection_type === 'MEN'
            const isWomenCollection = collection?.collectionType === 'WOMEN' || item.collection_type === 'WOMEN'
            const isSingleCollection = collection?.collectionType === 'SINGLE' || item.collection_type === 'SINGLE'
            const isCustomCollection = collection?.collectionType === 'CUSTOM' || collection?.collectionType === 'SINGLE'
              || item.collection_type === 'CUSTOM' || item.collection_type === 'SINGLE'
            const customVariants = collection && isCustomCollection
              ? getCollectionVariantOptions(stockItems, collection)
              : []
            // Single products have one stock row and no variant pool: auto-connect, no picker.
            const isSingleNoVariant = isSingleCollection && customVariants.length === 0
            return (
              <div key={item.id} className="rounded-2xl border border-border bg-white/[0.03] p-3 space-y-2">
                {collection && isCustomCollection && (
                  <CustomVariantAutoSelect
                    index={index}
                    item={item}
                    collection={collection}
                    stockItems={stockItems}
                    setItem={setItem}
                  />
                )}
                <div className="flex items-center justify-between gap-2">
                  <p className="text-[10px] font-bold uppercase tracking-[0.14em] text-muted">Item {index + 1}</p>
                  {form.items.length > 1 && (
                    <button type="button" onClick={() => removeItem(index)} className="text-[11px] font-semibold text-red-300 hover:text-red-200">
                      Remove
                    </button>
                  )}
                </div>
                <div className="grid grid-cols-2 gap-2 sm:gap-3">
                  <NewOrderField label="Collection / SKU" required error={itemError}>
                    <input
                      type="text"
                      value={item.product_code}
                      onChange={e => setItem(index, 'product_code', e.target.value)}
                      placeholder={catalogLoading ? 'Loading inventory…' : '133 / 133T / SKU'}
                      disabled={catalogLoading}
                      className={newOrderInputCls(itemError)}
                      data-order-field="1"
                      onKeyDown={focusNext}
                    />
                  </NewOrderField>
                  {isMenCollection ? (
                    <NewOrderField label="Size" required>
                      <select
                        value={item.size}
                        onChange={e => setItem(index, 'size', e.target.value)}
                        disabled={catalogLoading}
                        className={newOrderSelectCls()}
                        data-order-field="1"
                        onKeyDown={focusNext}
                      >
                        <option value="">Select size</option>
                        {MEN_SIZES.map(size => (
                          <option key={size} value={size}>{size}</option>
                        ))}
                      </select>
                    </NewOrderField>
                  ) : isWomenCollection ? (
                    <NewOrderField label="Variant" required>
                      <select
                        value={item.variant}
                        onChange={e => setItem(index, 'variant', e.target.value)}
                        disabled={catalogLoading}
                        className={newOrderSelectCls()}
                        data-order-field="1"
                        onKeyDown={focusNext}
                      >
                        <option value="">Select variant</option>
                        {WOMEN_VARIANT_GROUPS.map(variant => (
                          <option key={variant} value={variant}>{variant}</option>
                        ))}
                      </select>
                    </NewOrderField>
                  ) : isSingleNoVariant ? (
                    <NewOrderField label="Variant / Size">
                      <div className="flex h-10 items-center rounded-xl border border-border bg-white/[0.03] px-3 text-xs text-muted">
                        Single product
                      </div>
                    </NewOrderField>
                  ) : isCustomCollection ? (
                    <NewOrderField label="Variant / Size" required>
                      <select
                        value={item.variant}
                        onChange={e => setItem(index, 'variant', e.target.value)}
                        disabled={catalogLoading}
                        className={newOrderSelectCls()}
                        data-order-field="1"
                        onKeyDown={focusNext}
                      >
                        <option value="">Select variant/size</option>
                        {customVariants.map(opt => (
                          <option key={opt.value} value={opt.value}>
                            {opt.label} (Available: {opt.available})
                          </option>
                        ))}
                      </select>
                    </NewOrderField>
                  ) : (
                    <NewOrderField label="Variant">
                      <input
                        type="text"
                        value={item.variant}
                        onChange={e => setItem(index, 'variant', e.target.value)}
                        placeholder="Color / batch"
                        className={newOrderInputCls()}
                        data-order-field="1"
                        onKeyDown={focusNext}
                      />
                    </NewOrderField>
                  )}
                </div>
                {(collection || item.collection_type) && (
                  <div className="rounded-xl border border-gold-dim/20 bg-gold/[0.04] px-3 py-2 text-[10px] text-muted">
                    {isMenCollection
                      ? 'Men/father-son collection detected. Sizes 16-36 deduct KIDS stock, 38-54 deduct ADULT stock.'
                      : isWomenCollection
                        ? 'Women collection detected. Age bands stay on the order, while stock deducts from ORNA, TWO PIECE, or THREE PIECE.'
                        : isCustomCollection
                          ? 'Custom collection detected. Choose a variant/size from stock pools below.'
                          : 'Dynamic collection detected. Variant or SKU selection resolves inventory from saved stock metadata.'}
                  </div>
                )}
                <NewOrderField label="Product" required>
                  <input
                    type="text"
                    value={item.product}
                    onChange={e => setItem(index, 'product', e.target.value)}
                    placeholder="Auto detected product"
                    className={newOrderInputCls(itemError)}
                    data-order-field="1"
                    onKeyDown={focusNext}
                  />
                </NewOrderField>
                <div className="grid grid-cols-2 gap-2 sm:gap-3">
                  <NewOrderField label="Category">
                    <select value={item.category} onChange={e => setItem(index, 'category', e.target.value)} className={newOrderSelectCls()} data-order-field="1" onKeyDown={focusNext}>
                      {CATEGORIES.map(c => (
                        <option key={c}>{c}</option>
                      ))}
                    </select>
                  </NewOrderField>
                  {isMenCollection ? (
                    <NewOrderField label="Size Group">
                      <div className="flex h-10 items-center rounded-xl border border-border bg-white/[0.03] px-3 text-xs text-muted">
                        {item.size_group || 'Auto'}
                      </div>
                    </NewOrderField>
                  ) : isCustomCollection ? (
                    <NewOrderField label="Stock pool">
                      <div className="flex h-10 items-center rounded-xl border border-border bg-white/[0.03] px-3 text-xs text-muted truncate">
                        {item.variant || 'Select variant/size'}
                      </div>
                    </NewOrderField>
                  ) : (
                    <NewOrderField label="Size">
                      <input
                        type="text"
                        value={item.size}
                        onChange={e => setItem(index, 'size', e.target.value)}
                        placeholder={isWomenCollection ? 'Auto / optional' : 'S / M / L / XL'}
                        className={newOrderInputCls()}
                        data-order-field="1"
                        onKeyDown={focusNext}
                      />
                    </NewOrderField>
                  )}
                </div>
                <div className="grid grid-cols-3 gap-1.5 sm:gap-3">
                  <NewOrderField label="Qty" required>
                    <input
                      type="number"
                      inputMode="numeric"
                      min={1}
                      value={item.qty}
                      onChange={e => setItem(index, 'qty', e.target.value)}
                      className={newOrderInputCls(itemError)}
                      data-order-field="1"
                      onKeyDown={focusNext}
                    />
                  </NewOrderField>
                  <NewOrderField label={`Seller Price (${BDT_SYMBOL})`} required>
                    <input
                      type="number"
                      inputMode="decimal"
                      min={0}
                      step="0.01"
                      value={item.sell_price}
                      onChange={e => setItem(index, 'sell_price', e.target.value)}
                      placeholder="0"
                      className={newOrderInputCls(itemError)}
                      data-order-field="1"
                      onKeyDown={focusNext}
                    />
                  </NewOrderField>
                  <NewOrderField label="Subtotal">
                    <div className="flex h-10 items-center justify-end rounded-xl border border-border bg-white/[0.03] px-3 text-xs font-bold text-gold-lt">
                      <Money amount={subtotal} />
                    </div>
                  </NewOrderField>
                </div>
                <div className="flex items-center justify-between text-[10px] text-muted-hi">
                  <span>SKU: {item.sku || 'not connected'}</span>
                  {item.available != null && <span>Available: {item.available}</span>}
                </div>
                {canSeeProfit && Number(item.cogs || 0) > 0 && Number(item.sell_price || 0) > 0 && (
                  <div className="flex items-center justify-between rounded-xl border border-border bg-white/[0.03] px-3 py-2 text-[11px]">
                    <span className="text-muted">Item profit preview</span>
                    <span className={`font-bold ${itemProfit >= 0 ? 'text-green-400' : 'text-red-300'}`}>
                      {itemProfit >= 0 ? '+' : ''}<Money amount={itemProfit} /> {itemProfit >= 0 ? 'PROFIT' : 'LOSS'}
                    </span>
                  </div>
                )}
                {canSeeProfit && Number(item.cogs || 0) > 0 && Number(item.sell_price || 0) < Number(item.cogs || 0) && (
                  <p className="text-[10px] font-semibold text-red-300">Warning: selling below cost</p>
                )}
                {item.warning && (
                  <p className={`text-[10px] ${item.warning === 'Out of stock' ? 'text-red-300' : 'text-amber-300'}`}>
                    {item.warning}
                  </p>
                )}
              </div>
            )
          })}
          {errors.items && <p className="text-[11px] text-red-300">{errors.items}</p>}
          <button
            type="button"
            onClick={addItem}
            className="w-full rounded-xl border border-gold-dim/40 bg-gold/10 px-3 py-2 text-sm font-bold text-gold-lt transition-colors hover:bg-gold/15"
          >
            + Add Item
          </button>
        </div>
      </div>

      <GoldDivider />

      <div>
        <p className="text-[10px] font-bold tracking-[0.14em] uppercase text-gold-dim mb-2 sm:mb-3 flex items-center gap-2">
          <span className="w-4 h-px bg-gold-dim" />
          Cart Totals
        </p>
        <div className="space-y-2 sm:space-y-3">
          <div className="grid grid-cols-2 gap-2 sm:gap-3">
            <NewOrderField label={`Shipping (${BDT_SYMBOL})`} error={touched.shipping_fee ? errors.shipping_fee : undefined}>
              <input
                type="number"
                inputMode="decimal"
                min={0}
                step="0.01"
                value={form.shipping_fee}
                onChange={e => set('shipping_fee', e.target.value)}
                onBlur={() => touch('shipping_fee')}
                placeholder="0"
                className={newOrderInputCls(touched.shipping_fee ? errors.shipping_fee : undefined)}
                data-order-field="1"
                onKeyDown={focusNext}
              />
            </NewOrderField>
            <NewOrderField label={`Discount (${BDT_SYMBOL})`} error={touched.discount ? errors.discount : undefined}>
              <input
                type="number"
                inputMode="decimal"
                min={0}
                step="0.01"
                value={form.discount}
                onChange={e => set('discount', e.target.value)}
                onBlur={() => touch('discount')}
                placeholder="0"
                className={newOrderInputCls(touched.discount ? errors.discount : undefined)}
                data-order-field="1"
                onKeyDown={focusNext}
              />
            </NewOrderField>
          </div>
          <div className="grid grid-cols-2 gap-2 sm:gap-3">
            <NewOrderField label={`Paid Now (${BDT_SYMBOL})`} error={touched.paid_amount ? errors.paid_amount : undefined}>
              <input
                type="number"
                inputMode="decimal"
                min={0}
                step="0.01"
                value={form.paid_amount}
                onChange={e => set('paid_amount', e.target.value)}
                onBlur={() => touch('paid_amount')}
                placeholder="0"
                className={newOrderInputCls(touched.paid_amount ? errors.paid_amount : undefined)}
                data-order-field="1"
                onKeyDown={focusNext}
              />
            </NewOrderField>
            <NewOrderField label={`Courier Cost (${BDT_SYMBOL})`} hint="Internal">
              <input
                type="number"
                inputMode="decimal"
                min={0}
                step="0.01"
                value={form.courier_charge}
                onChange={e => set('courier_charge', e.target.value)}
                placeholder="0"
                className={newOrderInputCls()}
                data-order-field="1"
                onKeyDown={focusNext}
              />
            </NewOrderField>
          </div>
          <div className="space-y-1 rounded-xl border border-gold-dim/20 bg-gold/[0.04] px-3 py-2 text-xs">
            <div className="flex justify-between text-muted"><span>Subtotal</span><Money amount={totals.subtotal} /></div>
            <div className="flex justify-between text-muted"><span>Discount</span><Money amount={totals.discount} /></div>
            <div className="flex justify-between text-muted"><span>Shipping (customer)</span><Money amount={totals.shipping} /></div>
            <div className="flex justify-between border-t border-gold-dim/20 pt-1 font-bold text-gold-lt"><span>Payable</span><Money amount={totals.payable} /></div>
            <div className="flex justify-between text-muted"><span>Due</span><Money amount={totals.due} /></div>
            <div className="flex justify-between text-muted-hi"><span>Courier cost (you pay)</span><Money amount={totals.courierCost} /></div>
            {canSeeProfit && totals.shippingMargin !== 0 && (
              <div className="flex justify-between text-muted-hi">
                <span>Shipping margin</span>
                <span className={totals.shippingMargin >= 0 ? 'text-green-400' : 'text-red-300'}>
                  {totals.shippingMargin >= 0 ? '+' : ''}<Money amount={totals.shippingMargin} />
                </span>
              </div>
            )}
            {canSeeProfit && (
              <div className="flex justify-between border-t border-border pt-1">
                <span className="text-muted">Estimated Profit</span>
                <span className={`font-bold ${totals.estimatedProfit >= 0 ? 'text-green-400' : 'text-red-300'}`}>
                  {totals.estimatedProfit >= 0 ? '+' : ''}<Money amount={totals.estimatedProfit} /> {totals.estimatedProfit >= 0 ? 'PROFIT' : 'LOSS'}
                </span>
              </div>
            )}
            {canSeeProfit && totals.estimatedProfit < 0 && (
              <p className="text-[10px] font-semibold text-red-300">
                Profit Status: LOSS. Review seller price, discount, shipping vs courier cost.
              </p>
            )}
          </div>
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
              <select value={form.payment} onChange={e => set('payment', e.target.value)} className={newOrderSelectCls()} data-order-field="1" onKeyDown={focusNext}>
                {PAYMENTS.map(p => (
                  <option key={p}>{p}</option>
                ))}
              </select>
            </NewOrderField>
            <NewOrderField label="Courier" required>
              <select value={form.courier} onChange={e => set('courier', e.target.value)} className={newOrderSelectCls()} data-order-field="1" onKeyDown={focusNext}>
                <option value="">Not assigned</option>
                {COURIERS.map(c => (
                  <option key={c}>{c}</option>
                ))}
              </select>
            </NewOrderField>
          </div>

          <NewOrderField label="Status">
            <select value={form.status} onChange={e => set('status', e.target.value as OrderStatus)} className={newOrderSelectCls()} data-order-field="1" onKeyDown={focusNext}>
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
              data-order-field="1"
            />
          </NewOrderField>
        </div>
      </div>
    </div>
  )
}
