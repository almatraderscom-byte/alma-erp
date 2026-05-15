import { NextRequest, NextResponse } from 'next/server'
import { serverPost } from '@/lib/server-api'
import { SUPPLIER_IMPORT_CHUNK } from '@/lib/supplier-import'
import { withActorPayload } from '@/lib/api-route-actor'

const BATCH_TIMEOUT_MS = 120_000

export type SupplierImportItem = Record<string, unknown>

/**
 * Proxies chunked writes to GAS `batch_import_product_master`.
 * Never sends credentials to the browser — uses server-side API_SECRET only.
 */
export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as {
      items?: SupplierImportItem[]
      skip_duplicate_names?: boolean
    }
    const items = Array.isArray(body.items) ? body.items : []
    if (!items.length) {
      return NextResponse.json({ error: 'items array required' }, { status: 400 })
    }
    if (items.length > 500) {
      return NextResponse.json({ error: 'Max 500 items per run — split into multiple imports.' }, { status: 400 })
    }

    const skip_duplicate_names = body.skip_duplicate_names !== false
    const created: string[] = []
    const skipped: Array<{ sku: string; reason: string }> = []
    const errors: Array<{ index?: number; sku?: string; message: string }> = []

    for (let i = 0; i < items.length; i += SUPPLIER_IMPORT_CHUNK) {
      const chunk = items.slice(i, i + SUPPLIER_IMPORT_CHUNK)
      const res = await serverPost<{
        ok?: boolean
        error?: string
        created?: string[]
        skipped?: Array<{ sku: string; reason: string }>
        errors?: Array<{ index?: number; sku?: string; message: string }>
      }>(
        'batch_import_product_master',
        withActorPayload(req, {
          items: chunk,
          skip_duplicate_names,
        }),
        { timeoutMs: BATCH_TIMEOUT_MS },
      )
      if (res.error) throw new Error(res.error)
      if (res.created?.length) created.push(...res.created)
      if (res.skipped?.length) skipped.push(...res.skipped)
      if (res.errors?.length) {
        for (const e of res.errors) {
          errors.push({
            index: e.index !== undefined ? i + (e.index as number) : i,
            sku: e.sku,
            message: e.message,
          })
        }
      }
    }

    return NextResponse.json({ ok: true, created, skipped, errors })
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 })
  }
}
