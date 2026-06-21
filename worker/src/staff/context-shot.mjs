/**
 * Builds a simple PNG "data card" from internal ERP rows — zero LLM.
 * Best-effort: returns null on any failure (never blocks dispatch).
 */
import { existsSync, mkdirSync, writeFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { tmpdir } from 'os'
import { getAppUrl, getInternalToken } from '../env.mjs'
import { ensureTaskProofsBucket } from './task-proof-storage.mjs'

/**
 * Register the repo's bundled Bangla TTFs with fontconfig BEFORE any sharp/librsvg
 * text render. The VPS has NO Bangla system font, so customer/product names (Bangla)
 * would otherwise render as tofu (□□□). The fonts already ship on disk under the repo
 * `public/fonts/**` — we just point fontconfig at them and give it a writable cache.
 * Idempotent + best-effort: runs once per process, never throws.
 */
let fontsReady = false
function ensureBanglaFonts() {
  if (fontsReady) return
  fontsReady = true
  try {
    const here = dirname(fileURLToPath(import.meta.url)) // worker/src/staff
    const candidates = [
      join(here, '../../../public/fonts'),        // repo-root/public/fonts (deployed layout)
      join(here, '../../../public/fonts/brand'),
      join(process.cwd(), 'public/fonts'),
      join(process.cwd(), '../public/fonts'),
    ]
    const dirs = [...new Set(candidates)].filter((d) => existsSync(d))
    if (!dirs.length) return
    const cacheDir = join(tmpdir(), 'alma-worker-fontconfig')
    mkdirSync(cacheDir, { recursive: true })
    const confPath = join(tmpdir(), 'alma-worker-fonts.conf')
    const conf =
      `<?xml version="1.0"?>\n<fontconfig>\n`
      + dirs.map((d) => `  <dir>${d}</dir>`).join('\n')
      + `\n  <cachedir>${cacheDir}</cachedir>\n</fontconfig>\n`
    writeFileSync(confPath, conf)
    process.env.FONTCONFIG_FILE = confPath
    process.env.FONTCONFIG_PATH = tmpdir()
    if (!process.env.XDG_CACHE_HOME) process.env.XDG_CACHE_HOME = tmpdir()
  } catch (err) {
    console.warn('[context-shot] font setup failed:', err?.message ?? err)
  }
}

/** Font stack with an explicit Bangla family so pango resolves Bangla glyphs. */
const FONT_STACK = "'Noto Sans Bengali', 'Hind Siliguri', sans-serif"

const CONTEXT_SHOT_TYPES = new Set([
  'order_followup',
  'stock_check',
  'listing_update',
  'product_content',
  'ad_creative',
])

function escapeXml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function truncate(s, max = 28) {
  const t = String(s ?? '').trim()
  if (t.length <= max) return t
  return `${t.slice(0, max - 1)}…`
}

function renderDataCardSvg({ title, subtitle, columns, rows }) {
  const colW = columns.map((c) => c.width ?? 120)
  const tableW = colW.reduce((a, b) => a + b, 0)
  const rowH = 28
  const headerH = 36
  const pad = 16
  const height = pad * 2 + 48 + headerH + rows.length * rowH + 8
  const width = pad * 2 + tableW

  let headerCells = ''
  let x = pad
  for (let i = 0; i < columns.length; i++) {
    headerCells += `<text x="${x + 6}" y="${pad + 48 + 22}" font-family="${FONT_STACK}" font-size="12" font-weight="600" fill="#334155">${escapeXml(columns[i].label)}</text>`
    x += colW[i]
  }

  let body = ''
  let y = pad + 48 + headerH
  for (const row of rows) {
    body += `<rect x="${pad}" y="${y}" width="${tableW}" height="${rowH}" fill="${rows.indexOf(row) % 2 === 0 ? '#f8fafc' : '#ffffff'}" />`
    x = pad
    for (let i = 0; i < columns.length; i++) {
      const key = columns[i].key
      body += `<text x="${x + 6}" y="${y + 18}" font-family="${FONT_STACK}" font-size="11" fill="#1e293b">${escapeXml(truncate(row[key], columns[i].max ?? 28))}</text>`
      x += colW[i]
    }
    y += rowH
  }

  let colLines = ''
  x = pad
  for (const w of colW) {
    colLines += `<line x1="${x}" y1="${pad + 48}" x2="${x}" y2="${height - pad}" stroke="#e2e8f0" stroke-width="1"/>`
    x += w
  }

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <rect width="100%" height="100%" fill="#ffffff"/>
  <rect x="${pad}" y="${pad}" width="${tableW}" height="40" rx="8" fill="#0f766e"/>
  <text x="${pad + 10}" y="${pad + 26}" font-family="${FONT_STACK}" font-size="15" font-weight="700" fill="#ffffff">${escapeXml(title)}</text>
  ${subtitle ? `<text x="${pad + 10}" y="${pad + 48 + 12}" font-family="${FONT_STACK}" font-size="11" fill="#64748b">${escapeXml(subtitle)}</text>` : ''}
  <rect x="${pad}" y="${pad + 48}" width="${tableW}" height="${headerH}" fill="#ecfdf5"/>
  ${headerCells}
  <line x1="${pad}" y1="${pad + 48 + headerH}" x2="${pad + tableW}" y2="${pad + 48 + headerH}" stroke="#cbd5e1" stroke-width="1"/>
  ${body}
  ${colLines}
  <line x1="${pad + tableW}" y1="${pad + 48}" x2="${pad + tableW}" y2="${height - pad}" stroke="#e2e8f0" stroke-width="1"/>
  <rect x="${pad}" y="${pad + 48}" width="${tableW}" height="${height - pad - pad - 48}" fill="none" stroke="#cbd5e1" stroke-width="1" rx="4"/>
</svg>`
}

async function svgToPng(svg) {
  try {
    ensureBanglaFonts()
    const sharp = (await import('sharp')).default
    return sharp(Buffer.from(svg)).png().toBuffer()
  } catch (err) {
    console.warn('[context-shot] sharp unavailable:', err.message)
    return null
  }
}

async function uploadContextShot(supabase, taskId, pngBuffer) {
  await ensureTaskProofsBucket()
  const path = `context-shots/${taskId}.png`
  const { error } = await supabase.storage
    .from('task-proofs')
    .upload(path, pngBuffer, { upsert: true, contentType: 'image/png' })
  if (error) {
    const altPath = `context-shots/${taskId}.png`
    const alt = await supabase.storage
      .from('agent-files')
      .upload(altPath, pngBuffer, { upsert: true, contentType: 'image/png' })
    if (alt.error) throw new Error(alt.error.message)
    const { data } = supabase.storage.from('agent-files').getPublicUrl(altPath)
    return data.publicUrl
  }
  const { data } = supabase.storage.from('task-proofs').getPublicUrl(path)
  return data.publicUrl
}

async function fetchPendingOrders(supabase, productRef) {
  let query = supabase
    .from('lifestyle_orders')
    .select('id, customer, product, phone, sell_price, status, date')
    .eq('status', 'Pending')
    .order('date', { ascending: false })
    .limit(8)
  if (productRef) {
    query = query.ilike('product', `%${productRef}%`)
  }
  const { data, error } = await query
  if (error) throw error
  return data ?? []
}

async function fetchInventoryRow(productRef) {
  if (!productRef) return null
  try {
    const res = await fetch(
      `${getAppUrl()}/api/assistant/internal/staff-task-proposal?date=${new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Dhaka' })}`,
      { headers: { Authorization: `Bearer ${getInternalToken()}` }, signal: AbortSignal.timeout(8000) },
    )
    if (!res.ok) return null
    const data = await res.json()
    const pick = (data.rotationPicks ?? []).find(
      (p) => p.productRef === productRef || p.name === productRef,
    )
    if (!pick) return null
    return {
      name: pick.name,
      current_stock: pick.stock,
      reorder_level: pick.sales30d ?? '—',
    }
  } catch {
    return null
  }
}

