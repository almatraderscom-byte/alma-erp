'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import toast from 'react-hot-toast'
import { Button, Card, Select, Spinner } from '@/components/ui'
import { MobileModalPortal } from '@/components/mobile/MobileModalPortal'
import type { CreateProductInput, CreateProductRes } from '@/lib/api'
import { MEN_SIZE_GROUPS, WOMEN_STOCK_VARIANT_GROUPS, parseCollectionCode, smartFashionSku, type CollectionType } from '@/components/orders/new-order/collection-engine'

const emptyForm = () => ({
  sku: '',
  inventoryMode: 'collection' as 'collection' | 'single',
  collectionCode: '',
  collectionType: 'MEN' as CollectionType,
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
  kidsStock: '0',
  kidsBuying: '',
  adultStock: '0',
  adultBuying: '',
  womenStocks: Object.fromEntries(WOMEN_STOCK_VARIANT_GROUPS.map(v => [v, '0'])) as Record<string, string>,
  womenBuying: Object.fromEntries(WOMEN_STOCK_VARIANT_GROUPS.map(v => [v, ''])) as Record<string, string>,
  customVariantsText: '',
  customVariantStocks: {} as Record<string, string>,
  customVariantBuying: {} as Record<string, string>,
})

type FormState = ReturnType<typeof emptyForm>

