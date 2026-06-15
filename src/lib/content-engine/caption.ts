import Anthropic from '@anthropic-ai/sdk'
import { AGENT_MODEL } from '@/agent/config'
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

  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY ?? '' })
  const res = await client.messages.create({
    model: AGENT_MODEL || 'claude-sonnet-4-6',
    max_tokens: 300,
    system:
      'You write Bangla Facebook captions for ALMA Lifestyle (family fashion, Bangladesh). ' +
      'Warm, modern, trustworthy. Output ONLY valid JSON: {"hook":"...","caption":"...","footer":"..."}. ' +
      'hook = short punchy Bangla headline (festival-aware if relevant). ' +
      'caption = 3-6 lines product highlights (fabric, family-matching, style). No emoji spam. ' +
      'footer = order CTA (inbox message, delivery note) — plain text.',
    messages: [{
      role: 'user',
      content: JSON.stringify({
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
    }],
  })

  const block = res.content.find((b) => b.type === 'text')
  const raw = block && block.type === 'text' ? block.text.trim() : ''
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
  } catch {
    return {
      hook: opts?.hook ?? 'নতুন কালেকশন',
      caption: raw || `${product.name ?? product.productCode} — Alma Lifestyle`,
      footer: 'অর্ডার করতে পেজে ইনবক্সে মেসেজ করুন।',
    }
  }
}
