/**
 * Product Rotation Engine — SUB-PART B
 *
 * Inputs per product:
 *   - 30/90-day sales, stock level, lastPromotedAt, seasonal tags
 *
 * Scoring:
 *   - Base tier: bestseller→2-3x/week, medium→weekly, slow→min 1-2x/month
 *   - Modifiers: seasonal, stock pressure (high stock × low sales), recency bump (30+ days unmarketed)
 *
 * Output:
 *   - 2-4 picks with reason strings for approval card
 *   - Generated task types
 */

import { createClient } from '@supabase/supabase-js'

const APP_URL    = process.env.APP_URL?.replace(/\/$/, '') ?? ''
const INT_TOKEN  = process.env.AGENT_INTERNAL_TOKEN ?? ''

// ── ERP data fetch helpers ────────────────────────────────────────────────────

async function fetchFromAgent(endpoint) {
  const res = await fetch(`${APP_URL}${endpoint}`, {
    headers: { Authorization: `Bearer ${INT_TOKEN}` },
  })
  if (!res.ok) throw new Error(`ERP fetch ${endpoint} failed: ${res.status}`)
  return res.json()
}

// ── Seasonal detection ────────────────────────────────────────────────────────

function getSeasonalTags(dateStr) {
  const month = new Date(dateStr).getMonth() + 1 // 1-12
  const tags = []

  // Eid ul-Fitr: approx Shawwal (varies by year, using heuristic month ranges)
  // Eid ul-Adha: approx Dhul Hijja
  // Seasonal: winter (Nov-Feb), summer (Mar-Jun), monsoon (Jul-Oct)
  if (month >= 11 || month <= 2)  tags.push('winter')
  if (month >= 3  && month <= 6)  tags.push('summer')
  if (month >= 7  && month <= 10) tags.push('monsoon')
  if (month >= 3  && month <= 5)  tags.push('eid_season')  // Eid Fitr window
  if (month >= 5  && month <= 7)  tags.push('eid_adha_season')

  return tags
}

/**
 * Scores a product for promotion priority.
 *
 * @param {object} product
 * @param {number} product.sales30d     — units sold in last 30 days
 * @param {number} product.sales90d     — units sold in last 90 days
 * @param {number} product.stock        — current stock units
 * @param {Date|null} product.lastPromotedAt — last promotion date
 * @param {string[]} product.tags       — product tags (e.g. 'panjabi', 'family')
 * @returns {{ score: number, reasons: string[], taskType: string }}
 */
export function scoreProduct(product, today = new Date()) {
  const { sales30d = 0, sales90d = 0, stock = 0, lastPromotedAt, tags = [] } = product
  const daysSincePromo = lastPromotedAt
    ? Math.floor((today - new Date(lastPromotedAt)) / 86400000)
    : 999

  const reasons = []
  let score = 0

  // ── Base tier ─────────────────────────────────────────────────────────────

  const avgWeeklySales = (sales30d / 4) || 0
  let baseTier = 'slow'
  if (avgWeeklySales >= 10) {
    baseTier = 'bestseller'
    score += 100
    reasons.push('বেস্টসেলার (>10 units/week)')
  } else if (avgWeeklySales >= 3) {
    baseTier = 'medium'
    score += 60
    reasons.push(`মাঝারি বিক্রি (${avgWeeklySales.toFixed(1)} units/week)`)
  } else {
    score += 20
    reasons.push('স্লো মুভার — guaranteed promotion')
  }

  // ── Recency bump (not promoted in a long time) ────────────────────────────

  if (daysSincePromo >= 60) {
    score += 40
    reasons.push(`${daysSincePromo} দিন ধরে প্রমোশন হয়নি`)
  } else if (daysSincePromo >= 30) {
    score += 25
    reasons.push(`${daysSincePromo} দিন প্রমোশন নেই`)
  } else if (daysSincePromo < 2) {
    score -= 30
    reasons.push('সম্প্রতি প্রমোট হয়েছে')
  }

  // ── Stock pressure: high stock × low sales ────────────────────────────────

  if (stock > 20 && sales30d < 5) {
    const pressure = Math.min(40, Math.floor(stock / 5))
    score += pressure
    reasons.push(`স্টক প্রেশার: ${stock} স্টক, মাত্র ${sales30d} বিক্রি`)
  } else if (stock === 0) {
    score -= 50
    reasons.push('স্টক শেষ')
  }

  // ── Seasonal modifier ─────────────────────────────────────────────────────

  const seasonal = getSeasonalTags(today.toISOString())
  const hasSeasonalMatch = tags.some(t =>
    seasonal.includes(t) ||
    (seasonal.includes('eid_season') && ['panjabi', 'family', 'kids'].includes(t)) ||
    (seasonal.includes('winter') && ['hoodie', 'jacket', 'sweater'].includes(t))
  )
  if (hasSeasonalMatch) {
    score += 30
    reasons.push('সিজনাল পণ্য (মৌসুমী চাহিদা)')
  }

  // ── Task type mapping ──────────────────────────────────────────────────────

  let taskType = 'product_content'
  if (baseTier === 'bestseller') taskType = 'ad_creative'
  else if (sales30d === 0 && stock > 0) taskType = 'listing_update'

  return { score, reasons, taskType }
}