type Props = {
  open: boolean
  /** Controlled open state (same as React Dialog pattern). */
  onOpenChange: (open: boolean) => void
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

export function AddProductModal({ open, onOpenChange, categoryOptions, saving, saveError, onSubmit }: Props) {
  const [form, setForm] = useState<FormState>(emptyForm)
  const [localError, setLocalError] = useState<string | null>(null)
  const formRef = useRef<HTMLFormElement>(null)

  useEffect(() => {
    console.log('[AddProductModal] open →', open)
  }, [open])

  useEffect(() => {
    if (!open) return
    setForm(emptyForm())
    setLocalError(null)
  }, [open])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onOpenChange(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onOpenChange])

  const set =
    <K extends keyof FormState>(key: K) =>
    (v: FormState[K]) =>
      setForm(prev => ({ ...prev, [key]: v }))

  const resolvedCategory =
    form.category === '__other__' ? form.categoryOther.trim() : form.category.trim()

  const knownCollection = parseCollectionCode(form.collectionCode)
  const collection = parseCollectionCode(form.collectionCode, knownCollection?.collectionType || form.collectionType)
  const effectiveCollectionType = collection?.collectionType || form.collectionType
  const isNewCollection = Boolean(form.collectionCode.trim() && !knownCollection)
  const customVariants = parseVariants(form.customVariantsText) || []

  const collectionRows = useCallback(() => {
    const code = (collection?.collectionCode || form.collectionCode).trim().toUpperCase().replace(/\s+/g, '')
    if (!code) return []
    if (effectiveCollectionType === 'MEN') {
      return MEN_SIZE_GROUPS.map(group => {
        const stockQty = Number(group === 'KIDS' ? form.kidsStock : form.adultStock)
        const buyingPrice = Number(group === 'KIDS' ? form.kidsBuying : form.adultBuying)
        return {
          sku: smartFashionSku(code, { size: group }),
          collectionCode: code,
          collectionType: 'MEN',
          genderType: 'MEN',
          sizeCategory: group,
          sizeValue: group,
          buyingPrice,
          stockQty,
          barcode: smartFashionSku(code, { size: group }),
          active: true,
          product: `${code} ${group}`,
          category: 'Panjabi',
        }
      }).filter(row => row.stockQty > 0 || row.buyingPrice > 0)
    }
    if (effectiveCollectionType === 'SINGLE') {
      const stockQty = Number(form.initial_stock || 0)
      const buyingPrice = Number(form.default_cogs || 0)
      return [{
        sku: form.sku.trim() || smartFashionSku(code, {}),
        collectionCode: code,
        collectionType: 'SINGLE',
        genderType: 'SINGLE',
        buyingPrice,
        stockQty,
        barcode: form.sku.trim() || smartFashionSku(code, {}),
        active: true,
        product: form.name.trim() || `${code} Single Product`,
        category: resolvedCategory || 'Single Product',
      }].filter(row => row.stockQty > 0 || row.buyingPrice > 0 || row.product)
    }
    if (effectiveCollectionType === 'CUSTOM') {
      return customVariants.map(variantGroup => {
        const stockQty = Number(form.customVariantStocks[variantGroup] || 0)
        const buyingPrice = Number(form.customVariantBuying[variantGroup] || 0)
        return {
          sku: smartFashionSku(code, { variantGroup }),
          collectionCode: code,
          collectionType: 'CUSTOM',
          genderType: 'CUSTOM',
          variantGroup,
          buyingPrice,
          stockQty,
          barcode: smartFashionSku(code, { variantGroup }),
          active: true,
          product: `${code} ${variantGroup}`,
          category: resolvedCategory || 'Custom Collection',
        }
      }).filter(row => row.stockQty > 0 || row.buyingPrice > 0)
    }
    return WOMEN_STOCK_VARIANT_GROUPS.map(variantGroup => {
      const stockQty = Number(form.womenStocks[variantGroup] || 0)
      const buyingPrice = Number(form.womenBuying[variantGroup] || 0)
      return {
        sku: smartFashionSku(code, { variantGroup }),
        collectionCode: code,
        collectionType: 'WOMEN',
        genderType: 'WOMEN',
        variantGroup,
        buyingPrice,
        stockQty,
        barcode: smartFashionSku(code, { variantGroup }),
        active: true,
        product: `${code} ${variantGroup}`,
        category: 'Women',
      }
    }).filter(row => row.stockQty > 0 || row.buyingPrice > 0)
  }, [collection?.collectionCode, customVariants, effectiveCollectionType, form.adultBuying, form.adultStock, form.collectionCode, form.customVariantBuying, form.customVariantStocks, form.default_cogs, form.initial_stock, form.kidsBuying, form.kidsStock, form.name, form.sku, form.womenBuying, form.womenStocks, resolvedCategory])

  const handleSubmit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault()
      setLocalError(null)
      if (form.inventoryMode === 'collection') {
        const rows = collectionRows()
        if (!collection || !rows.length) {
          setLocalError('Enter a valid collection code and at least one stock/price row.')
          toast.error('Invalid collection inventory')
          return
        }
        const payload: CreateProductInput = {
          inventory_mode: 'collection',
          collection_code: collection.collectionCode,
          collection_type: collection.collectionType,
          gender_type: collection.collectionType,
          name: form.name.trim() || `${collection.collectionCode} Collection`,
          category: resolvedCategory || (collection.collectionType === 'WOMEN' ? 'Women' : collection.collectionType === 'MEN' ? 'Panjabi' : collection.collectionType === 'SINGLE' ? 'Single Product' : 'Custom Collection'),
          default_price: 0,
          default_cogs: 0,
          reorder_level: Number(form.reorder_level) || 0,
          image_url: form.image_url.trim() || undefined,
          skip_duplicate_name_check: false,
          sync_to_stock: true,
          bulk_rows: rows,
        }
        const res = await onSubmit(payload)
        if (!res?.ok) {
          const msg = saveError || 'Collection inventory save failed.'
          setLocalError(msg)
          toast.error(msg)
          return
        }
        toast.success(`Saved ${rows.length} inventory row(s) for ${collection.collectionCode}`)
        onOpenChange(false)
        return
      }
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
      onOpenChange(false)
    },
    [form, onOpenChange, onSubmit, resolvedCategory, saveError],
  )

  const catSelectOptions = [
    { label: '— Select category —', value: '' },
    ...categoryOptions.map(c => ({ label: c, value: c })),
    { label: 'Other (type below)', value: '__other__' },
  ]

  if (!open) return null

  return (
    <MobileModalPortal
      open
      zIndex={10000}
      onBackdropClick={() => onOpenChange(false)}
      aria-label="Add inventory"
    >
      <Card className="mobile-modal-shell w-full rounded-t-2xl border-gold-dim/30 shadow-2xl sm:max-w-lg sm:rounded-2xl">
        <div className="mobile-modal-header flex items-center justify-between gap-3 border-b border-border p-4 pb-3 sm:p-5 sm:pb-3">
          <div>
            <h2 id="add-product-modal-title" className="text-sm font-bold text-cream tracking-tight">
              Add inventory
            </h2>
            <p className="text-[10px] text-zinc-500 mt-0.5">Fashion collection inventory + lifecycle-safe stock rows</p>
          </div>
          <Button variant="ghost" size="xs" onClick={() => onOpenChange(false)} disabled={saving}>
            Close
          </Button>
        </div>

        <form ref={formRef} id="add-product-form" onSubmit={e => void handleSubmit(e)} className="flex min-h-0 flex-1 flex-col">
          <div className="mobile-modal-body space-y-3 px-4 pb-4 sm:px-5">
          <div className="grid grid-cols-2 gap-2 rounded-2xl border border-gold-dim/20 bg-gold/[0.04] p-2">
            <button
              type="button"
              onClick={() => set('inventoryMode')('collection')}
              className={`rounded-xl px-3 py-2 text-xs font-bold ${form.inventoryMode === 'collection' ? 'bg-gold/20 text-gold-lt' : 'text-zinc-500'}`}
            >
              Collection
            </button>
            <button
              type="button"
              onClick={() => set('inventoryMode')('single')}
              className={`rounded-xl px-3 py-2 text-xs font-bold ${form.inventoryMode === 'single' ? 'bg-gold/20 text-gold-lt' : 'text-zinc-500'}`}
            >
              Single SKU
            </button>
          </div>

          {form.inventoryMode === 'collection' && (
            <div className="space-y-3 rounded-2xl border border-border bg-black/[0.03] p-3">
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="block text-[10px] font-bold uppercase tracking-wider text-zinc-500 mb-1">Collection code</label>
                  <input
                    value={form.collectionCode}
                    onChange={e => set('collectionCode')(e.target.value.toUpperCase())}
                    className="w-full bg-black/[0.03] border border-border rounded-xl px-3 py-2 text-sm text-cream font-mono"
                    placeholder="133 / 590 / LUXE-01"
                  />
                </div>
                <div>
                  <label className="block text-[10px] font-bold uppercase tracking-wider text-zinc-500 mb-1">Collection structure</label>
                  {knownCollection ? (
                    <div className="flex h-10 items-center rounded-xl border border-border bg-black/[0.03] px-3 text-xs font-bold text-gold-lt">
                      Known {knownCollection.collectionType}
                    </div>
                  ) : (
                    <Select
                      value={form.collectionType}
                      onChange={v => set('collectionType')(v as CollectionType)}
                      options={[
                        { label: 'MEN / FATHER-SON', value: 'MEN' },
                        { label: 'WOMEN COLLECTION', value: 'WOMEN' },
                        { label: 'SINGLE PRODUCT', value: 'SINGLE' },
                        { label: 'CUSTOM COLLECTION', value: 'CUSTOM' },
                      ]}
                    />
                  )}
                </div>
              </div>
              {isNewCollection && (
                <div className="rounded-xl border border-gold-dim/30 bg-gold/10 px-3 py-2 text-[11px] text-gold-lt">
                  New collection detected. Choose a structure, then set stock and buying price rows. This code will be saved through inventory metadata for future orders.
                </div>
              )}

              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="block text-[10px] font-bold uppercase tracking-wider text-zinc-500 mb-1">Collection name</label>
                  <input
                    value={form.name}
                    onChange={e => set('name')(e.target.value)}
                    className="w-full bg-black/[0.03] border border-border rounded-xl px-3 py-2 text-sm text-cream"
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
                    className="w-full bg-black/[0.03] border border-border rounded-xl px-3 py-2 text-sm text-cream"
                    placeholder="New category label"
                  />
                </div>
              )}

              {effectiveCollectionType === 'MEN' ? (
                <>
                  <p className="text-[10px] text-zinc-500">MEN/FATHER-SON: sizes 16-36 share KIDS stock, 38-54 share ADULT stock. SKUs auto-generate like <span className="font-mono text-gold-lt">133-KIDS</span> and <span className="font-mono text-gold-lt">133-ADULT</span>.</p>
                  <div className="grid grid-cols-2 gap-2">
                    <div>
                      <label className="block text-[10px] font-bold uppercase tracking-wider text-zinc-500 mb-1">Kids stock pool</label>
                      <input inputMode="numeric" value={form.kidsStock} onChange={e => set('kidsStock')(e.target.value)} className="w-full bg-black/[0.03] border border-border rounded-xl px-3 py-2 text-sm text-cream" />
                    </div>
                    <div>
                      <label className="block text-[10px] font-bold uppercase tracking-wider text-zinc-500 mb-1">Kids buying price</label>
                      <input inputMode="decimal" value={form.kidsBuying} onChange={e => set('kidsBuying')(e.target.value)} className="w-full bg-black/[0.03] border border-border rounded-xl px-3 py-2 text-sm text-cream" />
                    </div>
                    <div>
                      <label className="block text-[10px] font-bold uppercase tracking-wider text-zinc-500 mb-1">Adult stock pool</label>
                      <input inputMode="numeric" value={form.adultStock} onChange={e => set('adultStock')(e.target.value)} className="w-full bg-black/[0.03] border border-border rounded-xl px-3 py-2 text-sm text-cream" />
                    </div>
                    <div>
                      <label className="block text-[10px] font-bold uppercase tracking-wider text-zinc-500 mb-1">Adult buying price</label>
                      <input inputMode="decimal" value={form.adultBuying} onChange={e => set('adultBuying')(e.target.value)} className="w-full bg-black/[0.03] border border-border rounded-xl px-3 py-2 text-sm text-cream" />
                    </div>
                  </div>
                </>
              ) : effectiveCollectionType === 'WOMEN' ? (
                <>
                  <p className="text-[10px] text-zinc-500">WOMEN: garment variants stay as stock rows. Age bands are order options only. SKUs auto-generate like <span className="font-mono text-gold-lt">133T-TWO-PIECE</span>.</p>
                  <div className="space-y-2">
                    {WOMEN_STOCK_VARIANT_GROUPS.map(variant => (
                      <div key={variant} className="grid grid-cols-[1.4fr_0.8fr_0.8fr] gap-2 items-end">
                        <p className="pb-2 text-[10px] font-bold text-zinc-500">{variant}</p>
                        <input
                          inputMode="numeric"
                          value={form.womenStocks[variant]}
                          onChange={e => setForm(prev => ({ ...prev, womenStocks: { ...prev.womenStocks, [variant]: e.target.value } }))}
                          className="w-full bg-black/[0.03] border border-border rounded-xl px-3 py-2 text-xs text-cream"
                          placeholder="Stock"
                        />
                        <input
                          inputMode="decimal"
                          value={form.womenBuying[variant]}
                          onChange={e => setForm(prev => ({ ...prev, womenBuying: { ...prev.womenBuying, [variant]: e.target.value } }))}
                          className="w-full bg-black/[0.03] border border-border rounded-xl px-3 py-2 text-xs text-cream"
                          placeholder="Buying"
                        />
                      </div>
                    ))}
                  </div>
                </>
              ) : effectiveCollectionType === 'SINGLE' ? (
                <>
                  <p className="text-[10px] text-zinc-500">SINGLE PRODUCT: creates one inventory row for this collection code.</p>
                  <div className="grid grid-cols-2 gap-2">
                    <input value={form.sku} onChange={e => set('sku')(e.target.value)} className="w-full bg-black/[0.03] border border-border rounded-xl px-3 py-2 text-xs font-mono text-gold" placeholder="SKU auto if empty" />
                    <input inputMode="numeric" value={form.initial_stock} onChange={e => set('initial_stock')(e.target.value)} className="w-full bg-black/[0.03] border border-border rounded-xl px-3 py-2 text-xs text-cream" placeholder="Stock" />
                    <input inputMode="decimal" value={form.default_cogs} onChange={e => set('default_cogs')(e.target.value)} className="w-full bg-black/[0.03] border border-border rounded-xl px-3 py-2 text-xs text-cream" placeholder="Buying price" />
                    <input inputMode="decimal" value={form.default_price} onChange={e => set('default_price')(e.target.value)} className="w-full bg-black/[0.03] border border-border rounded-xl px-3 py-2 text-xs text-cream" placeholder="Sell price optional" />
                  </div>
                </>
              ) : (
                <>
                  <p className="text-[10px] text-zinc-500">CUSTOM COLLECTION: define one variant per line. Each variant gets independent stock, buying price, and SKU.</p>
                  <textarea
                    value={form.customVariantsText}
                    onChange={e => set('customVariantsText')(e.target.value)}
                    className="w-full min-h-20 bg-black/[0.03] border border-border rounded-xl px-3 py-2 text-xs text-cream"
                    placeholder={'Variant A\nVariant B\nLimited Edition'}
                  />
                  <div className="space-y-2">
                    {customVariants.map(variant => (
                      <div key={variant} className="grid grid-cols-[1.4fr_0.8fr_0.8fr] gap-2 items-end">
                        <p className="pb-2 text-[10px] font-bold text-zinc-500">{variant}</p>
                        <input inputMode="numeric" value={form.customVariantStocks[variant] || '0'} onChange={e => setForm(prev => ({ ...prev, customVariantStocks: { ...prev.customVariantStocks, [variant]: e.target.value } }))} className="w-full bg-black/[0.03] border border-border rounded-xl px-3 py-2 text-xs text-cream" placeholder="Stock" />
                        <input inputMode="decimal" value={form.customVariantBuying[variant] || ''} onChange={e => setForm(prev => ({ ...prev, customVariantBuying: { ...prev.customVariantBuying, [variant]: e.target.value } }))} className="w-full bg-black/[0.03] border border-border rounded-xl px-3 py-2 text-xs text-cream" placeholder="Buying" />
                      </div>
                    ))}
                  </div>
                </>
              )}

              <div className="text-[10px] text-zinc-600">
                Will create {collectionRows().length} structured stock row(s). Archived/edit history stays compatible with old orders.
              </div>
            </div>
          )}

          {form.inventoryMode === 'single' && (
          <>
          <div>
            <label className="block text-[10px] font-bold uppercase tracking-wider text-zinc-500 mb-1">Product name *</label>
            <input
              required
              value={form.name}
              onChange={e => set('name')(e.target.value)}
              className="w-full bg-black/[0.03] border border-border rounded-xl px-3 py-2 text-sm text-cream focus:outline-none focus:border-gold-dim/50"
              placeholder="e.g. Linen shirt — sage"
            />
          </div>

          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="block text-[10px] font-bold uppercase tracking-wider text-zinc-500 mb-1">SKU</label>
              <input
                value={form.sku}
                onChange={e => set('sku')(e.target.value)}
                className="w-full bg-black/[0.03] border border-border rounded-xl px-3 py-2 text-xs font-mono text-gold focus:outline-none focus:border-gold-dim/50"
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
                className="w-full bg-black/[0.03] border border-border rounded-xl px-3 py-2 text-sm text-cream focus:outline-none focus:border-gold-dim/50"
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
                className="w-full bg-black/[0.03] border border-border rounded-xl px-3 py-2 text-sm text-cream tabular-nums"
                placeholder="0"
              />
            </div>
            <div>
              <label className="block text-[10px] font-bold uppercase tracking-wider text-zinc-500 mb-1">COGS *</label>
              <input
                inputMode="decimal"
                value={form.default_cogs}
                onChange={e => set('default_cogs')(e.target.value)}
                className="w-full bg-black/[0.03] border border-border rounded-xl px-3 py-2 text-sm text-cream tabular-nums"
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
                className="w-full bg-black/[0.03] border border-border rounded-xl px-3 py-2 text-sm text-cream tabular-nums"
              />
            </div>
            <div>
              <label className="block text-[10px] font-bold uppercase tracking-wider text-zinc-500 mb-1">Reorder at</label>
              <input
                inputMode="numeric"
                value={form.reorder_level}
                onChange={e => set('reorder_level')(e.target.value)}
                className="w-full bg-black/[0.03] border border-border rounded-xl px-3 py-2 text-sm text-cream tabular-nums"
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="block text-[10px] font-bold uppercase tracking-wider text-zinc-500 mb-1">Color</label>
              <input
                value={form.color}
                onChange={e => set('color')(e.target.value)}
                className="w-full bg-black/[0.03] border border-border rounded-xl px-3 py-2 text-sm text-cream"
              />
            </div>
            <div>
              <label className="block text-[10px] font-bold uppercase tracking-wider text-zinc-500 mb-1">Size</label>
              <input
                value={form.size}
                onChange={e => set('size')(e.target.value)}
                className="w-full bg-black/[0.03] border border-border rounded-xl px-3 py-2 text-sm text-cream"
              />
            </div>
          </div>

          <div>
            <label className="block text-[10px] font-bold uppercase tracking-wider text-zinc-500 mb-1">Image URL</label>
            <input
              value={form.image_url}
              onChange={e => set('image_url')(e.target.value)}
              className="w-full bg-black/[0.03] border border-border rounded-xl px-3 py-2 text-xs font-mono text-cream"
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
              className="w-full bg-black/[0.03] border border-border rounded-xl px-3 py-2 text-xs text-cream font-mono"
              placeholder={'S\nM\nL'}
            />
          </div>

          <div>
            <label className="block text-[10px] font-bold uppercase tracking-wider text-zinc-500 mb-1">Description</label>
            <textarea
              value={form.description}
              onChange={e => set('description')(e.target.value)}
              rows={2}
              className="w-full bg-black/[0.03] border border-border rounded-xl px-3 py-2 text-sm text-cream"
            />
          </div>

          <div>
            <label className="block text-[10px] font-bold uppercase tracking-wider text-zinc-500 mb-1">Notes</label>
            <input
              value={form.notes}
              onChange={e => set('notes')(e.target.value)}
              className="w-full bg-black/[0.03] border border-border rounded-xl px-3 py-2 text-sm text-cream"
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
          </>
          )}

          {(localError || saveError) && (
            <p className="text-[11px] text-red-400 bg-red-400/10 border border-red-400/20 rounded-lg px-3 py-2">
              {localError || saveError}
            </p>
          )}
          </div>
          <div className="mobile-modal-footer px-4 pt-3 sm:px-5">
            <div className="flex gap-2">
              <Button type="button" variant="ghost" className="flex-1 justify-center" onClick={() => onOpenChange(false)} disabled={saving}>
                Cancel
              </Button>
              <Button
                type="button"
                variant="gold"
                className="flex-1 justify-center"
                disabled={saving}
                onClick={() => formRef.current?.requestSubmit()}
              >
                {saving ? (
                  <>
                    <Spinner /> Saving…
                  </>
                ) : (
                  'Save product'
                )}
              </Button>
            </div>
          </div>
        </form>
      </Card>
    </MobileModalPortal>
  )
}
