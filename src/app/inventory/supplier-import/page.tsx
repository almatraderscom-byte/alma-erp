'use client'

import Link from 'next/link'
import { useCallback, useEffect, useMemo, useState } from 'react'
import toast from 'react-hot-toast'
import { useProducts, useSupplierImportCommit } from '@/hooks/useERP'
import { PageHeader, Card, Button, SearchInput, Progress, Spinner, Empty } from '@/components/ui'
import {
  SUPPLIER_IMPORT_DEFAULT,
  type EnrichedDraft,
  type SupplierProductDraft,
  enrichDrafts,
  draftsToPayload,
} from '@/lib/supplier-import'
import type { SupplierImportCommitResponse } from '@/lib/api'

type CategoryMapRow = { from: string; to: string }

function parseJsonFile(text: string): SupplierProductDraft[] {
  const data = JSON.parse(text) as unknown
  if (Array.isArray(data)) return data as SupplierProductDraft[]
  if (data && typeof data === 'object' && Array.isArray((data as { items?: unknown }).items)) {
    return (data as { items: SupplierProductDraft[] }).items
  }
  throw new Error('JSON must be an array of products or an object with an "items" array (e.g. alma-supplier-import-v1)')
}

function categoryMapFromRows(rows: CategoryMapRow[]): Record<string, string> {
  const m: Record<string, string> = {}
  for (const r of rows) {
    const a = r.from.trim()
    const b = r.to.trim()
    if (a && b) m[a] = b
  }
  return m
}

