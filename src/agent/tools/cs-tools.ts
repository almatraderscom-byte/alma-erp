/**
 * CS-1 — Customer-safe tools only. Never import owner/finance/salah tools here.
 */
import Anthropic from '@anthropic-ai/sdk'
import { prisma } from '@/lib/prisma'
import { AGENT_MODEL } from '@/agent/config'
import { roundMoney } from '@/lib/money'
import { notifyOwner } from '@/agent/lib/notify-owner'
import { recordCsEvent } from '@/agent/lib/cs/analytics'
import { getCustomerOrderStatus } from '@/agent/lib/cs/order-lifecycle'
import { agentStorageDownload } from '@/agent/lib/storage'
import { describeProductImage } from '@/agent/lib/cs/gemini-vision'
import { searchVisualIndex } from '@/agent/lib/cs/product-index'
import { getPrimaryImageUrl } from '@/agent/lib/catalog/product-images'
import {
  buildCollectionProfile,
  expandSkuToCollectionIfFamily,
} from '@/agent/lib/catalog/collection-profile'
import {
  DEFAULT_CATALOG_BUSINESS,
  findCollectionFamilyMembers,
  loadCatalogStock,
  loadVariantsForCode,
  normalizeProductCode,
  resolveProductCode,
  resolveProductInput,
  formatCollectionMemberLabel,
} from '@/agent/lib/catalog/inventory-lookup'
import type { AgentTool } from './registry'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = prisma as any

function formatPrice(taka: number): string {
  return `৳${roundMoney(taka).toLocaleString('bn-BD')}`
}

async function loadImageBytes(imageRef: string): Promise<{ b64: string; mime: string }> {
  const ref = imageRef.trim()
  if (ref.startsWith('http')) {
    const res = await fetch(ref, { signal: AbortSignal.timeout(15_000) })
    if (!res.ok) throw new Error('image fetch failed')
    const mime = res.headers.get('content-type') ?? 'image/jpeg'
    const b64 = Buffer.from(await res.arrayBuffer()).toString('base64')
    return { b64, mime }
  }
  const buffer = await agentStorageDownload(ref)
  return { b64: buffer.toString('base64'), mime: 'image/jpeg' }
}

async function visionPickProduct(
  customerB64: string,
  customerMime: string,
  candidates: Array<{ productCode: string; imageUrl: string | null; score: number }>,
): Promise<{ code: string | null; confidence: 'high' | 'medium' | 'low' }> {
  if (!candidates.length) return { code: null, confidence: 'low' }
  if (candidates.length === 1 && candidates[0].score >= 0.82) {
    return { code: candidates[0].productCode, confidence: 'high' }
  }

  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY ?? '' })
  const candidateBlocks: Anthropic.Messages.ContentBlockParam[] = []
  for (const c of candidates.slice(0, 3)) {
    if (!c.imageUrl) continue
    try {
      const res = await fetch(c.imageUrl, { signal: AbortSignal.timeout(10_000) })
      if (!res.ok) continue
      const mime = res.headers.get('content-type') ?? 'image/jpeg'
      const b64 = Buffer.from(await res.arrayBuffer()).toString('base64')
      candidateBlocks.push({
        type: 'text',
        text: `Candidate ${c.productCode} (score ${c.score.toFixed(2)}):`,
      })
      candidateBlocks.push({
        type: 'image',
        source: { type: 'base64', media_type: mime as 'image/jpeg', data: b64 },
      })
    } catch (err) {
      console.warn('[cs-tools] candidate image fetch failed:', c.productCode, err instanceof Error ? err.message : err)
    }
  }

  const res = await client.messages.create({
    model: AGENT_MODEL,
    max_tokens: 256,
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: 'Customer sent this product image. Pick the best matching catalog candidate code, or NONE. Reply JSON: {"code":"SKU or NONE","confidence":"high|medium|low"}' },
        { type: 'image', source: { type: 'base64', media_type: customerMime as 'image/jpeg', data: customerB64 } },
        ...candidateBlocks,
      ],
    }],
  })

  const textBlock = res.content.find((b) => b.type === 'text')
  const text = textBlock && textBlock.type === 'text' ? textBlock.text : '{}'
  const json = JSON.parse(text.match(/\{[\s\S]*\}/)?.[0] ?? '{}') as { code?: string; confidence?: string }
  const code = json.code && json.code !== 'NONE' ? normalizeProductCode(json.code) : null
  const conf = json.confidence === 'high' || json.confidence === 'medium' ? json.confidence : 'low'
  return { code, confidence: conf }
}

