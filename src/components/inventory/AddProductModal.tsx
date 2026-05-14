'use client'

import { useCallback, useEffect, useState } from 'react'
import toast from 'react-hot-toast'
import { Button, Card, Select, Spinner } from '@/components/ui'
import type { CreateProductInput, CreateProductRes } from '@/lib/api'

const emptyForm = () => ({
  sku: '',
  name: '',
  category: '',
  categoryOther: '',
  default_price: '',
  default_cogs: '',
  color: '',
  size: '',
  initial_stock: '0',
  reorder_level: '0',
  image_url: '',
  description: '',
  notes: '',
  variantsText: '',
  skip_duplicate_name_check: true,
  sync_to_stock: true,
})

type FormState = ReturnType<typeof emptyForm>

type Props = {
  open: boolean
  onClose: () => void
  categoryOptions: string[]
  saving: boolean
  saveError: string | null
  onSubmit: (payload: CreateProductInput) => Promise<CreateProductRes | null>
}

function parseVariants(text: string): string[] | undefined {
  const lines = text
    .split(/\r?\n/)
    .map(l => l.trim())
    .filter(Boolean)
  return lines.length ? lines : undefined
}

export function AddProductModal({ open, onClose, categoryOptions, saving, saveError, onSubmit }: Props) {
  const [form, setForm] = useState<FormState>(emptyForm)
  const [localError, setLocalError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    setForm(emptyForm())
    setLocalError(null)
  }, [open])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  const set =
    <K extends keyof FormState>(key: K) =>
    (v: FormState[K]) =>
      setForm(prev => ({ ...prev, [key]: v }))

  const resolvedCategory =
    form.category === '__other__' ? form.categoryOther.trim() : form.category.trim()

  const handleSubmit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault()
      setLocalError(null)
      const name = form.name.trim()
      if (!name) {
        setLocalError('Product name is required.')
        toast.error('Product name is required')
        return
      }
      const price = Number(form.default_price)
      const cogs = Number(form.default_cogs)
      const initialQty = Number(form.initial_stock)
      const reorder = Number(form.reorder_level)
      if (Number.isNaN(price) || price < 0) {
        setLocalError('Sell price must be a number ≥ 0.')
        toast.error('Invalid sell price')
        return
      }
      if (Number.isNaN(cogs) || cogs < 0) {
        setLocalError('COGS must be a number ≥ 0.')
        toast.error('Invalid COGS')
        return
      }
      if (Number.isNaN(initialQty) || initialQty < 0 || Number.isNaN(reorder) || reorder < 0) {
        setLocalError('Stock and reorder level must be numbers ≥ 0.')
        toast.error('Invalid stock or reorder level')
        return
      }

      const payload: CreateProductInput = {
        name,
        sku: form.sku.trim() || undefined,
        category: resolvedCategory || undefined,
        default_price: price,
        default_cogs: cogs,
        color: form.color.trim() || undefined,
        size: form.size.trim() || undefined,
        initial_stock: initialQty,
        reorder_level: reorder,
        image_url: form.image_url.trim() || undefined,
        description: form.description.trim() || undefined,
        notes: form.notes.trim() || undefined,
        supplier: 'manual',
        skip_duplicate_name_check: form.skip_duplicate_name_check,
        sync_to_stock: form.sync_to_stock,
        variants: parseVariants(form.variantsText),
      }

      console.log('[AddProductModal] submitting create_product', { ...payload, variants: payload.variants?.length })

      const res = await onSubmit(payload)
      if (!res) {
        const msg = saveError || 'Save failed — check console and network tab.'
        setLocalError(msg)
        toast.error(msg)
        console.error('[AddProductModal] onSubmit returned null', { saveError })
        return
      }
      if (!res.ok || !res.product_id) {
        const msg = 'Unexpected response from server.'
        toast.error(msg)
        console.error('[AddProductModal] bad response', res)
        return
      }

      const stockMeta = res.stock
      let stockMsg = ''
      if (form.sync_to_stock) {
        if (stockMeta && stockMeta.ok) stockMsg = ' Inventory (STOCK CONTROL) row added.'
        else if (stockMeta && !stockMeta.ok && stockMeta.reason === 'stock_sku_exists')
          stockMsg = ' Product saved; STOCK CONTROL already had this SKU (not duplicated).'
        else if (stockMeta && !stockMeta.ok && stockMeta.reason === 'no_stock_sheet')
          stockMsg = ' Product saved; STOCK CONTROL sheet not found — add stock manually in Sheets.'
        else stockMsg = ' Product saved; check stock sync status in server response.'
      } else {
        stockMsg = ' Product saved (catalog only). Add STOCK CONTROL row in Sheets to show in Inventory.'
      }

      toast.success(`Saved ${res.product_id}.${stockMsg}`)
      onClose()
    },
    [form, onClose, onSubmit, resolvedCategory, saveError],
  )

  if (!open) return null

  const catSelectOptions = [
    { label: '— Select category —', value: '' },
    ...categoryOptions.map(c => ({ label: c, value: c })),
    { label: 'Other (type below)', value: '__other__' },
  ]

  return (
    <div className="fixed inset-0 z-[100] flex items-end sm:items-center justify-center p-0 sm:p-4">
      <button
        type="button"
        className="absolute inset-0 bg-black/70 backdrop-blur-sm border-0 cursor-default"
        aria-label="Close dialog backdrop"
        onClick={onClose}
      />
      <Card className="relative z-[101] w-full sm:max-w-lg max-h-[92vh] overflow-y-auto rounded-t-2xl sm:rounded-2xl border-gold-dim/30 shadow-2xl">
        <div className="p-4 sm:p-5 border-b border-border flex items-center justify-between gap-3 sticky top-0 bg-card/95 backdrop-blur">
          <div>
            <h2 className="text-sm font-bold text-cream tracking-tight">Add product</h2>
            <p className="text-[10px] text-zinc-500 mt-0.5">PRODUCT MASTER + optional STOCK CONTROL row</p>
          </div>
          <Button variant="ghost" size="xs" onClick={onClose} disabled={saving}>
            Close
          </Button>
        </div>

        <form onSubmit={e => void handleSubmit(e)} className="p-4 sm:p-5 space-y-3">
          <div>
            <label className="block text-[10px] font-bold uppercase tracking-wider text-zinc-500 mb-1">Product name *</label>
            <input
              required
              value={form.name}
              onChange={e => set('name')(e.target.value)}
              className="w-full bg-black/25 border border-border rounded-xl px-3 py-2 text-sm text-cream focus:outline-none focus:border-gold-dim/50"
              placeholder="e.g. Linen shirt — sage"
            />
          </div>

          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="block text-[10px] font-bold uppercase tracking-wider text-zinc-500 mb-1">SKU</label>
              <input
                value={form.sku}
                onChange={e => set('sku')(e.target.value)}
                className="w-full bg-black/25 border border-border rounded-xl px-3 py-2 text-xs font-mono text-gold focus:outline-none focus:border-gold-dim/50"
                placeholder="Auto if empty"
              />
            </div>
            <div>
              <label className="block text-[10px] font-bold uppercase tracking-wider text-zinc-500 mb-1">Category</label>
              <Select value={form.category} onChange={v => set('category')(v)} options={catSelectOptions} />
            </div>
          </div>

          {form.category === '__other__' && (
            <div>
              <label className="block text-[10px] font-bold uppercase tracking-wider text-zinc-500 mb-1">Category name</label>
              <input
                value={form.categoryOther}
                onChange={e => set('categoryOther')(e.target.value)}
                className="w-full bg-black/25 border border-border rounded-xl px-3 py-2 text-sm text-cream focus:outline-none focus:border-gold-dim/50"
                placeholder="New category label"
              />
            </div>
          )}

          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="block text-[10px] font-bold uppercase tracking-wider text-zinc-500 mb-1">Sell price *</label>
              <input
                inputMode="decimal"
                value={form.default_price}
                onChange={e => set('default_price')(e.target.value)}
                className="w-full bg-black/25 border border-border rounded-xl px-3 py-2 text-sm text-cream tabular-nums"
                placeholder="0"
              />
            </div>
            <div>
              <label className="block text-[10px] font-bold uppercase tracking-wider text-zinc-500 mb-1">COGS *</label>
              <input
                inputMode="decimal"
                value={form.default_cogs}
                onChange={e => set('default_cogs')(e.target.value)}
                className="w-full bg-black/25 border border-border rounded-xl px-3 py-2 text-sm text-cream tabular-nums"
                placeholder="0"
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="block text-[10px] font-bold uppercase tracking-wider text-zinc-500 mb-1">Opening stock *</label>
              <input
                inputMode="numeric"
                value={form.initial_stock}
                onChange={e => set('initial_stock')(e.target.value)}
                className="w-full bg-black/25 border border-border rounded-xl px-3 py-2 text-sm text-cream tabular-nums"
              />
            </div>
            <div>
              <label className="block text-[10px] font-bold uppercase tracking-wider text-zinc-500 mb-1">Reorder at</label>
              <input
                inputMode="numeric"
                value={form.reorder_level}
                onChange={e => set('reorder_level')(e.target.value)}
                className="w-full bg-black/25 border border-border rounded-xl px-3 py-2 text-sm text-cream tabular-nums"
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="block text-[10px] font-bold uppercase tracking-wider text-zinc-500 mb-1">Color</label>
              <input
                value={form.color}
                onChange={e => set('color')(e.target.value)}
                className="w-full bg-black/25 border border-border rounded-xl px-3 py-2 text-sm text-cream"
              />
            </div>
            <div>
              <label className="block text-[10px] font-bold uppercase tracking-wider text-zinc-500 mb-1">Size</label>
              <input
                value={form.size}
                onChange={e => set('size')(e.target.value)}
                className="w-full bg-black/25 border border-border rounded-xl px-3 py-2 text-sm text-cream"
              />
            </div>
          </div>

          <div>
            <label className="block text-[10px] font-bold uppercase tracking-wider text-zinc-500 mb-1">Image URL</label>
            <input
              value={form.image_url}
              onChange={e => set('image_url')(e.target.value)}
              className="w-full bg-black/25 border border-border rounded-xl px-3 py-2 text-xs font-mono text-cream"
              placeholder="https://…"
            />
            <p className="text-[10px] text-zinc-600 mt-1">Paste a hosted image link (no file upload in this build).</p>
          </div>

          <div>
            <label className="block text-[10px] font-bold uppercase tracking-wider text-zinc-500 mb-1">Variants (one per line)</label>
            <textarea
              value={form.variantsText}
              onChange={e => set('variantsText')(e.target.value)}
              rows={3}
              className="w-full bg-black/25 border border-border rounded-xl px-3 py-2 text-xs text-cream font-mono"
              placeholder={'S\nM\nL'}
            />
          </div>

          <div>
            <label className="block text-[10px] font-bold uppercase tracking-wider text-zinc-500 mb-1">Description</label>
            <textarea
              value={form.description}
              onChange={e => set('description')(e.target.value)}
              rows={2}
              className="w-full bg-black/25 border border-border rounded-xl px-3 py-2 text-sm text-cream"
            />
          </div>

          <div>
            <label className="block text-[10px] font-bold uppercase tracking-wider text-zinc-500 mb-1">Notes</label>
            <input
              value={form.notes}
              onChange={e => set('notes')(e.target.value)}
              className="w-full bg-black/25 border border-border rounded-xl px-3 py-2 text-sm text-cream"
            />
          </div>

          <label className="flex items-center gap-2 text-[11px] text-zinc-400 cursor-pointer">
            <input
              type="checkbox"
              checked={form.skip_duplicate_name_check}
              onChange={e => set('skip_duplicate_name_check')(e.target.checked)}
              className="accent-gold"
            />
            Skip if product name already exists (recommended)
          </label>

          <label className="flex items-center gap-2 text-[11px] text-zinc-400 cursor-pointer">
            <input
              type="checkbox"
              checked={form.sync_to_stock}
              onChange={e => set('sync_to_stock')(e.target.checked)}
              className="accent-gold"
            />
            Add matching row to STOCK CONTROL (shows in Inventory list)
          </label>

          {(localError || saveError) && (
            <p className="text-[11px] text-red-400 bg-red-400/10 border border-red-400/20 rounded-lg px-3 py-2">
              {localError || saveError}
            </p>
          )}

          <div className="flex gap-2 pt-2">
            <Button type="button" variant="ghost" className="flex-1" onClick={onClose} disabled={saving}>
              Cancel
            </Button>
            <Button type="submit" variant="gold" className="flex-1" disabled={saving}>
              {saving ? (
                <>
                  <Spinner /> Saving…
                </>
              ) : (
                'Save product'
              )}
            </Button>
          </div>
        </form>
      </Card>
    </div>
  )
}
