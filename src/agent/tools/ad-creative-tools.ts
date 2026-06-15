import { loadProductAsset } from '@/lib/content-engine/pipeline'
import { resolveTheme } from '@/lib/content-engine/theme'
import {
  createAdCreativeGate,
  type AdCreativeGatePayload,
} from '@/lib/content-engine/ad-creative-gate'
import {
  formatDiscountBn,
  formatPriceBn,
  type AdAspect,
  type AdCreativeSpec,
  type AdTemplate,
} from '@/lib/content-engine/ad-creative'
import {
  generateAdCopySet,
  type AdOfferContext,
} from '@/lib/content-engine/caption'
import type { BrandTheme } from '@/lib/content-engine/brand-identity'
import { roundMoney } from '@/lib/money'
import type { AgentTool } from './registry'

const AD_TEMPLATES = new Set<AdTemplate>([
  'offer_band',
  'price_drop',
  'festival_hero',
  'new_arrival',
  'free_delivery',
])

const AD_ASPECTS = new Set<AdAspect>(['1:1', '4:5', '9:16'])

const BRAND_THEMES = new Set<BrandTheme>(['default', 'eid', 'puja', 'boishakh', 'winter'])

function parseOffer(raw: unknown): AdOfferContext {
  const offer = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  let priceBdt = offer.priceBdt != null ? roundMoney(Number(offer.priceBdt)) : undefined
  let strikePriceBdt = offer.strikePriceBdt != null ? roundMoney(Number(offer.strikePriceBdt)) : undefined
  const discountPercent = offer.discountPercent != null ? roundMoney(Number(offer.discountPercent)) : undefined

  if (discountPercent && strikePriceBdt && !priceBdt) {
    priceBdt = roundMoney(strikePriceBdt * (1 - discountPercent / 100))
  } else if (discountPercent && priceBdt && !strikePriceBdt) {
    strikePriceBdt = roundMoney(priceBdt / (1 - discountPercent / 100))
  }

  return {
    priceBdt: priceBdt || undefined,
    strikePriceBdt: strikePriceBdt || undefined,
    discountPercent: discountPercent || undefined,
    headlineBn: offer.headlineBn ? String(offer.headlineBn).trim() : undefined,
    urgencyBn: offer.urgencyBn ? String(offer.urgencyBn).trim() : undefined,
  }
}