const match_product_by_image: AgentTool = {
  name: 'match_product_by_image',
  description:
    'Match a customer-sent image to catalog products. Returns confidence, product code, price, stock, imageUrl. Never ask customer for product code.',
  input_schema: {
    type: 'object' as const,
    properties: {
      imageRef: { type: 'string', description: 'Storage path or URL of customer image' },
      csConversationId: { type: 'string' },
    },
    required: ['imageRef'],
  },
  handler: async (input) => {
    try {
      const { b64, mime } = await loadImageBytes(String(input.imageRef))
      const vision = await describeProductImage(b64, mime)
      const candidates = await searchVisualIndex(vision.combinedText, 5)
      const pick = await visionPickProduct(
        b64,
        mime,
        candidates.map((c) => ({ productCode: c.productCode, imageUrl: c.imageUrl, score: c.score })),
      )

      const csConversationId = input.csConversationId ? String(input.csConversationId) : null

      if (!pick.code) {
        if (csConversationId) {
          const conv = await db.csConversation.findUnique({ where: { id: csConversationId } })
          const count = (conv?.failedMatchCount ?? 0) + 1
          await db.csConversation.update({
            where: { id: csConversationId },
            data: { failedMatchCount: count },
          })
          if (count >= 2) {
            return {
              success: true,
              data: {
                matched: false,
                confidence: 'low',
                failedCount: count,
                message: 'Two failed matches — handoff recommended.',
              },
            }
          }
        }
        return {
          success: true,
          data: {
            matched: false,
            confidence: 'low',
            candidates: candidates.slice(0, 2).map((c) => ({
              code: c.productCode,
              score: c.score,
              imageUrl: c.imageUrl,
            })),
          },
        }
      }

      const resolved = await resolveProductCode(pick.code)
      if (!resolved.ok) {
        return { success: true, data: { matched: false, confidence: 'low' } }
      }

      const stockRows = await loadCatalogStock()
      const family = expandSkuToCollectionIfFamily(
        resolved.code,
        resolved.row,
        stockRows,
        findCollectionFamilyMembers,
      )

      if (csConversationId) {
        await db.csConversation.update({
          where: { id: csConversationId },
          data: { failedMatchCount: 0 },
        })
      }

      if (family) {
        const profile = buildCollectionProfile(family.collectionCode, family.members)
        const imageUrl = await getPrimaryImageUrl(family.members[0]?.sku ?? resolved.code)
        return {
          success: true,
          data: {
            matched: true,
            confidence: pick.confidence,
            kind: 'collection',
            collectionCode: profile.collectionCode,
            collectionProfile: profile.kind,
            collectionProfileLabel: profile.kindLabelBn,
            members: profile.members.map((m) => ({
              code: m.code,
              role: m.role,
              roleLabelBn: m.roleLabelBn,
              price: formatPrice(m.price),
              priceRaw: m.price,
              stock: m.stock,
            })),
            totalPrice: formatPrice(profile.totalPrice),
            totalPriceRaw: profile.totalPrice,
            quoteHint: profile.quoteHintBn,
            imageUrl,
          },
        }
      }

      const imageUrl = await getPrimaryImageUrl(resolved.code)
      const variants = await loadVariantsForCode(resolved.code)
      const totalStock = variants.reduce((s, v) => s + v.currentStock, 0)

      return {
        success: true,
        data: {
          matched: true,
          confidence: pick.confidence,
          kind: 'sku',
          code: resolved.code,
          name: resolved.row.name,
          price: formatPrice(resolved.row.sellPrice),
          priceRaw: resolved.row.sellPrice,
          stock: totalStock,
          imageUrl,
          variants: variants.map((v) => ({ size: v.sizeValue || v.size, stock: v.currentStock })),
        },
      }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  },
}

const search_products: AgentTool = {
  name: 'search_products',
  description: 'Text search products by name/keywords. Returns code, name, price, stock, imageUrl.',
  input_schema: {
    type: 'object' as const,
    properties: {
      query: { type: 'string' },
      limit: { type: 'number' },
    },
    required: ['query'],
  },
  handler: async (input) => {
    const q = String(input.query ?? '').toLowerCase().trim()
    const limit = Math.min(Number(input.limit ?? 8), 15)
    if (!q) return { success: false, error: 'query required' }

    const rows = await loadCatalogStock()
    const hits = rows
      .filter((r) => r.name.toLowerCase().includes(q) || r.sku.toLowerCase().includes(q) || r.category.toLowerCase().includes(q))
      .slice(0, limit)

    const results = await Promise.all(hits.map(async (r) => ({
      code: r.sku,
      name: r.name,
      price: formatPrice(r.sellPrice),
      stock: r.currentStock,
      imageUrl: await getPrimaryImageUrl(r.sku),
    })))

    return { success: true, data: { products: results } }
  },
}

const get_product_details: AgentTool = {
  name: 'get_product_details',
  description: 'Get price, sizes/variants, stock, short description for a product code.',
  input_schema: {
    type: 'object' as const,
    properties: { code: { type: 'string' } },
    required: ['code'],
  },
  handler: async (input) => {
    const resolved = await resolveProductInput(String(input.code ?? ''))
    if (resolved.kind === 'not_found') {
      return { success: false, error: 'product not found', data: { suggestions: resolved.suggestions } }
    }

    if (resolved.kind === 'collection') {
      const profile = buildCollectionProfile(resolved.collectionCode, resolved.members)
      const members = await Promise.all(profile.members.map(async (m) => {
        const row = resolved.members.find((r) => r.sku === m.code) ?? resolved.members[0]
        return {
          code: m.code,
          name: row?.name ?? m.code,
          role: m.role,
          roleLabelBn: m.roleLabelBn,
          type: row?.collectionType || row?.genderType,
          variant: m.variant,
          price: formatPrice(m.price),
          priceRaw: m.price,
          stock: m.stock,
          imageUrl: await getPrimaryImageUrl(m.code),
          label: formatCollectionMemberLabel(row ?? resolved.members[0]),
        }
      }))
      return {
        success: true,
        data: {
          kind: 'collection',
          collectionCode: profile.collectionCode,
          collectionProfile: profile.kind,
          collectionProfileLabel: profile.kindLabelBn,
          memberCount: profile.memberCount,
          members,
          totalPrice: formatPrice(profile.totalPrice),
          totalPriceRaw: profile.totalPrice,
          hint: profile.quoteHintBn,
        },
      }
    }

    const variants = await loadVariantsForCode(resolved.code)
    const imageUrl = await getPrimaryImageUrl(resolved.code)
    return {
      success: true,
      data: {
        kind: 'sku',
        code: resolved.code,
        name: resolved.row.name,
        category: resolved.row.category,
        price: formatPrice(resolved.row.sellPrice),
        stock: variants.reduce((s, v) => s + v.currentStock, 0),
        variants: variants.map((v) => ({ size: v.sizeValue || v.size, stock: v.currentStock })),
        imageUrl,
        description: `${resolved.row.name} — ${resolved.row.category}`,
      },
    }
  },
}

const send_product_image: AgentTool = {
  name: 'send_product_image',
  description: 'Get catalog image URL to attach in customer reply.',
  input_schema: {
    type: 'object' as const,
    properties: { code: { type: 'string' } },
    required: ['code'],
  },
  handler: async (input) => {
    const resolved = await resolveProductCode(String(input.code ?? ''))
    if (!resolved.ok) return { success: false, error: 'product not found' }
    const imageUrl = await getPrimaryImageUrl(resolved.code)
    if (!imageUrl) return { success: false, error: 'no image for product' }
    return { success: true, data: { code: resolved.code, imageUrl } }
  },
}

const create_order_draft: AgentTool = {
  name: 'create_order_draft',
  description:
    'Create a DRAFT order (cs_order_drafts table — does NOT write to ERP orders). Notify owner + Eyafi.',
  input_schema: {
    type: 'object' as const,
    properties: {
      items: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            code: { type: 'string' },
            qty: { type: 'number' },
            variant: { type: 'string' },
          },
        },
      },
      customerName: { type: 'string' },
      phone: { type: 'string' },
      address: { type: 'string' },
      note: { type: 'string' },
      csConversationId: { type: 'string' },
      pageId: { type: 'string' },
      psid: { type: 'string' },
    },
    required: ['items', 'phone'],
  },
  handler: async (input) => {
    try {
      const items = Array.isArray(input.items) ? input.items : []
      if (!items.length) return { success: false, error: 'items required' }
      const csConversationId = input.csConversationId ? String(input.csConversationId) : null
      if (!csConversationId) return { success: false, error: 'csConversationId required' }

      const draft = await db.csOrderDraft.create({
        data: {
          conversationId: csConversationId,
          pageId: String(input.pageId ?? ''),
          psid: String(input.psid ?? ''),
          customerName: input.customerName ? String(input.customerName) : null,
          phone: String(input.phone),
          address: input.address ? String(input.address) : null,
          items,
          note: input.note ? String(input.note) : null,
          status: 'draft',
        },
      })

      const summary = items.map((i: { code?: string; qty?: number; variant?: string }) =>
        `${i.code} x${i.qty}${i.variant ? ` (${i.variant})` : ''}`).join(', ')

      await notifyOwner({
        tier: 1,
        title: '🛒 CS Order Draft',
        message: `নতুন draft অর্ডার\nকাস্টমার: ${input.customerName ?? '—'}\nফোন: ${input.phone}\nআইটেম: ${summary}\nDraft ID: ${draft.id}`,
        category: 'task',
      })

      const ownerId = process.env.TELEGRAM_OWNER_CHAT_ID
      if (ownerId && process.env.ASSISTANT_BOT_TOKEN) {
        await fetch(`https://api.telegram.org/bot${process.env.ASSISTANT_BOT_TOKEN}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: ownerId,
            text: `🛒 CS Order Draft\n${summary}\nফোন: ${input.phone}\nID: ${draft.id}`,
            reply_markup: {
              inline_keyboard: [[
                { text: '✅ Confirm', callback_data: `cs_confirm:${draft.id}` },
              ]],
            },
          }),
          signal: AbortSignal.timeout(10_000),
        }).catch((err) => {
          console.warn('[cs-tools] owner draft notify failed:', err instanceof Error ? err.message : err)
        })
      }

      await recordCsEvent('draft_created', {
        conversationId: csConversationId,
        metadata: { draftId: draft.id },
      })

      const eyafi = await db.agentStaff.findFirst({
        where: { name: { contains: 'Eyafi', mode: 'insensitive' }, active: true },
      })
      if (eyafi?.telegramChatId && process.env.ASSISTANT_BOT_TOKEN) {
        await fetch(`https://api.telegram.org/bot${process.env.ASSISTANT_BOT_TOKEN}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: eyafi.telegramChatId,
            text: `🛒 CS Order Draft\n${summary}\nফোন: ${input.phone}\nID: ${draft.id}`,
          }),
          signal: AbortSignal.timeout(10_000),
        }).catch((err) => {
          console.warn('[cs-tools] eyafi draft notify failed:', err instanceof Error ? err.message : err)
        })
      }

      return {
        success: true,
        data: {
          draftId: draft.id,
          path: 'cs_order_drafts',
          message: 'Draft saved — owner and Eyafi notified. Do not promise delivery date or payment.',
        },
      }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  },
}

