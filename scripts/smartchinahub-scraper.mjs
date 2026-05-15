#!/usr/bin/env node
/**
 * Smart China Hub — one-time bulk scrape (Playwright + your logged-in Chrome).
 *
 * 1) Quit Chrome, start with:  --remote-debugging-port=9222
 * 2) Log in to SmartChinaHub manually in that window.
 * 3) Run:  SMARTCHINAHUB_CDP_URL=http://127.0.0.1:9222 npm run supplier:scrape
 *
 * Writes: tmp/supplier-products.json  →  Alma → Inventory → Import supplier products
 *
 * No auto-login. No sync. No supplier API.
 */

import fs from 'fs'
import path from 'path'
import { pathToFileURL } from 'url'
import { config } from 'dotenv'
import { chromium } from 'playwright'

config({ path: path.resolve(process.cwd(), '.env.local') })
config({ path: path.resolve(process.cwd(), '.env') })

const BASE = (process.env.SMARTCHINAHUB_BASE_URL || 'https://www.smartchinahub.com').replace(/\/$/, '')
const PRODUCTS_URL =
  process.env.SMARTCHINAHUB_PRODUCTS_URL || `${BASE}/seller/products/show`
const CDP_URL = (process.env.SMARTCHINAHUB_CDP_URL || '').trim()
const NAV_TIMEOUT = Number(process.env.SMARTCHINAHUB_NAV_TIMEOUT_MS || 60000)
const MAX_PAGES = Number(process.env.SMARTCHINAHUB_MAX_PAGES || 80)
const HYDRATION_MS = Number(process.env.SMARTCHINAHUB_HYDRATION_MS || 5000)
const DEBUG_DIR = path.resolve(process.cwd(), 'tmp', 'debug-scraper')

const SELECTORS = {
  productRow: [
    'table tbody tr',
    '[data-product-id]',
    '[data-product-slug]',
    '.product-row',
    '.table-responsive tbody tr',
    '[class*="product-card"]',
    '[class*="ProductCard"]',
    'article',
    '.grid > a[href*="/product"]',
  ],
  nextPage: [
    'a[rel="next"]',
    'button:has-text("Next")',
    'a:has-text("Next")',
    '.pagination a:has-text("›")',
    '.pagination a:has-text("»")',
    'ul.pagination li.active + li a',
    '[aria-label="Next"]',
  ],
}

function delay(ms) {
  return new Promise(r => setTimeout(r, ms))
}

function ensureDebugDir() {
  fs.mkdirSync(DEBUG_DIR, { recursive: true })
}

async function saveScreenshot(page, label) {
  ensureDebugDir()
  const safe = String(label).replace(/[^a-z0-9-_]/gi, '_')
  const fp = path.join(DEBUG_DIR, `${Date.now()}-${safe}.png`)
  try {
    await page.screenshot({ path: fp, fullPage: true })
    console.log(`[scraper] screenshot → ${fp}`)
  } catch (e) {
    console.warn('[scraper] screenshot failed:', (e && e.message) || e)
  }
}

/** Fixed filenames under tmp/debug-scraper/ (per run, overwrite). */
async function saveScreenshotFixed(page, filename) {
  ensureDebugDir()
  const fp = path.join(DEBUG_DIR, filename)
  try {
    await page.screenshot({ path: fp, fullPage: true })
    console.log(`[scraper] screenshot → ${fp}`)
  } catch (e) {
    console.warn('[scraper] screenshot failed:', (e && e.message) || e)
  }
}

function looksLikeLoginUrl(u) {
  if (!u) return false
  if (/\/seller\/login/i.test(u)) return true
  if (/\/(login|signin|auth)(\/|$|\?)/i.test(u)) return true
  return false
}

function isProductsPageUrl(u) {
  if (!u || typeof u !== 'string') return false
  try {
    const pathname = new URL(u).pathname.replace(/\/$/, '') || '/'
    return pathname.endsWith('/seller/products/show') || pathname.includes('/seller/products/show')
  } catch {
    return u.includes('/seller/products/show')
  }
}