const make_ad_creatives: AgentTool = {
  name: 'make_ad_creatives',
  description:
    'Generate on-brand promotional ad creatives (offer posters, festival ads) with exact Bangla prices via SVG overlay. ' +
    'Produces multiple ad-copy angles per product for Meta creative testing. Creates a PENDING ACTION — owner must approve; nothing posts automatically. ' +
    'Uses product flat photo as base visual. Prices/discounts are stamped exactly (never from the image model).',
  input_schema: {
    type: 'object' as const,
    properties: {
      productCode: { type: 'string', description: 'Product SKU in content library, e.g. FM-1234' },
      template: {
        type: 'string',
        enum: ['offer_band', 'price_drop', 'festival_hero', 'new_arrival', 'free_delivery'],
        description: 'Layout template (default festival_hero for eid/puja themes, else offer_band)',
      },
      theme: {
        type: 'string',
        enum: ['default', 'eid', 'puja', 'boishakh', 'winter'],
        description: 'Brand accent theme (default: auto from marketing calendar)',
      },
      offer: {
        type: 'object',
        properties: {
          priceBdt: { type: 'number', description: 'Sale price in whole taka' },
          strikePriceBdt: { type: 'number', description: 'Original price (struck through)' },
          discountPercent: { type: 'number', description: 'Discount % e.g. 30' },
          headlineBn: { type: 'string', description: 'Offer headline e.g. ঈদ স্পেশাল অফার' },
          urgencyBn: { type: 'string', description: 'Urgency line e.g. সীমিত সময়ের অফার' },
        },
      },
      angles: { type: 'number', description: 'Number of distinct ad-copy angles (1-5, default 4)' },
      aspects: {
        type: 'array',
        items: { type: 'string', enum: ['1:1', '4:5', '9:16'] },
        description: 'Output aspect ratios (default ["4:5","1:1"])',
      },
      conversationId: { type: 'string' },
    },
    required: ['productCode'],
  },
  handler: async (input) => {
    try {
      const productCode = String(input.productCode ?? '').trim()
      if (!productCode) {
        return { success: false, error: 'productCode লাগবে।' }
      }

      const product = await loadProductAsset(productCode)
      if (!product?.imagePath) {
        return {
          success: false,
          error: `${productCode} কন্টেন্ট লাইব্রেরিতে নেই — আগে add_product_asset দিয়ে যোগ করুন।`,
        }
      }

      const resolved = await resolveTheme()
      const themeInput = input.theme ? String(input.theme) : null
      const theme: BrandTheme = themeInput && BRAND_THEMES.has(themeInput as BrandTheme)
        ? (themeInput as BrandTheme)
        : resolved.theme

      const templateInput = input.template ? String(input.template) : null
      const template: AdTemplate = templateInput && AD_TEMPLATES.has(templateInput as AdTemplate)
        ? (templateInput as AdTemplate)
        : (theme === 'eid' || theme === 'puja' ? 'festival_hero' : 'offer_band')

      const angleCount = Math.min(Math.max(Number(input.angles ?? 4), 1), 5)
      const aspectsRaw = Array.isArray(input.aspects)
        ? (input.aspects as string[]).filter((a) => AD_ASPECTS.has(a as AdAspect))
        : ['4:5', '1:1']
      const aspects: AdAspect[] = aspectsRaw.length ? (aspectsRaw as AdAspect[]) : ['4:5']

      const offerCtx = parseOffer(input.offer)
      if (!offerCtx.urgencyBn && (theme === 'eid' || template === 'festival_hero')) {
        offerCtx.urgencyBn = 'সীমিত সময়ের অফার'
      }
      if (!offerCtx.headlineBn && theme === 'eid') {
        offerCtx.headlineBn = 'ঈদ স্পেশাল অফার'
      }

      const copies = await generateAdCopySet(product, {
        theme,
        count: angleCount,
        offer: offerCtx,
      })

      const priceText = offerCtx.priceBdt ? formatPriceBn(offerCtx.priceBdt) : undefined
      const strikePriceText = offerCtx.strikePriceBdt ? formatPriceBn(offerCtx.strikePriceBdt) : undefined
      const discountText = offerCtx.discountPercent ? formatDiscountBn(offerCtx.discountPercent) : undefined

      const specs: Array<{ spec: AdCreativeSpec; copy: typeof copies[number]; aspect: AdAspect }> = []
      for (const copy of copies) {
        for (const aspect of aspects) {
          specs.push({
            aspect,
            copy,
            spec: {
              template,
              theme,
              headlineBn: copy.hookBn || offerCtx.headlineBn || 'বিশেষ অফার',
              subBn: product.name ?? product.productCode,
              priceText,
              strikePriceText,
              discountText,
              ctaBn: copy.ctaBn,
              urgencyBn: offerCtx.urgencyBn,
              aspect,
            },
          })
        }
      }

      const { gateId, creatives, summary } = await createAdCreativeGate({
        productCode: product.productCode,
        template,
        theme,
        baseImagePath: product.imagePath,
        specs,
        conversationId: input.conversationId ? String(input.conversationId) : null,
      })

      return {
        success: true,
        data: {
          pendingActionId: gateId,
          summary,
          actionType: 'ad_creative_gate',
          creativeCount: creatives.length,
          angles: copies.map((c) => ({ angle: c.angle, hookBn: c.hookBn, primaryTextBn: c.primaryTextBn })),
          costEstimate: creatives.length * 0.15,
          message:
            `${product.productCode}-এর জন্য ${creatives.length}টি ad creative তৈরি হয়েছে (${copies.length} angle × ${aspects.length} aspect). ` +
            'Owner approval card — approve করলে ready for Ads; কিছু auto-post হবে না।',
        },
      }
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) }
    }
  },
}

export const AD_CREATIVE_TOOLS: AgentTool[] = [make_ad_creatives]

export type { AdCreativeGatePayload }

export const AD_CREATIVE_ROLE_PROMPT = `
## AD CREATIVE ENGINE
make_ad_creatives: offer posters / festival ads with exact ৳price + % ছাড় via SVG overlay (never from image model). Multiple psychological ad-copy angles per product for Meta creative volume testing. Owner approval required — nothing posts automatically. Product must be in content library (add_product_asset).
`