/**
 * Given a list of products with sales/stock/history data, pick today's 2-4 picks.
 * Ensures "slow movers" are included if not promoted in 30+ days.
 *
 * @param {Array} products
 * @returns {Array} picks — sorted by score desc, 2-4 items
 */
export function pickDailyRotation(products, today = new Date()) {
  if (!products?.length) return []

  const scored = products.map(p => ({
    ...p,
    ...scoreProduct(p, today),
  }))

  // Sort by score desc
  scored.sort((a, b) => b.score - a.score)

  // Ensure at least 1 slow mover (stock > 0, not promoted in 30+ days) in the picks
  const hasSlowMover = scored.slice(0, 4).some(p => {
    const daysOld = p.lastPromotedAt
      ? Math.floor((today - new Date(p.lastPromotedAt)) / 86400000) : 999
    return daysOld >= 30
  })

  let picks = scored.slice(0, 4)

  if (!hasSlowMover) {
    const slowMover = scored.find(p => {
      const daysOld = p.lastPromotedAt
        ? Math.floor((today - new Date(p.lastPromotedAt)) / 86400000) : 999
      return daysOld >= 30 && (p.stock ?? 0) > 0
    })
    if (slowMover) {
      picks = [...picks.slice(0, 3), slowMover]
    }
  }

  // Filter out zero-stock products unless no alternatives
  const inStockPicks = picks.filter(p => (p.stock ?? 0) > 0)
  return inStockPicks.length >= 2 ? inStockPicks.slice(0, 4) : picks.slice(0, 4)
}

/**
 * Fetches ERP product data and runs the rotation engine.
 * Returns { picks, allProducts } for use in morning proposal.
 */
export async function getRotationPicks(supabase) {
  try {
    // Fetch product marketing history from DB to get lastPromotedAt
    const { data: historyRows } = await supabase
      .from('product_marketing_history')
      .select('product_ref, business, last_promoted_at')
      .order('last_promoted_at', { ascending: false })

    const historyMap = {}
    for (const row of historyRows ?? []) {
      const key = `${row.business}:${row.product_ref}`
      if (!historyMap[key]) historyMap[key] = row.last_promoted_at
    }

    // Fetch sales data from ERP API
    let erpProducts = []
    try {
      const salesData = await fetchFromAgent('/api/erp/products/summary')
      erpProducts = salesData?.products ?? []
    } catch {
      console.warn('[rotation] ERP product fetch failed — using history only')
    }

    // Build product list with scoring data
    const products = erpProducts.map(p => ({
      productRef:    p.id || p.sku || p.name,
      business:      p.business || 'ALMA Lifestyle',
      name:          p.name || p.title,
      sales30d:      p.sales30d ?? 0,
      sales90d:      p.sales90d ?? 0,
      stock:         p.stock ?? 0,
      tags:          p.tags ?? [],
      lastPromotedAt: historyMap[`${p.business}:${p.id}`] ?? null,
    }))

    const picks = pickDailyRotation(products)
    return { picks, allProducts: products }
  } catch (err) {
    console.error('[rotation] getRotationPicks error:', err.message)
    return { picks: [], allProducts: [] }
  }
}