async function logBrowserState(browser) {
  let contexts = browser.contexts()
  console.log(`[scraper] browser contexts: ${contexts.length}`)

  if (!contexts.length) {
    console.warn('[scraper] no contexts from CDP — creating a new browser context')
    try {
      await browser.newContext()
      contexts = browser.contexts()
      console.log(`[scraper] browser contexts after newContext: ${contexts.length}`)
    } catch (e) {
      console.warn('[scraper] newContext failed:', (e && e.message) || e)
    }
  }

  let tabIndex = 0
  for (let ci = 0; ci < contexts.length; ci++) {
    const pages = contexts[ci].pages()
    console.log(`[scraper] context ${ci} open tabs: ${pages.length}`)
    for (const p of pages) {
      let url = ''
      try {
        url = p.url()
      } catch {
        url = '(url unreadable)'
      }
      console.log(`[scraper]   tab ${tabIndex}: ${url}`)
      tabIndex++
    }
  }
  return contexts
}

/** Prefer a context that already has SmartChinaHub tabs (CDP default context is often empty). */
function pickHostContext(contexts, hostPart = 'smartchinahub') {
  let best = contexts[0]
  let bestScore = -1
  for (const ctx of contexts) {
    let score = 0
    for (const p of ctx.pages()) {
      try {
        const u = p.url()
        if (u.includes(hostPart)) score += 20
        score += 1
      } catch {
        /* ignore */
      }
    }
    if (score > bestScore) {
      bestScore = score
      best = ctx
    }
  }
  return best
}

/**
 * Reuse an existing SmartChinaHub products tab if present; otherwise open a new tab.
 * @param {import('playwright').BrowserContext[]} contexts
 */
async function pickOrOpenProductsPage(contexts) {
  if (!contexts.length) {
    throw new Error('No browser contexts available over CDP. Is Chrome running with --remote-debugging-port?')
  }

  /** @type {import('playwright').Page | null} */
  let page = null
  for (const ctx of contexts) {
    for (const p of ctx.pages()) {
      let url = ''
      try {
        url = p.url()
      } catch {
        continue
      }
      if (isProductsPageUrl(url)) {
        page = p
        break
      }
    }
    if (page) break
  }

  const ctx = pickHostContext(contexts)
  if (page) {
    console.log('[scraper] reusing existing authenticated products tab')
  } else {
    console.log('[scraper] products page not open — opening new tab →', PRODUCTS_URL)
    page = await ctx.newPage()
    await page.goto(PRODUCTS_URL, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT })
  }

  page.setDefaultTimeout(NAV_TIMEOUT)
  return page
}

async function dumpVisibleDomSummary(page) {
  try {
    const summary = await page.evaluate(() => {
      const body = document.body
      const text = (body && body.innerText) ? body.innerText.slice(0, 8000) : ''
      const title = document.title || ''
      const tags = ['table', 'tr', 'article', 'a', 'img', 'button', 'main', '[class*="product"]']
      const counts = {}
      for (const sel of tags) {
        try {
          counts[sel] = document.querySelectorAll(sel).length
        } catch {
          counts[sel] = -1
        }
      }
      return { title, textPreview: text, tagCounts: counts }
    })
    console.log('[scraper] visible DOM summary (no product cards matched):')
    console.log(JSON.stringify(summary, null, 2))
  } catch (e) {
    console.warn('[scraper] could not read DOM summary:', (e && e.message) || e)
  }
}

function absUrl(href) {
  if (!href) return ''
  const t = String(href).trim()
  if (t.startsWith('http://') || t.startsWith('https://')) return t
  if (t.startsWith('//')) return 'https:' + t
  if (t.startsWith('/')) return BASE + t
  return t
}

/** Prefer largest declared width / longest https URL (avoids tiny icons). */
async function bestImageUrlFromRow(row) {
  const imgs = row.locator('img')
  const n = await imgs.count()
  let best = ''
  let bestScore = 0
  for (let i = 0; i < n; i++) {
    const im = imgs.nth(i)
    const src = (await im.getAttribute('src').catch(() => '')) || ''
    const ds = (await im.getAttribute('data-src').catch(() => '')) || ''
    const raw = ds || src
    const url = absUrl(raw)
    if (!url || url.startsWith('data:') || /placeholder|spinner|logo|icon|avatar/i.test(url)) continue
    const w = parseInt(String(await im.getAttribute('width').catch(() => '0')), 10) || 0
    const h = parseInt(String(await im.getAttribute('height').catch(() => '0')), 10) || 0
    const score = w * h || w * 10 || h * 10 || Math.min(url.length, 200)
    if (score > bestScore) {
      bestScore = score
      best = url
    }
  }
  return best
}

