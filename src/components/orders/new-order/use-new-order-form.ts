'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import toast from 'react-hot-toast'
import { api, APIError } from '@/lib/api'
import { EMPTY_NEW_ORDER_FORM, newOrderItem } from './empty-form'
import type { FormErrors, NewOrderForm, NewOrderItemForm } from './types'
import { validateNewOrderForm } from './validate'
import type { StockItem } from '@/types'
import {
  buyingPriceForStock,
  detectCollectionFromStock,
  inferStockCollection,
  matchCollectionStock,
  normalizeWomenVariant,
  sizeGroupForSize,
} from './collection-engine'
import {
  calculateNewOrderTotals,
  orderItemGrossProfit,
  orderItemInventoryCost,
  orderItemSubtotal,
} from './calculate-totals'

export { orderItemGrossProfit, orderItemInventoryCost, orderItemSubtotal } from './calculate-totals'

type ProductOption = {
  id: string
  sku?: string
  name: string
  category: string
  default_price: number
  default_cogs: number
  active: boolean
}

export function useNewOrderForm(onSuccess?: () => void) {
  const [form, setForm] = useState<NewOrderForm>(EMPTY_NEW_ORDER_FORM)
  const [errors, setErrors] = useState<FormErrors>({})
  const [touched, setTouched] = useState<Partial<Record<keyof NewOrderForm, boolean>>>({})
  const [loading, setLoading] = useState(false)
  const [products, setProducts] = useState<ProductOption[]>([])
  const [stockItems, setStockItems] = useState<StockItem[]>([])

  const touchedRef = useRef(touched)
  touchedRef.current = touched

  const set = useCallback(<K extends keyof NewOrderForm>(key: K, value: NewOrderForm[K]) => {
    setForm(prev => {
      const next = { ...prev, [key]: value }
      if (touchedRef.current[key]) {
        const errs = validateNewOrderForm(next)
        setErrors(er => ({ ...er, [key]: errs[key] }))
      }
      return next
    })
  }, [])

  useEffect(() => {
    let alive = true
    async function loadCatalog() {
      try {
        const [productRes, stockRes] = await Promise.all([api.products.list(), api.stock.list()])
        if (!alive) return
        setProducts((productRes.products || []).filter(p => p.active !== false))
        setStockItems(stockRes.items || [])
      } catch (e) {
        console.warn('[CreateOrder catalog]', (e as Error).message)
      }
    }
    void loadCatalog()
    return () => { alive = false }
  }, [])

  const stockBySku = useMemo(() => {
    const map = new Map<string, StockItem>()
    stockItems.forEach(item => {
      if (item.sku) map.set(item.sku.trim().toLowerCase(), item)
    })
    return map
  }, [stockItems])

  const productByCode = useMemo(() => {
    const map = new Map<string, ProductOption>()
    products.forEach(product => {
      ;[product.sku, product.id, product.name].filter(Boolean).forEach(key => {
        map.set(String(key).trim().toLowerCase(), product)
      })
    })
    stockItems.forEach(item => {
      ;[item.sku, item.product].filter(Boolean).forEach(key => {
        if (!map.has(String(key).trim().toLowerCase())) {
          map.set(String(key).trim().toLowerCase(), {
            id: item.sku,
            sku: item.sku,
            name: item.product,
            category: item.category,
            default_price: 0,
            default_cogs: 0,
            active: true,
          })
        }
      })
    })
    return map
  }, [products, stockItems])

  function enrichItemFromCode(raw: NewOrderItemForm, code: string): NewOrderItemForm {
    const key = code.trim().toLowerCase()
    const collection = detectCollectionFromStock(stockItems, code)
    if (collection) {
      const stock = matchCollectionStock(stockItems, collection, { size: raw.size, variant: raw.variant })
      return {
        ...raw,
        product_code: code,
        collection_code: collection.collectionCode,
        collection_type: collection.collectionType,
        size_group: collection.collectionType === 'MEN' ? sizeGroupForSize(raw.size) || '' : '',
        variant_group: collection.collectionType === 'WOMEN' ? normalizeWomenVariant(raw.variant) || '' : '',
        sku: stock?.sku || '',
        product: stock?.product || `${collection.collectionCode} Collection`,
        category: stock?.category || (collection.collectionType === 'WOMEN' ? 'Women' : collection.collectionType === 'MEN' ? 'Panjabi' : collection.collectionType === 'SINGLE' ? 'Single Product' : 'Custom Collection'),
        cogs: stock ? String(buyingPriceForStock(stock)) : '',
        available: stock?.available,
        warning: stock ? (stock.available <= 0 ? 'Out of stock' : '') : 'Select a valid size/variant to connect inventory',
      }
    }
    const product = productByCode.get(key)
    const sku = product?.sku || raw.sku || code.trim()
    const stock = stockBySku.get(sku.trim().toLowerCase())
    if (!product && !stock) return { ...raw, product_code: code, sku: raw.sku || code.trim() }
    return {
      ...raw,
      product_code: code,
      sku,
      product: product?.name || stock?.product || raw.product,
      category: product?.category || stock?.category || raw.category,
      size: stock?.size || raw.size,
      sell_price: raw.sell_price || (product?.default_price ? String(product.default_price) : ''),
      cogs: raw.cogs || (product?.default_cogs ? String(product.default_cogs) : ''),
      available: stock?.available,
      warning: stock?.available != null && stock.available <= 0 ? 'Out of stock' : '',
    }
  }

  function resolveItem(raw: NewOrderItemForm): NewOrderItemForm {
    const collection = detectCollectionFromStock(stockItems, raw.product_code)
    if (!collection) return raw
    const stock = matchCollectionStock(stockItems, collection, { size: raw.size, variant: raw.variant })
    const meta = stock ? inferStockCollection(stock) : undefined
    return {
      ...raw,
      collection_code: collection.collectionCode,
      collection_type: collection.collectionType,
      size_group: collection.collectionType === 'MEN' ? sizeGroupForSize(raw.size) || meta?.sizeGroup || '' : '',
      variant_group: collection.collectionType === 'WOMEN' ? normalizeWomenVariant(raw.variant) || meta?.variantGroup || '' : '',
      sku: stock?.sku || '',
      product: stock?.product || raw.product || `${collection.collectionCode} Collection`,
      category: stock?.category || raw.category || (collection.collectionType === 'WOMEN' ? 'Women' : collection.collectionType === 'MEN' ? 'Panjabi' : collection.collectionType === 'SINGLE' ? 'Single Product' : 'Custom Collection'),
      cogs: stock ? String(buyingPriceForStock(stock)) : raw.cogs,
      available: stock?.available,
      warning: stock ? (stock.available <= 0 ? 'Out of stock' : '') : 'Unavailable size/variant for this collection',
    }
  }

  const setItem = useCallback((index: number, key: keyof NewOrderItemForm, value: string) => {
    setForm(prev => ({
      ...prev,
      items: prev.items.map((item, i) => {
        if (i !== index) return item
        const next = { ...item, [key]: value }
        if (key === 'product_code') return enrichItemFromCode(next, value)
        if (key === 'size' || key === 'variant') return resolveItem(next)
        return next
      }),
    }))
  }, [productByCode, stockBySku, stockItems])

  const addItem = useCallback(() => {
    setForm(prev => ({ ...prev, items: [...prev.items, newOrderItem(prev.items.length)] }))
  }, [])

  const removeItem = useCallback((index: number) => {
    setForm(prev => {
      if (prev.items.length <= 1) return prev
      const next = { ...prev, items: prev.items.filter((_, i) => i !== index) }
      setErrors(validateNewOrderForm(next))
      return next
    })
  }, [])

  function touch(key: keyof NewOrderForm) {
    setTouched(prev => {
      const next = { ...prev, [key]: true }
      touchedRef.current = next
      return next
    })
    const errs = validateNewOrderForm(form)
    setErrors(prev => ({ ...prev, [key]: errs[key] }))
  }

  const handleSubmit = useCallback(
    async (e?: React.FormEvent) => {
      e?.preventDefault()
      const allTouched = Object.fromEntries(Object.keys(EMPTY_NEW_ORDER_FORM).map(k => [k, true])) as Partial<
        Record<keyof NewOrderForm, boolean>
      >
      setTouched(allTouched)
      touchedRef.current = { ...allTouched }

      const errs = validateNewOrderForm(form)
      setErrors(errs)
      if (Object.keys(errs).length > 0) {
        toast.error('Please fix the errors before submitting')
        return
      }

      const totalsSnapshot = calculateNewOrderTotals(form)
      const subtotal = totalsSnapshot.subtotal
      const discount = totalsSnapshot.discount
      const shipping = totalsSnapshot.shipping
      const payable = totalsSnapshot.payable
      const paidAmount = totalsSnapshot.paid
      const totalQty = totalsSnapshot.totalQty
      const totalCogs = totalsSnapshot.inventoryCost
      const estimatedProfit = totalsSnapshot.estimatedProfit
      const firstItem = form.items[0]
      const productLabel = form.items.length === 1
        ? firstItem.product.trim()
        : `${firstItem.product.trim()} + ${form.items.length - 1} more`

      const payload = {
        customer: form.customer.trim(),
        phone: form.phone.replace(/\D/g, ''),
        address: form.address.trim(),
        product: productLabel,
        category: firstItem.category,
        size: firstItem.size || firstItem.variant,
        qty: totalQty || 1,
        unit_price: totalQty > 0 ? subtotal / totalQty : subtotal,
        sell_price: Math.max(0, subtotal - discount),
        payment_method: form.payment,
        source: form.source,
        status: form.status,
        courier: form.courier,
        notes: form.notes.trim(),
        sku: firstItem.sku.trim(),
        cogs: totalCogs,
        courier_charge: Number(form.courier_charge) || 0,
        shipping_fee: shipping,
        discount,
        paid_amount: paidAmount,
        due_amount: Math.max(0, payable - paidAmount),
        estimated_profit: estimatedProfit,
        inventory_cost: totalCogs,
        courier_cost: Number(form.courier_charge) || 0,
        items: form.items.map((item, index) => ({
          line_no: index + 1,
          product_code: item.product_code.trim() || item.sku.trim(),
          product: item.product.trim(),
          category: item.category,
          size: item.size.trim(),
          variant: item.variant.trim(),
          qty: Number(item.qty),
          unit_price: Number(item.sell_price),
          sell_price: Number(item.sell_price),
          subtotal: orderItemSubtotal(item),
          sku: item.sku.trim(),
          stock_sku: item.sku.trim(),
          cogs: Number(item.cogs || 0),
          collection_code: item.collection_code,
          collection_type: item.collection_type,
          size_group: item.size_group,
          variant_group: item.variant_group,
        })),
      }
      console.log('[CreateOrder] payload', payload)

      setLoading(true)
      try {
        const result = await api.mutations.createOrder(payload)
        if (result?.ok) {
          toast.success(`Order ${result.order_id} created successfully`)
          onSuccess?.()
        } else {
          toast.error('Order creation returned ok:false — check Automation Log')
        }
      } catch (e) {
        const msg = e instanceof APIError ? e.userMessage : (e as Error).message
        console.error('[CreateOrder form]', msg, e)
        toast.error(msg)
      } finally {
        setLoading(false)
      }
    },
    [form, onSuccess]
  )

  const totals = useMemo(() => calculateNewOrderTotals(form), [form])

  return {
    form,
    errors,
    touched,
    setTouched,
    loading,
    set,
    setItem,
    addItem,
    removeItem,
    touch,
    handleSubmit,
    totals,
    products,
    stockItems,
  }
}
