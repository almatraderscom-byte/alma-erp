import { agentSmartText } from '@/agent/lib/llm-text'
import { upcomingSeasons } from '@/lib/marketing-calendar'
import { buildMarketingIntel } from '@/lib/content-intelligence'
import type { ProductAsset } from '@/lib/content-engine/generate-variants'
import type { BrandTheme } from '@/lib/content-engine/brand-identity'

export type CaptionResult = {
  hook: string
  caption: string
  footer: string
}

export async function generateCaption(
  product: ProductAsset,
  opts?: { theme?: BrandTheme; hook?: string; page?: string },
): Promise<CaptionResult> {
  const seasons = await upcomingSeasons()
  const activeSeason = seasons.find((s) => s.inLeadWindow)
  const intel = await buildMarketingIntel(product.category ?? undefined).catch(() => null)
  const learned = intel?.bestApproaches?.[0]?.approach ?? null

  // Anthropic-or-Gemini (owner: Gemini replaces Sonnet for now).
  const raw = await agentSmartText({
    system:
      'You write Bangla Facebook captions for ALMA Lifestyle (family fashion, Bangladesh). ' +
      'Warm, modern, trustworthy. Output ONLY valid JSON: {"hook":"...","caption":"...","footer":"..."}. ' +
      'hook = short punchy Bangla headline (festival-aware if relevant). ' +
      'caption = 3-6 lines product highlights (fabric, family-matching, style). No emoji spam. ' +
      'footer = order CTA (inbox message, delivery note) — plain text.',
    prompt: JSON.stringify({
      productCode: product.productCode,
      name: product.name,
      category: product.category,
      fabric: product.fabric,
      familyMatch: product.familyMatch,
      theme: opts?.theme ?? 'default',
      suggestedHook: opts?.hook,
      activeSeason: activeSeason?.name ?? null,
      learnedApproach: learned,
      page: opts?.page ?? 'lifestyle',
    }),
    maxTokens: 300,
    costLabel: 'caption_generate',
  })
  try {
    const parsed = JSON.parse(raw) as { hook?: string; caption?: string; footer?: string }
    const hook = String(parsed.hook ?? opts?.hook ?? 'নতুন কালেকশন').trim()
    const caption = String(parsed.caption ?? '').trim()
    const footer = String(parsed.footer ?? 'অর্ডার করতে পেজে ইনবক্সে মেসেজ করুন।').trim()
    return {
      hook,
      caption: [caption, footer].filter(Boolean).join('\n\n'),
      footer,
    }
  } catch (err) {
    console.warn('[caption] generateCaption failed:', err instanceof Error ? err.message : err)
    return {
      hook: opts?.hook ?? 'নতুন কালেকশন',
      caption: raw || `${product.name ?? product.productCode} — Alma Lifestyle`,
      footer: 'অর্ডার করতে পেজে ইনবক্সে মেসেজ করুন।',
    }
  }
}

export type AdCopyAngle = {
  angle: string
  hookBn: string
  primaryTextBn: string
  ctaBn: string
}

export type AdOfferContext = {
  priceBdt?: number
  strikePriceBdt?: number
  discountPercent?: number
  headlineBn?: string
  urgencyBn?: string
}

const AD_ANGLES = [
  'value/price',
  'emotional family',
  'quality/fabric',
  'urgency/scarcity',
  'social-proof',
] as const

export async function generateAdCopySet(
  product: ProductAsset,
  opts?: { theme?: BrandTheme; count?: number; offer?: AdOfferContext },
): Promise<AdCopyAngle[]> {
  const count = Math.min(Math.max(opts?.count ?? 4, 1), 5)
  const seasons = await upcomingSeasons()
  const activeSeason = seasons.find((s) => s.inLeadWindow)
  const intel = await buildMarketingIntel(product.category ?? undefined).catch(() => null)

  // Anthropic-or-Gemini (owner: Gemini replaces Sonnet for now).
  const raw = await agentSmartText({
    system:
      'You write Bangla Meta ad copy angles for ALMA Lifestyle (Bangladesh family fashion). ' +
      'Each angle must use a DIFFERENT psychological hook — not mere rephrasing. ' +
      'Output ONLY a JSON array: [{"angle":"value/price","hookBn":"...","primaryTextBn":"...","ctaBn":"..."}, ...]. ' +
      'hookBn = short headline for the visual overlay. primaryTextBn = 2-3 lines ad primary text. ctaBn = inbox order CTA. ' +
      'Warm, trustworthy, no emoji spam. Use exact offer numbers when provided.',
    prompt: JSON.stringify({
      productCode: product.productCode,
      name: product.name,
      category: product.category,
      fabric: product.fabric,
      familyMatch: product.familyMatch,
      theme: opts?.theme ?? 'default',
      offer: opts?.offer ?? null,
      activeSeason: activeSeason?.name ?? null,
      learnedApproach: intel?.bestApproaches?.[0]?.approach ?? null,
      requestedAngles: AD_ANGLES.slice(0, count),
      count,
    }),
    maxTokens: 1200,
    costLabel: 'ad_copy_set',
  })
  try {
    const match = raw.match(/\[[\s\S]*\]/)
    const parsed = JSON.parse(match?.[0] ?? '[]') as AdCopyAngle[]
    if (!Array.isArray(parsed) || parsed.length === 0) throw new Error('empty')
    return parsed.slice(0, count).map((row, i) => ({
      angle: String(row.angle ?? AD_ANGLES[i] ?? `angle-${i + 1}`),
      hookBn: String(row.hookBn ?? opts?.offer?.headlineBn ?? 'বিশেষ অফার').trim(),
      primaryTextBn: String(row.primaryTextBn ?? '').trim(),
      ctaBn: String(row.ctaBn ?? 'অর্ডার করতে ইনবক্সে মেসেজ করুন').trim(),
    }))
  } catch (err) {
    console.warn('[caption] generateAdCopyAngles failed:', err instanceof Error ? err.message : err)
    const fallback: AdCopyAngle[] = []
    for (let i = 0; i < count; i++) {
      fallback.push({
        angle: AD_ANGLES[i] ?? `angle-${i + 1}`,
        hookBn: opts?.offer?.headlineBn ?? (i === 0 ? 'বিশেষ অফার' : 'ALMA Lifestyle'),
        primaryTextBn: `${product.name ?? product.productCode} — ${product.fabric ?? 'প্রিমিয়াম কাপড়'}`,
        ctaBn: 'অর্ডার করতে ইনবক্সে মেসেজ করুন',
      })
    }
    return fallback
  }
}
