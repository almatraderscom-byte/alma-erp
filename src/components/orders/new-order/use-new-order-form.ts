'use client'

import { useCallback, useRef, useState } from 'react'
import toast from 'react-hot-toast'
import { api, APIError } from '@/lib/api'
import { EMPTY_NEW_ORDER_FORM } from './empty-form'
import type { FormErrors, NewOrderForm } from './types'
import { validateNewOrderForm } from './validate'

export function useNewOrderForm(onSuccess?: () => void) {
  const [form, setForm] = useState<NewOrderForm>(EMPTY_NEW_ORDER_FORM)
  const [errors, setErrors] = useState<FormErrors>({})
  const [touched, setTouched] = useState<Partial<Record<keyof NewOrderForm, boolean>>>({})
  const [loading, setLoading] = useState(false)

  const touchedRef = useRef(touched)
  touchedRef.current = touched

  function set<K extends keyof NewOrderForm>(key: K, value: NewOrderForm[K]) {
    if (key === 'sell_price') {
      touchedRef.current = { ...touchedRef.current, sell_price: true }
      setTouched(p => ({ ...p, sell_price: true }))
    }
    setForm(prev => {
      const next = { ...prev, [key]: value }
      if ((key === 'unit_price' || key === 'qty') && !touchedRef.current.sell_price) {
        const up = key === 'unit_price' ? Number(value) : Number(prev.unit_price)
        const q = key === 'qty' ? Number(value) : Number(prev.qty)
        if (up > 0 && q > 0) next.sell_price = String(up * q)
      }
      if (touchedRef.current[key]) {
        const errs = validateNewOrderForm(next)
        setErrors(er => ({ ...er, [key]: errs[key] }))
      }
      return next
    })
  }

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

      const payload = {
        customer: form.customer.trim(),
        phone: form.phone.replace(/\D/g, ''),
        address: form.address.trim(),
        product: form.product.trim(),
        category: form.category,
        size: form.size.trim(),
        qty: Number(form.qty),
        unit_price: Number(form.unit_price),
        sell_price: Number(form.sell_price) || Number(form.unit_price) * Number(form.qty),
        payment_method: form.payment,
        source: form.source,
        status: form.status,
        courier: form.courier,
        notes: form.notes.trim(),
        sku: form.sku.trim(),
        cogs: Number(form.cogs) || 0,
        courier_charge: Number(form.courier_charge) || 0,
        shipping_fee: Number(form.shipping_fee) || 0,
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

  const sellPriceComputed = Number(form.unit_price) * Number(form.qty)

  return {
    form,
    errors,
    touched,
    setTouched,
    loading,
    set,
    touch,
    handleSubmit,
    sellPriceComputed,
  }
}
