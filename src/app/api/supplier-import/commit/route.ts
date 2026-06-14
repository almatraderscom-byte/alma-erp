import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { dispatchCreateProduct } from '@/lib/lifestyle/write-dispatch'
import { SUPPLIER_IMPORT_CHUNK } from '@/lib/supplier-import'
import { mergeActorPayload } from '@/lib/api-route-actor'

export type SupplierImportItem = Record<string, unknown>

function mapImportItem(item: SupplierImportItem) {
  const name = String(item.name ?? item.product ?? '').trim()
  return {
    name,
    category: String(item.category ?? ''),
    default_price: Number(item.default_price ?? item.price ?? 0),
    default_cogs: Number(item.default_cogs ?? item.cogs ?? 0),
    image_url: item.image_url ?? item.image,
    description: item.description,
    notes: item.notes,
    sku: item.sku ? String(item.sku).trim() : undefined,
    supplier: item.supplier ? String(item.supplier) : 'SmartChinaHub',
    supplier_product_id: item.supplier_product_id ? String(item.supplier_product_id) : undefined,
    variants_json: item.variants_json
      ? String(item.variants_json)
      : item.variants
        ? JSON.stringify(item.variants)
        : undefined,
    active: item.active !== false,
    sync_to_stock: true,
  }
}

/**
 * Bulk supplier import — Postgres product master (Phase 4 close-out).
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

    const skipDuplicateNames = body.skip_duplicate_names !== false
    await mergeActorPayload(req, body as Record<string, unknown>)

    const existingProducts = await prisma.lifestyleProduct.findMany({
      select: { sku: true, name: true, supplierProductId: true },
    })
    const skus = new Set(existingProducts.map(p => p.sku.toLowerCase()))
    const names = new Set(existingProducts.map(p => p.name.trim().toLowerCase()))
    const supplierIds = new Set(
      existingProducts.map(p => String(p.supplierProductId || '').trim().toLowerCase()).filter(Boolean),
    )

    const created: string[] = []
    const skipped: Array<{ sku: string; reason: string }> = []
    const errors: Array<{ index?: number; sku?: string; message: string }> = []

    for (let i = 0; i < items.length; i++) {
      const mapped = mapImportItem(items[i])
      if (!mapped.name) {
        errors.push({ index: i, message: 'Missing product name' })
        continue
      }

      const skuKey = String(mapped.sku || '').trim().toLowerCase()
      const nameKey = mapped.name.toLowerCase()
      const sidKey = String(mapped.supplier_product_id || '').trim().toLowerCase()

      if (skuKey && skus.has(skuKey)) {
        skipped.push({ sku: mapped.sku || mapped.name, reason: 'duplicate_sku' })
        continue
      }
      if (sidKey && supplierIds.has(sidKey)) {
        skipped.push({ sku: mapped.sku || mapped.name, reason: 'duplicate_supplier_id' })
        continue
      }
      if (skipDuplicateNames && names.has(nameKey)) {
        skipped.push({ sku: mapped.sku || mapped.name, reason: 'duplicate_name' })
        continue
      }

      try {
        const res = await dispatchCreateProduct(mapped as Record<string, unknown>)
        const productId = String(res.product_id || mapped.sku || mapped.name)
        created.push(productId)
        if (skuKey) skus.add(skuKey)
        names.add(nameKey)
        if (sidKey) supplierIds.add(sidKey)
      } catch (e) {
        errors.push({
          index: i,
          sku: mapped.sku,
          message: (e as Error).message,
        })
      }

      if ((i + 1) % SUPPLIER_IMPORT_CHUNK === 0) {
        await new Promise(r => setTimeout(r, 0))
      }
    }

    return NextResponse.json({ ok: true, created, skipped, errors })
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 })
  }
}