/**
 * @param {{ supabase: import('@supabase/supabase-js').SupabaseClient, task: Record<string, unknown> }} params
 * @returns {Promise<string|null>} public URL or null
 */
export async function buildContextShot({ supabase, task }) {
  try {
    const type = String(task.type ?? '')
    if (!CONTEXT_SHOT_TYPES.has(type)) return null

    const productRef = task.product_ref ?? task.productRef ?? null
    let title = 'ALMA — Task Context'
    let subtitle = truncate(task.title, 60)
    let columns = []
    let rows = []

    if (type === 'order_followup') {
      rows = await fetchPendingOrders(supabase, productRef)
      if (!rows.length) return null
      title = '📦 Pending Orders'
      subtitle = `${rows.length}টি (ERP snapshot)`
      columns = [
        { key: 'customer', label: 'Customer', width: 100, max: 16 },
        { key: 'product', label: 'Product', width: 120, max: 22 },
        { key: 'phone', label: 'Phone', width: 90, max: 14 },
        { key: 'sell_price', label: '৳', width: 50, max: 8 },
      ]
    } else if (productRef) {
      const inv = await fetchInventoryRow(productRef)
      if (inv) {
        title = '📊 Product / Stock'
        subtitle = `SKU: ${productRef}`
        columns = [
          { key: 'name', label: 'Name', width: 140, max: 24 },
          { key: 'current_stock', label: 'Stock', width: 60, max: 8 },
          { key: 'reorder_level', label: 'Reorder', width: 70, max: 8 },
        ]
        rows = [inv]
      } else {
        const { data: orders } = await supabase
          .from('lifestyle_orders')
          .select('product, customer, sell_price, status')
          .ilike('product', `%${productRef}%`)
          .order('date', { ascending: false })
          .limit(6)
        rows = orders ?? []
        if (!rows.length) return null
        title = '📊 Recent Orders'
        subtitle = productRef
        columns = [
          { key: 'product', label: 'Product', width: 120, max: 22 },
          { key: 'customer', label: 'Customer', width: 100, max: 16 },
          { key: 'status', label: 'Status', width: 80, max: 12 },
          { key: 'sell_price', label: '৳', width: 50, max: 8 },
        ]
      }
    }

    if (!rows.length) return null

    const svg = renderDataCardSvg({ title, subtitle, columns, rows })
    const png = await svgToPng(svg)
    if (!png) return null

    const taskId = task.id
    if (!taskId) return null
    return await uploadContextShot(supabase, taskId, png)
  } catch (err) {
    console.warn('[context-shot] build failed:', err.message)
    return null
  }
}
