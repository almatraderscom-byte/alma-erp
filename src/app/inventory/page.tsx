'use client'

import { useState, useMemo, useCallback, useEffect, useDeferredValue, type UIEvent } from 'react'
import Link from 'next/link'
import dynamic from 'next/dynamic'
import { motion } from 'framer-motion'
import { useStock, useProducts, useCreateProduct } from '@/hooks/useERP'
import { PageHeader, Card, KpiCard, Button, SearchInput, Select, Progress, Skeleton, Empty, Money, BdtText, KPI_AUTO_GRID } from '@/components/ui'
import { PageEnter } from '@/components/layout/AgentAccess'
import { fmt } from '@/lib/utils'
import { api, type CreateProductInput } from '@/lib/api'
import { promptDialog } from '@/components/ui/prompt-dialog'
import toast from 'react-hot-toast'
import type { StockItem } from '@/types'

const AddProductModal = dynamic(
  () => import('@/components/inventory/AddProductModal').then(mod => mod.AddProductModal),
  { ssr: false },
)

const STATUS_STYLE: Record<string, string> = {
  'IN STOCK': 'text-green-400 bg-green-400/10 border-green-400/25',
  'LOW STOCK': 'text-amber-400 bg-amber-400/10 border-amber-400/25',
  'OUT OF STOCK': 'text-red-400 bg-red-400/10 border-red-400/25',
}
const INVENTORY_ROW_HEIGHT = 58
const INVENTORY_WINDOW_SIZE = 80
const INVENTORY_OVERSCAN = 16

function inventoryPoolLabel(item: StockItem) {
  if (item.collectionType === 'MEN') return item.sizeGroup || item.sizeCategory || item.sizeValue || item.size
  if (item.collectionType === 'WOMEN') return item.variantGroup || item.sizeValue || item.size
  return item.sizeValue || item.variantGroup || item.size
}