export default function SupplierImportPage() {
  const { data: catalogRes, loading: catalogLoading, refetch: refetchCatalog } = useProducts()
  const { mutate: commitImport, loading: commitLoading } = useSupplierImportCommit()

  const [rawJson, setRawJson] = useState('')
  const [parseError, setParseError] = useState<string | null>(null)
  const [drafts, setDrafts] = useState<SupplierProductDraft[]>([])
  const [rows, setRows] = useState<EnrichedDraft[]>([])
  const [catRows, setCatRows] = useState<CategoryMapRow[]>([{ from: '', to: '' }])
  const [search, setSearch] = useState('')
  const [lastResult, setLastResult] = useState<SupplierImportCommitResponse | null>(null)
  const [logs, setLogs] = useState<string[]>([])
  const [retryItems, setRetryItems] = useState<Record<string, unknown>[] | null>(null)
  const cdpCommand = 'SMARTCHINAHUB_CDP_URL=http://127.0.0.1:9222 npm run supplier:scrape'

  const copyText = async (text: string, label: string) => {
    try {
      await navigator.clipboard.writeText(text)
      toast.success(`Copied ${label}`)
    } catch {
      toast.error('Could not copy — select and copy manually')
    }
  }

  const catalog = useMemo(() => {
    const p = catalogRes?.products ?? []
    return p.map(x => ({
      id: x.id,
      sku: x.sku,
      name: x.name,
      category: x.category,
      default_price: x.default_price,
      default_cogs: x.default_cogs,
      active: x.active,
      notes: x.notes,
    }))
  }, [catalogRes])

  const applyParse = useCallback(() => {
    setParseError(null)
    setLastResult(null)
    setRetryItems(null)
    try {
      const text = rawJson.trim()
      if (!text) {
        setDrafts([])
        setRows([])
        return
      }
      const list = parseJsonFile(text)
      setDrafts(list)
      setLogs(l => [...l, `[parse] Loaded ${list.length} draft rows`])
    } catch (e) {
      const msg = (e as Error).message
      setParseError(msg)
      setDrafts([])
      setRows([])
      toast.error(msg)
    }
  }, [rawJson])

  const catMap = useMemo(() => categoryMapFromRows(catRows), [catRows])

  useEffect(() => {
    if (!drafts.length) {
      setRows([])
      return
    }
    setRows(enrichDrafts(drafts, catalog, catMap))
  }, [drafts, catalog, catMap])

  const filtered = useMemo(() => {
    const q = search.toLowerCase()
    if (!q) return rows
    return rows.filter(
      r =>
        r.name.toLowerCase().includes(q) ||
        (r.sku && r.sku.toLowerCase().includes(q)) ||
        (r.supplier_product_id && r.supplier_product_id.toLowerCase().includes(q)),
    )
  }, [rows, search])

  const selectedCount = rows.filter(r => r._selected).length
  const totalDrafts = rows.length

  const toggleRow = (id: string) => {
    setRows(prev => prev.map(r => (r._rowId === id ? { ...r, _selected: !r._selected } : r)))
  }

  const selectAllValid = () => {
    setRows(prev =>
      prev.map(r => ({
        ...r,
        _selected: r._issues.length === 0 && (r._duplicate === null || r._duplicate === 'duplicate_name'),
      })),
    )
  }

  const clearSelection = () => {
    setRows(prev => prev.map(r => ({ ...r, _selected: false })))
  }

  const runImport = async (itemsOverride?: Record<string, unknown>[]) => {
    const base = itemsOverride ?? draftsToPayload(rows)
    if (!base.length) {
      toast.error('No rows selected to import')
      return
    }
    setLogs(l => [...l, `[commit] Sending ${base.length} rows (chunked on server)…`])
    const res = await commitImport({ items: base, skip_duplicate_names: true })
    if (!res) {
      setLogs(l => [...l, '[commit] Failed — see toast'])
      return
    }
    setLastResult(res)
    const skipped = res.skipped?.length ?? 0
    const errN = res.errors?.length ?? 0
    setLogs(l => [
      ...l,
      `[commit] Created ${res.created?.length ?? 0}, skipped ${skipped}, errors ${errN}`,
    ])
    if (errN && res.errors) {
      const failedPayload = res.errors
        .map(e => base[e.index ?? 0])
        .filter(Boolean) as Record<string, unknown>[]
      setRetryItems(failedPayload.length ? failedPayload : null)
      setLogs(l => [...l, ...res.errors!.map(e => `[error] ${e.sku ?? e.index}: ${e.message}`)])
    } else {
      setRetryItems(null)
    }
    toast.success(`Imported ${res.created?.length ?? 0} products`)
    void refetchCatalog()
  }

  const loadSample = () => {
    const sample: SupplierProductDraft[] = [
      {
        supplier_product_id: 'demo-1',
        name: 'Demo supplier product',
        category: 'Uncategorized',
        price: 1200,
        cogs: 800,
        image_url: '',
        description: 'Remove this row after testing import flow.',
        supplier: SUPPLIER_IMPORT_DEFAULT,
      },
    ]
    setRawJson(JSON.stringify({ scrapedAt: new Date().toISOString(), items: sample }, null, 2))
    setParseError(null)
  }

  return (
    <>
      <PageHeader
        title="Import supplier products"
        subtitle="Preview → map categories → commit to PRODUCT MASTER (never overwrites existing SKUs)"
        actions={
          <Link href="/inventory" className="text-[11px] font-semibold text-zinc-500 hover:text-cream">
            ← Back to inventory
          </Link>
        }
      />

      <div className="p-4 md:p-6 pb-24 space-y-4 max-w-6xl mx-auto">
        <Card className="p-4 border-gold/20 bg-gold/[0.04]">
          <h2 className="text-xs font-bold tracking-wider text-gold mb-3">1 · One-time scrape (CDP)</h2>
          <div className="text-[11px] text-zinc-400 space-y-3">
            <p>
              This is a <span className="text-cream font-semibold">one-time bulk</span> path: no supplier API, no
              continuous sync, no automated login. Log in to Smart China Hub <span className="text-cream font-semibold">manually</span>{' '}
              in Chrome. The scraper attaches over <span className="text-cream font-semibold">CDP</span> and reads the
              products page from your existing session.
            </p>
            <ol className="list-decimal pl-4 space-y-2 text-zinc-500">
              <li>
                Quit Chrome, then start it with remote debugging (macOS example):
                <pre className="mt-1 p-2 rounded-lg bg-black/40 border border-border text-[10px] text-gold/90 overflow-x-auto whitespace-pre-wrap">
                  /Applications/Google Chrome.app/Contents/MacOS/Google Chrome --remote-debugging-port=9222
                </pre>
              </li>
              <li>In that window, open Smart China Hub and confirm you are logged in.</li>
              <li>
                From the Alma project folder, run:
                <pre className="mt-1 p-2 rounded-lg bg-black/40 border border-border text-[10px] text-gold/90 overflow-x-auto">
                  {cdpCommand}
                </pre>
                <Button variant="gold" size="xs" className="mt-2" onClick={() => void copyText(cdpCommand, 'scrape command')}>
                  Copy scrape command
                </Button>
              </li>
              <li>
                Open <code className="text-gold/90">tmp/supplier-products.json</code> and paste it below (step 2). You
                can also paste any compatible JSON array if you already exported it elsewhere.
              </li>
            </ol>
          </div>
        </Card>

        <Card className="p-4 border-gold-dim/30">
          <h2 className="text-xs font-bold tracking-wider text-gold mb-2">2 · Paste scraped JSON</h2>
          <p className="text-[11px] text-zinc-500 mb-3">
            Paste <code className="text-gold/80">tmp/supplier-products.json</code> or any array /{' '}
            <code className="text-gold/80">{`{ "items": [...] }`}</code> in the importer format.
          </p>
          <textarea
            value={rawJson}
            onChange={e => setRawJson(e.target.value)}
            placeholder='[ { "name": "…", "supplier_product_id": "…", "price": 0, … } ]'
            className="w-full min-h-[140px] bg-black/30 border border-border rounded-xl p-3 text-xs font-mono text-cream focus:outline-none focus:border-gold-dim/50"
          />
          <div className="flex flex-wrap gap-2 mt-3">
            <Button variant="gold" size="sm" onClick={applyParse}>
              Parse &amp; preview
            </Button>
            <Button variant="ghost" size="sm" onClick={loadSample}>
              Load sample JSON
            </Button>
          </div>
          {parseError && <p className="text-[11px] text-red-400 mt-2">{parseError}</p>}
        </Card>

        <Card className="p-4">
          <h2 className="text-xs font-bold tracking-wider text-gold mb-2">3 · Category mapping (optional)</h2>
          <p className="text-[11px] text-zinc-500 mb-3">Map supplier category labels to your PRODUCT MASTER categories.</p>
          <div className="space-y-2">
            {catRows.map((row, i) => (
              <div key={i} className="flex gap-2 items-center">
                <input
                  value={row.from}
                  onChange={e => {
                    const next = [...catRows]
                    next[i] = { ...next[i], from: e.target.value }
                    setCatRows(next)
                  }}
                  placeholder="Supplier category"
                  className="flex-1 bg-card border border-border rounded-lg px-3 py-2 text-xs text-cream"
                />
                <span className="text-zinc-600">→</span>
                <input
                  value={row.to}
                  onChange={e => {
                    const next = [...catRows]
                    next[i] = { ...next[i], to: e.target.value }
                    setCatRows(next)
                  }}
                  placeholder="Your category"
                  className="flex-1 bg-card border border-border rounded-lg px-3 py-2 text-xs text-cream"
                />
                {catRows.length > 1 && (
                  <Button variant="ghost" size="xs" onClick={() => setCatRows(catRows.filter((_, j) => j !== i))}>
                    ✕
                  </Button>
                )}
              </div>
            ))}
            <Button variant="ghost" size="xs" onClick={() => setCatRows([...catRows, { from: '', to: '' }])}>
              + Add mapping row
            </Button>
          </div>
        </Card>

        <Card className="p-4">
          <div className="flex flex-wrap items-center justify-between gap-3 mb-3">
            <div>
              <h2 className="text-xs font-bold tracking-wider text-gold">4 · Preview &amp; duplicates</h2>
              <p className="text-[11px] text-zinc-500 mt-1">
                Catalog loaded: {catalogLoading ? '…' : catalog.length} products · Draft rows: {totalDrafts} ·
                Selected: {selectedCount}
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button variant="ghost" size="xs" onClick={selectAllValid}>
                Select importable
              </Button>
              <Button variant="ghost" size="xs" onClick={clearSelection}>
                Clear selection
              </Button>
            </div>
          </div>
          <div className="mb-3 max-w-md">
            <SearchInput value={search} onChange={setSearch} placeholder="Filter preview…" />
          </div>

          {!rows.length ? (
            <Empty icon="⎘" title="No preview yet" desc="Parse JSON to see rows and duplicate checks against PRODUCT MASTER." />
          ) : (
            <div className="overflow-x-auto border border-border rounded-xl">
              <table className="w-full text-[11px] border-collapse min-w-[720px]">
                <thead>
                  <tr className="border-b border-border bg-white/[0.03]">
                    <th className="px-2 py-2 text-left w-10">✓</th>
                    <th className="px-2 py-2 text-left">Status</th>
                    <th className="px-2 py-2 text-left">Name</th>
                    <th className="px-2 py-2 text-left">SKU</th>
                    <th className="px-2 py-2 text-left">Supplier ID</th>
                    <th className="px-2 py-2 text-right">Price</th>
                    <th className="px-2 py-2 text-left">Category</th>
                    <th className="px-2 py-2 text-left w-16">Img</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map(r => {
                    const dup = r._duplicate
                    const dis =
                      dup === 'duplicate_sku' ||
                      dup === 'duplicate_supplier_id' ||
                      dup === 'invalid' ||
                      r._issues.length > 0
                    return (
                      <tr key={r._rowId} className="border-b border-border/40 hover:bg-white/[0.02]">
                        <td className="px-2 py-2">
                          <input
                            type="checkbox"
                            checked={r._selected}
                            disabled={dis && dup !== 'duplicate_name'}
                            onChange={() => toggleRow(r._rowId)}
                            className="accent-gold"
                          />
                        </td>
                        <td className="px-2 py-2 text-zinc-400">
                          {dup === null && r._issues.length === 0 && 'Ready'}
                          {dup === 'duplicate_sku' && 'Dup SKU'}
                          {dup === 'duplicate_supplier_id' && 'Dup ID'}
                          {dup === 'duplicate_name' && 'Dup name'}
                          {dup === 'invalid' && 'Invalid'}
                          {r._issues.length > 0 && (
                            <span className="block text-red-400/90 truncate max-w-[140px]" title={r._issues.join(', ')}>
                              {r._issues[0]}
                            </span>
                          )}
                        </td>
                        <td className="px-2 py-2 font-medium text-cream max-w-[200px] truncate">{r.name}</td>
                        <td className="px-2 py-2 font-mono text-gold/90">{r.sku || '— auto —'}</td>
                        <td className="px-2 py-2 text-zinc-500 truncate max-w-[120px]">{r.supplier_product_id || '—'}</td>
                        <td className="px-2 py-2 text-right tabular-nums">{Number(r.default_price ?? r.price ?? 0)}</td>
                        <td className="px-2 py-2 text-zinc-500 truncate max-w-[120px]">{r._mappedCategory}</td>
                        <td className="px-2 py-2">
                          {r.image_url || r.image ? (
                            // eslint-disable-next-line @next/next/no-img-element
                            <img
                              src={String(r.image_url || r.image)}
                              alt=""
                              width={40}
                              height={40}
                              className="rounded-md object-cover border border-border bg-black/20"
                              loading="lazy"
                            />
                          ) : (
                            <span className="text-zinc-600">—</span>
                          )}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
        </Card>

        <Card className="p-4 border-gold-dim/20">
          <h2 className="text-xs font-bold tracking-wider text-gold mb-3">5 · Commit import</h2>
          <p className="text-[11px] text-zinc-500 mb-3">
            New rows append to PRODUCT MASTER only. Existing SKUs and supplier IDs are always skipped server-side.
            Duplicate product names are skipped when the server flag is on (default).
          </p>
          <div className="flex flex-wrap gap-2 items-center">
            <Button variant="gold" size="md" disabled={commitLoading || !selectedCount} onClick={() => void runImport()}>
              {commitLoading ? (
                <>
                  <Spinner /> Importing…
                </>
              ) : (
                `Import ${selectedCount} selected`
              )}
            </Button>
            {retryItems && retryItems.length > 0 && (
              <Button variant="ghost" size="sm" disabled={commitLoading} onClick={() => void runImport(retryItems)}>
                Retry failed ({retryItems.length})
              </Button>
            )}
          </div>
          {commitLoading && (
            <div className="mt-3">
              <Progress value={40} max={100} />
              <p className="text-[10px] text-zinc-600 mt-1">Writing to Google Sheets…</p>
            </div>
          )}
        </Card>

        {lastResult && (
          <Card className="p-4">
            <h2 className="text-xs font-bold tracking-wider text-gold mb-2">Last import summary</h2>
            <ul className="text-[11px] text-zinc-400 space-y-1 font-mono">
              <li>Created: {(lastResult.created ?? []).length}</li>
              <li>Skipped: {(lastResult.skipped ?? []).length}</li>
              <li>Errors: {(lastResult.errors ?? []).length}</li>
            </ul>
          </Card>
        )}

        <Card className="p-4">
          <h2 className="text-xs font-bold tracking-wider text-zinc-500 mb-2">Import log</h2>
          <pre className="text-[10px] text-zinc-500 font-mono whitespace-pre-wrap max-h-48 overflow-y-auto">
            {logs.length ? logs.join('\n') : '—'}
          </pre>
        </Card>
      </div>
    </>
  )
}