async function collectVariants(row) {
  const out = []
  const seen = new Set()
  const add = s => {
    const t = String(s || '').trim()
    if (t.length < 1 || t.length > 120) return
    const k = t.toLowerCase()
    if (seen.has(k)) return
    seen.add(k)
    out.push(t)
  }

  const opts = await row.locator('select option').allTextContents().catch(() => [])
  for (const o of opts) add(o)

  const badges = await row.locator('[class*="variant"], [class*="badge"], .tag, .chip').allInnerTexts().catch(() => [])
  for (const b of badges) add(b)

  return out.slice(0, 80)
}

function parsePriceFromTexts(texts) {
  for (const t of texts) {
    if (/[\d.,]+\s*(৳|tk|bdt|usd|\$|€|£)/i.test(t)) {
      const n = parseFloat(String(t).replace(/[^\d.]/g, ''))
      if (!Number.isNaN(n) && n >= 0) return n
    }
  }
  for (const t of texts) {
    const s = String(t).replace(/\s/g, '').replace(',', '.')
    if (/^\d+(\.\d+)?$/.test(s)) {
      const n = parseFloat(s)
      if (!Number.isNaN(n) && n >= 0) return n
    }
  }
  return 0
}

function rowFromTableCells(cells, pageIndex, rowIndex) {
  const texts = cells.map(c => c.trim()).filter(Boolean)
  if (texts.length < 2) return null
  const joined = texts.join(' | ').toLowerCase()
  if (/^(sku|product|name|price|#|id|image|photo)\b/.test(joined)) return null

  let name = texts[0] || ''
  if (texts.length >= 2 && (name.length < 2 || /^[\d#]+$/.test(name))) name = texts[1] || name

  const price = parsePriceFromTexts(texts)
  if (!name || name.length < 2) return null

  return {
    supplier_product_id: `p${pageIndex}-${rowIndex}`,
    name: name.split('\n')[0].trim(),
    price,
    image_url: '',
    variants: [],
    supplier: 'SmartChinaHub',
  }
}

async function extractProduct(row, pageIndex, rowIndex) {
  const pid =
    (await row.getAttribute('data-product-id').catch(() => null)) ||
    (await row.getAttribute('data-id').catch(() => null)) ||
    (await row.getAttribute('data-slug').catch(() => null))

  const cells = await row.locator('td, th').allInnerTexts().catch(() => [])
  let rec = null
  if (cells.length >= 2) {
    rec = rowFromTableCells(cells, pageIndex, rowIndex)
  }

  if (!rec) {
    const title =
      (await row.locator('h1, h2, h3, h4, [class*="title"], [class*="name"]').first().innerText().catch(() => '')) ||
      (await row.locator('a').first().innerText().catch(() => ''))
    const rawTitle = String(title || '').trim().split('\n')[0].trim()
    if (!rawTitle || rawTitle.length < 2) return null
    const body = await row.innerText().catch(() => '')
    const lines = body.split('\n').map(l => l.trim()).filter(Boolean)
    const price = parsePriceFromTexts(lines)
    rec = {
      supplier_product_id: pid ? String(pid) : `p${pageIndex}-${rowIndex}`,
      name: rawTitle,
      price,
      image_url: '',
      variants: [],
      supplier: 'SmartChinaHub',
    }
  }

  if (pid) rec.supplier_product_id = String(pid)

  rec.image_url = await bestImageUrlFromRow(row)
  rec.variants = await collectVariants(row)

  return rec
}

function dedupeKey(rec) {
  const id = String(rec.supplier_product_id || '').trim().toLowerCase()
  if (id && !id.startsWith('p')) return `id:${id}`
  return `n:${rec.name.trim().toLowerCase()}`
}

async function scrapeAllPages(page) {
  const items = []
  const seen = new Set()

  await page.waitForLoadState('load', { timeout: NAV_TIMEOUT }).catch(() => {})

  if (looksLikeLoginUrl(page.url())) {
    await saveScreenshotFixed(page, 'products-page.png')
    throw new Error('Not logged in (login page). Start Chrome with --remote-debugging-port=9222, sign in, then run again.')
  }

  await saveScreenshotFixed(page, 'products-page.png')

  let loggedCards = false

  for (let p = 0; p < MAX_PAGES; p++) {
    console.log(`[scraper] pagination index ${p + 1}`)
    let rowSel = null
    let rowCount = 0
    for (const s of SELECTORS.productRow) {
      const n = await page.locator(s).count()
      if (n > 0) {
        const firstText = await page.locator(s).first().innerText().catch(() => '')
        if (n > 1 || (firstText && firstText.trim().length > 3)) {
          rowSel = s
          rowCount = n
          break
        }
      }
    }
    if (!rowSel) {
      console.warn('[scraper] no product rows matched SELECTORS.productRow on this view')
      await dumpVisibleDomSummary(page)
      await saveScreenshotFixed(page, 'extraction-preview.png')
      break
    }

    if (!loggedCards) {
      console.log('product cards found')
      console.log(`[scraper] selector "${rowSel}" → ${rowCount} nodes`)
      await saveScreenshotFixed(page, 'extraction-preview.png')
      console.log('starting extraction')
      loggedCards = true
    }

    const rows = page.locator(rowSel)
    const count = await rows.count()
    for (let i = 0; i < count; i++) {
      const rec = await extractProduct(rows.nth(i), p, i)
      if (!rec) continue
      const k = dedupeKey(rec)
      if (seen.has(k)) continue
      seen.add(k)
      items.push(rec)
    }

    let next = null
    for (const s of SELECTORS.nextPage) {
      const loc = page.locator(s).first()
      if (await loc.count()) {
        const dis = await loc.isDisabled().catch(() => true)
        const vis = await loc.isVisible().catch(() => false)
        if (vis && !dis) {
          next = loc
          break
        }
      }
    }
    if (!next) break
    await next.click()
    await page.waitForLoadState('networkidle', { timeout: NAV_TIMEOUT }).catch(() => {})
    await delay(800)
  }

  console.log(`[scraper] ${items.length} products (deduped)`)
  return items
}

/** Minimal rows for Alma import + readable JSON. */
function toExportItems(items) {
  return items.map(r => {
    const o = {
      supplier_product_id: r.supplier_product_id,
      name: r.name,
      price: Number(r.price) || 0,
      image_url: r.image_url || '',
      variants: Array.isArray(r.variants) ? r.variants : [],
      supplier: 'SmartChinaHub',
    }
    return o
  })
}

async function main() {
  if (!CDP_URL) {
    console.error(`
Set SMARTCHINAHUB_CDP_URL in .env.local, e.g.:

  SMARTCHINAHUB_CDP_URL=http://127.0.0.1:9222

Then start Chrome with --remote-debugging-port=9222, log in to SmartChinaHub, and run:

  npm run supplier:scrape
`)
    process.exit(1)
  }

  const outDir = path.resolve(process.cwd(), 'tmp')
  fs.mkdirSync(outDir, { recursive: true })
  const outFile = path.join(outDir, 'supplier-products.json')

  /** @type {import('playwright').Browser | null} */
  let browser = null
  /** @type {import('playwright').Page | null} */
  let page = null

  try {
    console.log(`[scraper] CDP ${CDP_URL}`)
    browser = await chromium.connectOverCDP(CDP_URL)

    const contexts = await logBrowserState(browser)

    let sessionPage = null
    for (const c of contexts) {
      const ps = c.pages()
      if (ps.length) {
        sessionPage = ps[0]
        break
      }
    }
    if (sessionPage) {
      await saveScreenshotFixed(sessionPage, 'connected-session.png')
    }

    page = await pickOrOpenProductsPage(contexts)

    if (!sessionPage) {
      await saveScreenshotFixed(page, 'connected-session.png')
    }

    await page.bringToFront()
    await page.waitForLoadState('networkidle', { timeout: NAV_TIMEOUT }).catch(err => {
      console.warn('[scraper] waitForLoadState(networkidle):', (err && err.message) || err)
    })
    await delay(5000)

    console.log('products page detected')

    const rawItems = await scrapeAllPages(page)
    const items = toExportItems(rawItems)
    const payload = {
      format: 'alma-supplier-import-v1',
      scrapedAt: new Date().toISOString(),
      sourceUrl: PRODUCTS_URL,
      items,
    }
    fs.writeFileSync(outFile, JSON.stringify(payload, null, 2), 'utf8')

    console.log(`scraped ${items.length} products`)
    console.log('saved tmp/supplier-products.json')
    console.log(pathToFileURL(outFile).href)
  } catch (err) {
    if (page) {
      await saveScreenshotFixed(page, 'products-page.png').catch(() => {})
      await saveScreenshot(page, 'error').catch(() => {})
    }
    console.error('[scraper] FAILED:', err && err.message ? err.message : err)
    throw err
  } finally {
    if (browser) await browser.close().catch(() => {})
  }
}

main().catch(err => {
  console.error('[scraper] FATAL:', err && err.stack ? err.stack : String(err))
  process.exit(1)
})
