/**
 * demo-catalogue-refresh.mjs — rebuild `scripts/demo-catalogue.json` from the live
 * storefront.
 *
 * The demo seeds real products so a visitor recognises the shop instead of reading
 * invented names. Names, prices and photographs come from the almatraders.com
 * Supabase project; its product images are already served from a **public** bucket,
 * so the demo can point straight at them — no copy, no key, no signed-URL expiry.
 * (The ERP's own `product_images` table stores *signed* links into a private bucket,
 * which expire — those are unusable here.)
 *
 * Read-only. Run it when the shop's catalogue changes:
 *
 *   WEBSITE_SUPABASE_URL=... WEBSITE_SUPABASE_SERVICE_ROLE_KEY=... \
 *     node scripts/demo-catalogue-refresh.mjs
 */
import { writeFileSync } from 'node:fs'

const base = (process.env.WEBSITE_SUPABASE_URL || '').replace(/\/$/, '')
const key = process.env.WEBSITE_SUPABASE_SERVICE_ROLE_KEY || ''
if (!base || !key) {
  console.error('Set WEBSITE_SUPABASE_URL and WEBSITE_SUPABASE_SERVICE_ROLE_KEY.')
  process.exit(1)
}

async function get(path) {
  const res = await fetch(`${base}/rest/v1/${path}`, {
    headers: { apikey: key, Authorization: `Bearer ${key}` },
  })
  const data = await res.json()
  if (!Array.isArray(data)) throw new Error(`query failed: ${data.message ?? res.status}`)
  return data
}

const products = await get(
  'products?select=id,sku,title,title_bn,price_bdt,product_type,age_group'
  + '&published=eq.true&deleted_at=is.null&limit=300',
)
const images = await get('product_images?select=product_id,url,sort_order&limit=1000')

// One photo per product: the lowest sort_order is the one the storefront leads with.
const best = new Map()
for (const im of images) {
  if (!im.url) continue
  const order = im.sort_order ?? 0
  const current = best.get(im.product_id)
  if (!current || order < current.order) best.set(im.product_id, { order, url: im.url })
}

const rows = []
for (const p of products) {
  const hit = best.get(p.id)
  const name = (p.title_bn || p.title || '').trim()
  const price = Number(p.price_bdt || 0)
  if (!hit || !name || !price) continue
  rows.push({
    sku: p.sku,
    name,
    category: (p.product_type || 'Other').trim() || 'Other',
    ageGroup: p.age_group || '',
    price: Math.round(price),
    imageUrl: hit.url,
  })
}

writeFileSync(new URL('./demo-catalogue.json', import.meta.url), `${JSON.stringify(rows, null, 1)}\n`)
console.log(`wrote ${rows.length} products (of ${products.length} published) to demo-catalogue.json`)