export default function InventoryPage() {
  const { data, loading, error, refetch: refetchStock } = useStock()
  const { data: catalog, refetch: refetchProducts } = useProducts()
  const { mutate: createProduct, loading: createLoading, error: createError, reset: resetCreate } = useCreateProduct()

  const [search, setSearch] = useState('')
  const deferredSearch = useDeferredValue(search)
  const [cat, setCat] = useState('')
  const [view, setView] = useState<'active' | 'archived' | 'low' | 'out'>('active')

  // Staff-assistant "প্রোডাক্ট খুঁজে দাও" deep link (/inventory?q=…) → seed the search once.
  useEffect(() => {
    const q = new URLSearchParams(window.location.search).get('q')
    if (q) { setSearch(q); window.history.replaceState(null, '', '/inventory') }
  }, [])
  const [isAddModalOpen, setIsAddModalOpen] = useState(false)
  const [archiveOverrides, setArchiveOverrides] = useState<Record<string, boolean>>({})
  const [pendingInventoryAction, setPendingInventoryAction] = useState<Record<string, string>>({})
  const [rowWindow, setRowWindow] = useState({ start: 0, end: INVENTORY_WINDOW_SIZE })

  useEffect(() => {
    setArchiveOverrides(current => {
      const next = { ...current }
      for (const item of data?.items ?? []) {
        if (next[item.sku] === item.archived) delete next[item.sku]
      }
      return Object.keys(next).length === Object.keys(current).length ? current : next
    })
  }, [data?.items])

  const items = useMemo(() => {
    const needle = deferredSearch.trim().toLowerCase()
    return (data?.items ?? []).filter(i => {
      const archived = archiveOverrides[i.sku] ?? i.archived
      return (
        (view === 'archived' ? archived : !archived && i.active !== false) &&
        (view !== 'low' || (i.available > 0 && i.available <= i.reorder_level)) &&
        (view !== 'out' || i.available <= 0) &&
        (!cat || i.category === cat || i.collectionCode === cat) &&
        (!needle || [i.sku, i.product, i.category, i.collectionCode, i.barcode, inventoryPoolLabel(i)].some(v => String(v || '').toLowerCase().includes(needle)))
      )
    })
  }, [archiveOverrides, cat, data?.items, deferredSearch, view])
  useEffect(() => {
    setRowWindow({ start: 0, end: INVENTORY_WINDOW_SIZE })
  }, [deferredSearch, cat, view])
  const visibleItems = useMemo(
    () => items.slice(rowWindow.start, Math.min(rowWindow.end, items.length)),
    [items, rowWindow],
  )
  const mobileItems = useMemo(() => items.slice(0, 120), [items])
  const topSpacer = rowWindow.start * INVENTORY_ROW_HEIGHT
  const bottomSpacer = Math.max(0, (items.length - Math.min(rowWindow.end, items.length)) * INVENTORY_ROW_HEIGHT)
  const onInventoryScroll = useCallback((e: UIEvent<HTMLDivElement>) => {
    const start = Math.max(0, Math.floor(e.currentTarget.scrollTop / INVENTORY_ROW_HEIGHT) - INVENTORY_OVERSCAN)
    const end = start + INVENTORY_WINDOW_SIZE + INVENTORY_OVERSCAN * 2
    setRowWindow(prev => (prev.start === start && prev.end === end ? prev : { start, end }))
  }, [])

  const summary = data?.summary
  const categories = useMemo(() => [...new Set((data?.items ?? []).map(i => i.category))], [data?.items])
  const activeInventoryItems = useMemo(
    () => (data?.items ?? []).filter(i => {
      const archived = archiveOverrides[i.sku] ?? i.archived
      return !archived && i.active !== false
    }),
    [archiveOverrides, data?.items],
  )

  const categoryOptions = useMemo(() => {
    const s = new Set<string>()
    categories.forEach(c => {
      if (c) s.add(c)
    })
    for (const p of catalog?.products ?? []) {
      if (p.category) s.add(p.category)
    }
    return [...s].sort((a, b) => a.localeCompare(b))
  }, [categories, catalog?.products])

  const inventoryTotals = useMemo(() => {
    const stockValue = activeInventoryItems.reduce((sum, item) => sum + item.stock_value, 0)
    const sellValue = activeInventoryItems.reduce((sum, item) => sum + item.sell_value, 0)
    const potentialProfit = activeInventoryItems.reduce((sum, item) => {
      const sellingPrice = Number((item as StockItem & { selling_price?: number }).selling_price) || 0
      const rowProfit =
        item.potential_profit ||
        sellingPrice * (item.available || 0) - item.stock_value
      return sum + (Number.isFinite(rowProfit) ? rowProfit : 0)
    }, 0)
    return { stockValue, sellValue, potentialProfit }
  }, [activeInventoryItems])
  const totalValue = inventoryTotals.stockValue
  const totalSellVal = inventoryTotals.sellValue
  const potentialProfit = inventoryTotals.potentialProfit

  const openAddModal = useCallback(() => {
    resetCreate()
    setIsAddModalOpen(true)
  }, [resetCreate])

  const handleCreate = useCallback(
    async (payload: CreateProductInput) => {
      const res = await createProduct(payload)
      if (res?.ok) {
        toast.success('Inventory item created')
        refetchStock()
        refetchProducts()
      } else {
        toast.error('Inventory creation failed')
      }
      return res
    },
    [createProduct, refetchStock, refetchProducts],
  )

  const refreshInventory = useCallback(() => {
    void refetchStock()
    void refetchProducts()
  }, [refetchProducts, refetchStock])

  const mutateInventory = useCallback(async (payload: Parameters<typeof api.stock.mutate>[0]) => {
    const sku = String(payload.sku || '')
    if (!sku || pendingInventoryAction[sku]) return null
    const action = String(payload.action || 'update')
    const optimisticArchive = action === 'archive' ? true : action === 'restore' ? false : null

    setPendingInventoryAction(current => ({ ...current, [sku]: action }))
    if (optimisticArchive !== null) {
      setArchiveOverrides(current => ({ ...current, [sku]: optimisticArchive }))
    }

    try {
      const res = await api.stock.mutate(payload)
      if (!res?.ok) throw new Error(String(res?.error || 'Inventory action failed'))
      toast.success(action === 'archive' ? 'Inventory item archived' : action === 'restore' ? 'Inventory item restored' : 'Inventory updated')
      refreshInventory()
      return res
    } catch (e) {
      if (optimisticArchive !== null) {
        setArchiveOverrides(current => {
          const next = { ...current }
          delete next[sku]
          return next
        })
      }
      toast.error((e as Error).message || 'Inventory action failed')
      return null
    } finally {
      setPendingInventoryAction(current => {
        const next = { ...current }
        delete next[sku]
        return next
      })
    }
  }, [pendingInventoryAction, refreshInventory])

  const adjustStock = useCallback(async (sku: string, current: number, buyingPrice?: number) => {
    const next = await promptDialog({
      title: 'New stock quantity',
      defaultValue: String(current),
      inputMode: 'numeric',
      confirmLabel: 'Next',
      validate: (v) => {
        const n = Number(v)
        return Number.isFinite(n) && n >= 0 ? null : '0 বা তার বেশি একটি সংখ্যা দিন'
      },
    })
    if (next == null) return
    const qty = Number(next.trim())
    if (!Number.isFinite(qty) || qty < 0) {
      toast.error('Enter a valid stock quantity (0 or more)')
      return
    }
    const reason = (await promptDialog({
      title: 'Adjustment reason',
      message: 'damaged, lost, manual correction, supplier update, return restock',
      defaultValue: 'manual correction',
      confirmLabel: 'Save',
    })) || 'manual correction'
    await mutateInventory({ action: 'adjust', sku, new_stock: qty, buying_price: buyingPrice, reason })
  }, [mutateInventory])

  const updateBuyingPrice = useCallback(async (sku: string, current?: number) => {
    const next = await promptDialog({
      title: 'New buying price',
      defaultValue: String(current || 0),
      inputMode: 'decimal',
      confirmLabel: 'Save',
      validate: (v) => {
        const n = Number(v)
        return Number.isFinite(n) && n >= 0 ? null : '0 বা তার বেশি একটি দাম দিন'
      },
    })
    if (next == null) return
    const price = Number(next.trim())
    if (!Number.isFinite(price) || price < 0) {
      toast.error('Enter a valid buying price (0 or more)')
      return
    }
    await mutateInventory({ action: 'edit', sku, data: { buyingPrice: price } })
  }, [mutateInventory])

  return (
    <div className="min-h-[100dvh] bg-transparent">
      <PageHeader
        title="Inventory"
        subtitle={<>{summary?.total_skus ?? 0} SKUs · <BdtText value={fmt(totalValue)} /> stock value</>}
        actions={
          <div className="flex flex-wrap items-center justify-end gap-2">
            <Link href="/inventory/supplier-import" className="hidden sm:inline-flex">
              <Button variant="secondary" size="sm">Import Supplier</Button>
            </Link>
            <Button variant="ghost" size="sm" className="hidden md:inline-flex" onClick={openAddModal}>
              Add inventory
            </Button>
            <Button variant="gold" size="sm" onClick={openAddModal}>
              + Add item
            </Button>
          </div>
        }
      />

      <PageEnter className="min-w-0 max-w-full space-y-4 px-3 py-4 pb-24 sm:px-6 md:pb-6">
        {error && (
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-red-400/25 bg-red-400/10 px-4 py-3 text-sm text-red-300">
            <span>{error}</span>
            <Button variant="ghost" size="xs" onClick={() => void refetchStock()}>Retry</Button>
          </div>
        )}

        <Card className="p-3 flex flex-wrap items-center justify-between gap-2 border-gold-dim/25 md:hidden">
          <p className="text-[11px] text-muted">Manual product entry</p>
          <div className="flex gap-2">
            <Button variant="ghost" size="sm" onClick={openAddModal}>
              Add inventory
            </Button>
            <Button variant="gold" size="sm" onClick={openAddModal}>
              + Add item
            </Button>
          </div>
        </Card>

        <div className={KPI_AUTO_GRID}>
          <KpiCard label="Total SKUs" value={summary?.total_skus ?? 0} valueKind="plain" loading={loading} animate />
          <KpiCard label="Stock Value" value={totalValue} valueKind="currency" color="text-gold-lt" loading={loading} animate />
          <KpiCard label="Potential Profit" value={potentialProfit} valueKind="currency" color="txt-pos" loading={loading} animate />
          <KpiCard
            label="Low Stock"
            value={summary?.low_stock ?? 0}
            valueKind="plain"
            color={summary?.low_stock ? 'txt-warn' : 'text-cream'}
            loading={loading}
            animate
          />
        </div>

        <div className="flex gap-2 overflow-x-auto scrollbar-hide pb-1">
          {([
            { id: 'active' as const, label: 'Active' },
            { id: 'archived' as const, label: 'Archived' },
            { id: 'low' as const, label: 'Low stock' },
            { id: 'out' as const, label: 'Out of stock' },
          ]).map(v => (
            <button
              key={v.id}
              type="button"
              onClick={() => setView(v.id)}
              className={`shrink-0 min-h-[44px] rounded-full border px-3.5 py-2 text-xs font-bold transition-colors md:min-h-0 md:px-3 md:py-1.5 ${
                view === v.id
                  ? 'border-gold-dim/50 bg-gold/10 text-gold-lt'
                  : 'border-border text-muted hover:text-muted'
              }`}
            >
              {v.label}
            </button>
          ))}
        </div>

        <div className="flex flex-wrap gap-2">
          <div className="flex-1 min-w-48">
            <SearchInput value={search} onChange={setSearch} placeholder="Search SKU, product name…" />
          </div>
          <Select
            value={cat}
            onChange={setCat}
            options={[{ label: 'All categories', value: '' }, ...categoryOptions.map(c => ({ label: c, value: c }))]}
          />
        </div>

        {/* Desktop table */}
        <Card className="hidden min-w-0 md:block">
          <div className="overflow-x-auto min-w-0 max-w-full table-scroll max-h-[72vh]" onScroll={onInventoryScroll}>
          <table className="w-full min-w-[1120px] text-xs border-collapse">
            <thead className="sticky top-0 z-[1] bg-card/95 backdrop-blur-sm">
              <tr className="border-b border-border">
                {['SKU', 'Collection', 'Product', 'Type', 'Size/Variant', 'Available', 'Buying', 'Sold', 'Status', 'Value', 'Actions'].map(h => (
                  <th
                    key={h}
                    className="px-3 py-3 text-left text-[10px] font-bold tracking-[0.08em] uppercase text-muted whitespace-nowrap"
                  >
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {loading
                ? Array(8)
                    .fill(0)
                    .map((_, i) => (
                      <tr key={i} className="border-b border-border/50">
                        {Array(11)
                          .fill(0)
                          .map((__, j) => (
                            <td key={j} className="px-3 py-3.5">
                              <div className="skeleton h-3 rounded w-full" />
                            </td>
                          ))}
                      </tr>
                    ))
                : (
                  <>
                  {topSpacer > 0 && (
                    <tr aria-hidden="true">
                      <td colSpan={11} style={{ height: topSpacer }} className="p-0" />
                    </tr>
                  )}
                  {visibleItems.map(item => {
                    const utilPct = Math.round((item.sold / (item.opening + item.purchased + 0.01)) * 100)
                    const statusCls =
                      item.available > item.reorder_level
                        ? STATUS_STYLE['IN STOCK']
                        : item.available > 0
                          ? STATUS_STYLE['LOW STOCK']
                          : STATUS_STYLE['OUT OF STOCK']
                    return (
                      <tr key={item.sku} className="border-b border-border/50 hover:bg-white/[0.02] transition-colors">
                        <td className="px-3 py-3.5 font-mono text-[11px] text-gold font-bold">{item.sku}</td>
                        <td className="px-3 py-3.5">
                          <p className="font-mono text-[11px] text-gold-lt">{item.collectionCode || '—'}</p>
                          <p className="text-[10px] text-muted-hi">{item.barcode || item.sku}</p>
                        </td>
                        <td className="px-3 py-3.5">
                          <p className="font-semibold text-cream">{item.product}</p>
                          <div className="mt-1 w-20">
                            <Progress value={utilPct} color="bg-gold" />
                          </div>
                        </td>
                        <td className="px-3 py-3.5 text-muted">{item.collectionType || item.category}</td>
                        <td className="px-3 py-3.5 text-muted">{inventoryPoolLabel(item)}</td>
                        <td className="px-3 py-3.5 font-bold text-cream text-center">{item.available}</td>
                        <td className="px-3 py-3.5 text-muted text-center"><Money amount={item.buyingPrice || 0} /></td>
                        <td className="px-3 py-3.5 text-muted text-center">{item.sold}</td>
                        <td className="px-3 py-3.5">
                          <span className={`text-[10px] font-bold px-2 py-1 rounded-full border ${statusCls}`}>
                            {item.archived ? 'ARCHIVED' : item.available <= 0 ? 'OUT' : item.available <= item.reorder_level ? 'LOW' : 'IN STOCK'}
                          </span>
                        </td>
                        <td className="px-3 py-3.5 font-bold text-gold tabular-nums"><Money amount={item.stock_value} /></td>
                        <td className="px-3 py-3.5">
                          <div className="flex flex-wrap gap-1">
                            <button disabled={!!pendingInventoryAction[item.sku]} className="rounded-lg border border-border px-2 py-1 text-[10px] text-muted hover:text-cream disabled:opacity-40" onClick={() => void adjustStock(item.sku, item.available, item.buyingPrice)}>Adjust</button>
                            <button disabled={!!pendingInventoryAction[item.sku]} className="rounded-lg border border-border px-2 py-1 text-[10px] text-muted hover:text-cream disabled:opacity-40" onClick={() => void updateBuyingPrice(item.sku, item.buyingPrice)}>Price</button>
                            {item.archived ? (
                              <button disabled={!!pendingInventoryAction[item.sku]} className="rounded-lg border border-green-400/30 px-2 py-1 text-[10px] text-green-300 disabled:opacity-40" onClick={() => void mutateInventory({ action: 'restore', sku: item.sku })}>{pendingInventoryAction[item.sku] === 'restore' ? 'Restoring…' : 'Restore'}</button>
                            ) : (
                              <button disabled={!!pendingInventoryAction[item.sku]} className="rounded-lg border border-red-400/30 px-2 py-1 text-[10px] text-red-300 disabled:opacity-40" onClick={() => void mutateInventory({ action: 'archive', sku: item.sku, reason: 'manual archive' })}>{pendingInventoryAction[item.sku] === 'archive' ? 'Archiving…' : 'Archive'}</button>
                            )}
                          </div>
                        </td>
                      </tr>
                    )
                  })}
                  {bottomSpacer > 0 && (
                    <tr aria-hidden="true">
                      <td colSpan={11} style={{ height: bottomSpacer }} className="p-0" />
                    </tr>
                  )}
                  </>
                )}
            </tbody>
          </table>
          {!loading && items.length === 0 && (
            <Empty
              icon="◧"
              title="No items found"
              desc="Try another filter or add a product"
              action={<Button variant="gold" size="sm" onClick={openAddModal}>+ Add item</Button>}
            />
          )}
          </div>
        </Card>

        {/* Mobile cards */}
        <div className="md:hidden space-y-2">
          {loading
            ? Array(4)
                .fill(0)
                .map((_, i) => <div key={i} className="skeleton h-28 rounded-xl" />)
            : mobileItems.map(item => {
                const utilPct = Math.round((item.sold / (item.opening + item.purchased + 0.01)) * 100)
                return (
                  <Card key={item.sku} interactive className="p-4">
                    <div className="flex items-start justify-between mb-3">
                      <div>
                        <p className="font-mono text-[11px] text-gold font-bold">{item.sku}</p>
                        <p className="text-sm font-bold text-cream">{item.product}</p>
                        <p className="text-[11px] text-muted">
                          {item.collectionCode || item.category} · {item.collectionType || item.color} · {inventoryPoolLabel(item)}
                        </p>
                      </div>
                      <div className="text-right">
                        <p className="text-sm font-bold text-gold"><Money amount={item.stock_value} /></p>
                        <p className="text-[10px] text-muted mt-0.5">Available: {item.available}</p>
                      </div>
                    </div>
                    <div className="grid grid-cols-3 gap-2 text-center mb-2">
                      <div>
                        <p className="text-sm font-bold text-cream">{item.current_stock}</p>
                        <p className="text-[10px] text-muted-hi">Stock</p>
                      </div>
                      <div>
                        <p className="text-sm font-bold text-cream">{item.sold}</p>
                        <p className="text-[10px] text-muted-hi">Sold</p>
                      </div>
                      <div>
                        <p className="text-sm font-bold text-cream">{item.returned}</p>
                        <p className="text-[10px] text-muted-hi">Returns</p>
                      </div>
                    </div>
                    <div className="flex items-center gap-2 text-[10px] text-muted">
                      <span>Utilisation {utilPct}%</span>
                      <div className="flex-1">
                        <Progress value={utilPct} color="bg-gold" />
                      </div>
                    </div>
                    <div className="mt-3 flex gap-2">
                      <Button variant="ghost" size="xs" disabled={!!pendingInventoryAction[item.sku]} onClick={() => void adjustStock(item.sku, item.available, item.buyingPrice)}>Adjust</Button>
                      {item.archived ? (
                        <Button variant="ghost" size="xs" disabled={!!pendingInventoryAction[item.sku]} onClick={() => void mutateInventory({ action: 'restore', sku: item.sku })}>{pendingInventoryAction[item.sku] === 'restore' ? 'Restoring…' : 'Restore'}</Button>
                      ) : (
                        <Button variant="ghost" size="xs" disabled={!!pendingInventoryAction[item.sku]} onClick={() => void mutateInventory({ action: 'archive', sku: item.sku, reason: 'manual archive' })}>{pendingInventoryAction[item.sku] === 'archive' ? 'Archiving…' : 'Archive'}</Button>
                      )}
                    </div>
                  </Card>
                )
              })}
          {!loading && items.length === 0 && (
            <Empty
              icon="◧"
              title="No items found"
              action={<Button variant="gold" size="sm" onClick={openAddModal}>+ Add item</Button>}
            />
          )}
          {!loading && items.length > mobileItems.length && (
            <p className="px-2 py-3 text-center text-[11px] text-muted">
              Showing first {mobileItems.length.toLocaleString()} matches. Use filters/search for the rest.
            </p>
          )}
        </div>
      </PageEnter>

      <button
        type="button"
        onClick={openAddModal}
        className="fixed bottom-[calc(6.25rem+env(safe-area-inset-bottom))] left-4 z-40 flex h-14 min-w-[44px] items-center gap-2 rounded-2xl border border-gold-dim/50 bg-gold/90 px-4 text-sm font-bold text-black shadow-lg shadow-gold/20 transition-transform active:scale-[0.96] md:hidden"
        aria-label="Add inventory item"
      >
        <span className="text-base leading-none">+</span>
        <span>Add item</span>
      </button>

      <AddProductModal
        open={isAddModalOpen}
        onOpenChange={setIsAddModalOpen}
        categoryOptions={categoryOptions}
        saving={createLoading}
        saveError={createError}
        onSubmit={handleCreate}
      />
    </div>
  )
}
