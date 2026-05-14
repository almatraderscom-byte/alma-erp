'use client'

import { useState, useMemo, useCallback } from 'react'
import Link from 'next/link'
import { useStock, useProducts, useCreateProduct, useDashboard } from '@/hooks/useERP'
import { AddProductModal } from '@/components/inventory/AddProductModal'
import { PageHeader, Card, KpiCard, Button, SearchInput, Select, Progress, Skeleton, Empty } from '@/components/ui'
import { fmt } from '@/lib/utils'
import type { CreateProductInput } from '@/lib/api'

const STATUS_STYLE: Record<string, string> = {
  'IN STOCK': 'text-green-400 bg-green-400/10 border-green-400/25',
  'LOW STOCK': 'text-amber-400 bg-amber-400/10 border-amber-400/25',
  'OUT OF STOCK': 'text-red-400 bg-red-400/10 border-red-400/25',
}

export default function InventoryPage() {
  const { data, loading, error, refetch: refetchStock } = useStock()
  const { data: catalog, refetch: refetchProducts } = useProducts()
  const { refetch: refetchDashboard } = useDashboard()
  const { mutate: createProduct, loading: createLoading, error: createError, reset: resetCreate } = useCreateProduct()

  const [search, setSearch] = useState('')
  const [cat, setCat] = useState('')
  const [addOpen, setAddOpen] = useState(false)

  const items = (data?.items ?? []).filter(
    i =>
      (!cat || i.category === cat) &&
      (!search || [i.sku, i.product, i.category].some(v => v.toLowerCase().includes(search.toLowerCase()))),
  )

  const summary = data?.summary
  const categories = useMemo(() => [...new Set((data?.items ?? []).map(i => i.category))], [data?.items])

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

  const totalValue = (data?.items ?? []).reduce((a, i) => a + i.stock_value, 0)
  const totalSellVal = (data?.items ?? []).reduce((a, i) => a + i.sell_value, 0)
  const potentialProfit = totalSellVal - totalValue

  const openAddModal = useCallback(() => {
    resetCreate()
    setAddOpen(true)
  }, [resetCreate])

  const handleCreate = useCallback(
    async (payload: CreateProductInput) => {
      console.log('[InventoryPage] create_product request', payload)
      const res = await createProduct(payload)
      if (res?.ok) {
        console.log('[InventoryPage] create_product success', res)
        refetchStock()
        refetchProducts()
        refetchDashboard()
      } else {
        console.warn('[InventoryPage] create_product returned non-OK', res)
      }
      return res
    },
    [createProduct, refetchStock, refetchProducts, refetchDashboard],
  )

  return (
    <>
      <PageHeader
        title="Inventory"
        subtitle={`${summary?.total_skus ?? 0} SKUs · ${fmt(totalValue)} stock value`}
        actions={
          <div className="flex flex-wrap items-center justify-end gap-2">
            <Link
              href="/inventory/supplier-import"
              className="inline-flex items-center gap-2 font-semibold rounded-xl transition-all duration-150 active:scale-[0.97] px-3.5 py-2 text-xs bg-gold/10 border border-gold-dim/50 text-gold-lt hover:bg-gold/20"
            >
              Import Supplier Products
            </Link>
            <Button variant="ghost" size="sm" onClick={openAddModal} disabled={createLoading}>
              Add inventory
            </Button>
            <Button variant="gold" size="sm" onClick={openAddModal} disabled={createLoading}>
              + Add product
            </Button>
          </div>
        }
      />

      <div className="p-4 md:p-6 pb-24 md:pb-6 space-y-4">
        {error && (
          <div className="px-4 py-3 bg-red-400/10 border border-red-400/25 rounded-xl text-sm text-red-300">
            {error}
          </div>
        )}

        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <KpiCard label="Total SKUs" value={summary?.total_skus ?? 0} loading={loading} />
          <KpiCard label="Stock Value" value={fmt(totalValue)} color="text-gold-lt" loading={loading} />
          <KpiCard label="Potential Profit" value={fmt(potentialProfit)} color="text-green-400" loading={loading} />
          <KpiCard
            label="Low Stock"
            value={summary?.low_stock ?? 0}
            color={summary?.low_stock ? 'text-amber-400' : 'text-cream'}
            loading={loading}
          />
        </div>

        <div className="flex flex-wrap gap-2">
          <div className="flex-1 min-w-48">
            <SearchInput value={search} onChange={setSearch} placeholder="Search SKU, product name…" />
          </div>
          <Select
            value={cat}
            onChange={setCat}
            options={[{ label: 'All categories', value: '' }, ...categories.map(c => ({ label: c, value: c }))]}
          />
        </div>

        {/* Desktop table */}
        <Card className="hidden md:block overflow-hidden">
          <table className="w-full text-xs border-collapse">
            <thead>
              <tr className="border-b border-border">
                {['SKU', 'Product', 'Cat.', 'Color', 'Size', 'Current', 'Available', 'Reorder', 'Sold', 'Returned', 'Status', 'Value'].map(h => (
                  <th
                    key={h}
                    className="px-3 py-3 text-left text-[10px] font-bold tracking-[0.08em] uppercase text-zinc-500 whitespace-nowrap"
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
                        {Array(12)
                          .fill(0)
                          .map((__, j) => (
                            <td key={j} className="px-3 py-3.5">
                              <div className="skeleton h-3 rounded w-full" />
                            </td>
                          ))}
                      </tr>
                    ))
                : items.map(item => {
                    const utilPct = Math.round((item.sold / (item.opening + item.purchased + 0.01)) * 100)
                    const statusCls =
                      item.available > item.reorder_level
                        ? STATUS_STYLE['IN STOCK']
                        : item.available > 0
                          ? STATUS_STYLE['LOW STOCK']
                          : STATUS_STYLE['OUT OF STOCK']
                    return (
                      <tr key={item.sku} className="border-b border-border/50 hover:bg-white/[0.015] transition-colors">
                        <td className="px-3 py-3.5 font-mono text-[11px] text-gold font-bold">{item.sku}</td>
                        <td className="px-3 py-3.5">
                          <p className="font-semibold text-cream">{item.product}</p>
                          <div className="mt-1 w-20">
                            <Progress value={utilPct} color="bg-gold" />
                          </div>
                        </td>
                        <td className="px-3 py-3.5 text-zinc-500">{item.category}</td>
                        <td className="px-3 py-3.5 text-zinc-500">{item.color}</td>
                        <td className="px-3 py-3.5 text-zinc-400">{item.size}</td>
                        <td className="px-3 py-3.5 font-bold text-cream text-center">{item.current_stock}</td>
                        <td className="px-3 py-3.5 font-bold text-cream text-center">{item.available}</td>
                        <td className="px-3 py-3.5 text-zinc-500 text-center">{item.reorder_level}</td>
                        <td className="px-3 py-3.5 text-zinc-500 text-center">{item.sold}</td>
                        <td className="px-3 py-3.5 text-zinc-500 text-center">{item.returned}</td>
                        <td className="px-3 py-3.5">
                          <span className={`text-[10px] font-bold px-2 py-1 rounded-full border ${statusCls}`}>
                            {item.available <= 0 ? 'OUT' : item.available <= item.reorder_level ? 'LOW' : 'IN STOCK'}
                          </span>
                        </td>
                        <td className="px-3 py-3.5 font-bold text-gold tabular-nums">{fmt(item.stock_value)}</td>
                      </tr>
                    )
                  })}
            </tbody>
          </table>
          {!loading && items.length === 0 && <Empty icon="◧" title="No items found" />}
        </Card>

        {/* Mobile cards */}
        <div className="md:hidden space-y-2">
          {loading
            ? Array(4)
                .fill(0)
                .map((_, i) => <div key={i} className="skeleton h-28 rounded-xl" />)
            : items.map(item => {
                const utilPct = Math.round((item.sold / (item.opening + item.purchased + 0.01)) * 100)
                return (
                  <Card key={item.sku} className="p-4">
                    <div className="flex items-start justify-between mb-3">
                      <div>
                        <p className="font-mono text-[11px] text-gold font-bold">{item.sku}</p>
                        <p className="text-sm font-bold text-cream">{item.product}</p>
                        <p className="text-[11px] text-zinc-500">
                          {item.category} · {item.color} · {item.size}
                        </p>
                      </div>
                      <div className="text-right">
                        <p className="text-sm font-bold text-gold">{fmt(item.stock_value)}</p>
                        <p className="text-[10px] text-zinc-500 mt-0.5">Available: {item.available}</p>
                      </div>
                    </div>
                    <div className="grid grid-cols-3 gap-2 text-center mb-2">
                      <div>
                        <p className="text-sm font-bold text-cream">{item.current_stock}</p>
                        <p className="text-[10px] text-zinc-600">Stock</p>
                      </div>
                      <div>
                        <p className="text-sm font-bold text-cream">{item.sold}</p>
                        <p className="text-[10px] text-zinc-600">Sold</p>
                      </div>
                      <div>
                        <p className="text-sm font-bold text-cream">{item.returned}</p>
                        <p className="text-[10px] text-zinc-600">Returns</p>
                      </div>
                    </div>
                    <div className="flex items-center gap-2 text-[10px] text-zinc-500">
                      <span>Utilisation {utilPct}%</span>
                      <div className="flex-1">
                        <Progress value={utilPct} color="bg-gold" />
                      </div>
                    </div>
                  </Card>
                )
              })}
        </div>
      </div>

      <AddProductModal
        open={addOpen}
        onClose={() => setAddOpen(false)}
        categoryOptions={categoryOptions}
        saving={createLoading}
        saveError={createError}
        onSubmit={handleCreate}
      />
    </>
  )
}