const get_customer_order_status: AgentTool = {
  name: 'get_customer_order_status',
  description:
    'Look up this customer CS/ERP order status by psid. Never invent tracking — only real statuses.',
  input_schema: {
    type: 'object' as const,
    properties: {
      psid: { type: 'string' },
      pageId: { type: 'string' },
    },
    required: ['psid'],
  },
  handler: async (input) => {
    try {
      const result = await getCustomerOrderStatus({
        psid: String(input.psid ?? ''),
        pageId: input.pageId ? String(input.pageId) : undefined,
      })
      if (!result.orders.length) {
        return {
          success: true,
          data: {
            found: false,
            message: 'এই কাস্টমারের কোনো অর্ডার পাওয়া যায়নি।',
            unknownExternal: result.unknownExternal,
          },
        }
      }
      return {
        success: true,
        data: {
          found: true,
          orders: result.orders,
          unknownExternal: result.unknownExternal,
          message: 'শুধু উপরের স্ট্যাটাস বলুন — ট্র্যাকিং নম্বর বানাবেন না।',
        },
      }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  },
}

const handoff_to_human: AgentTool = {
  name: 'handoff_to_human',
  description: 'Escalate conversation to human — CS agent goes silent until /cs resume.',
  input_schema: {
    type: 'object' as const,
    properties: {
      reason: { type: 'string' },
      csConversationId: { type: 'string' },
      pageId: { type: 'string' },
      psid: { type: 'string' },
      suggestedReply: { type: 'string' },
    },
    required: ['reason'],
  },
  handler: async (input) => {
    const csConversationId = input.csConversationId ? String(input.csConversationId) : null
    if (csConversationId) {
      await db.csConversation.update({
        where: { id: csConversationId },
        data: { mode: 'human', status: 'human' },
      })
    }

    await notifyOwner({
      tier: 1,
      title: '🙋 CS Handoff',
      message: `কারণ: ${String(input.reason)}\nConv: ${csConversationId ?? '—'}\nপ্রস্তাবিত উত্তর: ${String(input.suggestedReply ?? '—')}`,
      category: 'urgent',
    })

    const eyafi = await db.agentStaff.findFirst({
      where: { name: { contains: 'Eyafi', mode: 'insensitive' }, active: true },
    })
    if (eyafi?.telegramChatId && process.env.ASSISTANT_BOT_TOKEN) {
      await fetch(`https://api.telegram.org/bot${process.env.ASSISTANT_BOT_TOKEN}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: eyafi.telegramChatId,
          text: `🙋 CS Handoff\n${input.reason}\nConv: ${csConversationId}`,
        }),
        signal: AbortSignal.timeout(10_000),
      }).catch((err) => {
        console.warn('[cs-tools] eyafi handoff notify failed:', err instanceof Error ? err.message : err)
      })
    }

    return { success: true, data: { handedOff: true, silentUntilResume: true } }
  },
}

const get_customer_intelligence: AgentTool = {
  name: 'get_customer_intelligence',
  description:
    'Deep customer view: tiers (VIP/regular/occasional/new), churn risk, days since last order, estimated CLV ' +
    '(when order data available), and personalized engagement suggestions. Use for loyalty/retention planning, ' +
    '"VIP ke ke", "ke churn hote pare". Win-back actions are owner-facing (Meta 24h rule — never auto-DM).',
  input_schema: {
    type: 'object' as const,
    properties: {
      filter: {
        type: 'string',
        enum: ['vip', 'high_churn', 'all'],
        description: 'Filter profiles (default all)',
      },
    },
  },
  handler: async (input) => {
    try {
      const { buildCustomerProfiles, filterProfiles } = await import('@/lib/customer-lifetime')
      const filter = input.filter as 'vip' | 'high_churn' | 'all' | undefined
      const profiles = await buildCustomerProfiles()
      const filtered = filterProfiles(profiles, filter ?? 'all')
      const withoutClv = filtered.filter((p) => p.ordersCount >= 2 && !p.estimatedClv).length
      return {
        success: true,
        data: {
          count: filtered.length,
          filter: filter ?? 'all',
          customers: filtered.slice(0, 30).map((p) => ({
            id: p.id,
            name: p.name,
            phone: p.phone,
            ordersCount: p.ordersCount,
            tier: p.tier,
            churnRisk: p.churnRisk,
            daysSinceLast: p.daysSinceLast,
            avgGapDays: p.avgGapDays,
            avgOrderValue: p.avgOrderValue ?? null,
            estimatedClv: p.estimatedClv ?? null,
            engagementSuggestion: p.engagementSuggestion,
            clvNote: p.clvNote ?? null,
          })),
          notes: withoutClv
            ? [`${withoutClv} জনের CLV হিসাব করা যায়নি — per-order amount+date capture করুন।`]
            : [],
        },
      }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  },
}

export const OWNER_CUSTOMER_INTEL_TOOLS: AgentTool[] = [get_customer_intelligence]

export const CS_CUSTOMER_TOOLS: AgentTool[] = [
  match_product_by_image,
  search_products,
  get_product_details,
  send_product_image,
  create_order_draft,
  get_customer_order_status,
  handoff_to_human,
]

export const CS_CUSTOMER_TOOL_NAMES = CS_CUSTOMER_TOOLS.map((t) => t.name) as readonly string[]
