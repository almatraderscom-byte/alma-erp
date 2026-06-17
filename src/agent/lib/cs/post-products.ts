import { prisma } from '@/lib/prisma'
import { DEFAULT_CATALOG_BUSINESS, normalizeProductCode } from '@/agent/lib/catalog/inventory-lookup'
import { searchVisualIndexFromImage } from '@/agent/lib/cs/product-index'
import { notifyOwner } from '@/agent/lib/notify-owner'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = prisma as any

export function parseFbPostId(input: string, defaultPageId?: string): { postId: string; pageId: string } | null {
  const raw = input.trim()
  if (!raw) return null

  const urlMatch = raw.match(/facebook\.com\/(?:[^/]+\/)?posts\/(\d+)/i)
    ?? raw.match(/facebook\.com\/photo\.php\?fbid=(\d+)/i)
    ?? raw.match(/fbid=(\d+)/i)

  if (urlMatch) {
    const id = urlMatch[1]
    return { postId: defaultPageId ? `${defaultPageId}_${id}` : id, pageId: defaultPageId ?? '' }
  }

  if (raw.includes('_')) {
    const [pageId, rest] = raw.split('_')
    return { postId: raw, pageId }
  }

  if (/^\d+$/.test(raw) && defaultPageId) {
    return { postId: `${defaultPageId}_${raw}`, pageId: defaultPageId }
  }

  return null
}

export async function linkPostProducts(input: {
  postId: string
  pageId: string
  productCodes: string[]
  business?: string
}): Promise<{ postId: string; codes: string[] }> {
  const codes = input.productCodes.map((c) => normalizeProductCode(c)).filter(Boolean)
  const business = input.business ?? DEFAULT_CATALOG_BUSINESS

  await db.csPostProduct.upsert({
    where: { postId_pageId: { postId: input.postId, pageId: input.pageId } },
    create: {
      postId: input.postId,
      pageId: input.pageId,
      productCodes: codes,
      business,
    },
    update: { productCodes: codes, business },
  })

  return { postId: input.postId, codes }
}

export async function getPostProductCodes(postId: string, pageId: string): Promise<string[]> {
  const row = await db.csPostProduct.findUnique({
    where: { postId_pageId: { postId, pageId } },
  })
  if (!row) return []
  const codes = row.productCodes
  return Array.isArray(codes) ? codes.map(String) : []
}

function isTrustedImageHost(url: string): boolean {
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'https:') return false
    return parsed.hostname.endsWith('.fbcdn.net')
      || parsed.hostname.endsWith('.supabase.co')
      || parsed.hostname.endsWith('.cdninstagram.com')
      || parsed.hostname === 'scontent.xx.fbcdn.net'
      || parsed.hostname === 'lookaside.fbsbx.com'
      || parsed.hostname === 'platform-lookaside.fbsbx.com'
  } catch {
    return false
  }
}

export async function suggestPostProductsFromImage(input: {
  postId: string
  pageId: string
  imageUrl: string
}): Promise<void> {
  try {
    if (!isTrustedImageHost(input.imageUrl)) {
      console.warn('[post-products] rejected untrusted image URL:', input.imageUrl.slice(0, 120))
      return
    }
    const res = await fetch(input.imageUrl, { signal: AbortSignal.timeout(15_000) })
    if (!res.ok) return
    const buf = Buffer.from(await res.arrayBuffer())
    if (buf.length > 10 * 1024 * 1024) return
    const b64 = buf.toString('base64')
    const mime = res.headers.get('content-type') ?? 'image/jpeg'
    const hits = await searchVisualIndexFromImage(b64, mime, 3)
    if (!hits.length) return

    const codes = hits.map((h) => h.productCode).join(', ')
    const token = process.env.ASSISTANT_BOT_TOKEN
    const ownerId = process.env.TELEGRAM_OWNER_CHAT_ID
    if (!token || !ownerId) {
      await notifyOwner({
        tier: 1,
        title: '📎 Post Product Suggest',
        message: `Post ${input.postId}\nসাজেস্ট: ${codes}\n/postlink ${input.postId} ${hits[0].productCode}`,
        category: 'task',
      })
      return
    }

    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: ownerId,
        text: `📎 নতুন পোস্ট — প্রোডাক্ট সাজেস্ট\nPost: ${input.postId}\n${codes}`,
        reply_markup: {
          inline_keyboard: [[
            { text: `✅ ${hits[0].productCode}`, callback_data: `postlink_ok:${input.pageId}:${input.postId}:${hits[0].productCode}` },
            { text: '❌ Skip', callback_data: `postlink_skip:${input.postId}` },
          ]],
        },
      }),
      signal: AbortSignal.timeout(10_000),
    }).catch((err) => {
      console.warn('[post-products] telegram suggest send failed:', err.message)
    })
  } catch (err) {
    console.warn('[post-products] suggestPostProducts failed:', err instanceof Error ? err.message : err)
  }
}
