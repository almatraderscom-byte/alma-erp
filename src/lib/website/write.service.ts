import { prisma } from '@/lib/prisma'
import type { Prisma } from '@prisma/client'
import { getWebsiteSupabaseAdmin } from './supabase-client'
import { getWebsiteProduct } from './catalog.service'

export type WebsiteWriteResult = { ok: true; productId: string; slug: string } | { ok: false; error: string }

async function logWebsiteAudit(
  actionType: string,
  resourceId: string,
  payload: Record<string, unknown>,
) {
  await prisma.agentAuditLog.create({
    data: {
      actionType,
      resourceId,
      payload: payload as Prisma.InputJsonValue,
      actor: 'agent_via_sir',
    },
  })
}

export async function publishWebsiteProduct(productId: string): Promise<WebsiteWriteResult> {
  const sb = getWebsiteSupabaseAdmin()
  const now = new Date().toISOString()
  const { data, error } = await sb
    .from('products')
    .update({ published: true, published_at: now, updated_at: now })
    .eq('id', productId)
    .is('deleted_at', null)
    .select('id, slug')
    .maybeSingle()

  if (error) return { ok: false, error: error.message }
  if (!data) return { ok: false, error: 'Product not found' }

  await logWebsiteAudit('website_publish', productId, { slug: data.slug, published: true })
  return { ok: true, productId, slug: data.slug as string }
}

export async function unpublishWebsiteProduct(productId: string): Promise<WebsiteWriteResult> {
  const sb = getWebsiteSupabaseAdmin()
  const now = new Date().toISOString()
  const { data, error } = await sb
    .from('products')
    .update({ published: false, updated_at: now })
    .eq('id', productId)
    .is('deleted_at', null)
    .select('id, slug')
    .maybeSingle()

  if (error) return { ok: false, error: error.message }
  if (!data) return { ok: false, error: 'Product not found' }

  await logWebsiteAudit('website_unpublish', productId, { slug: data.slug, published: false })
  return { ok: true, productId, slug: data.slug as string }
}

export async function setWebsiteProductFeatured(
  productId: string,
  featured: boolean,
): Promise<WebsiteWriteResult> {
  const sb = getWebsiteSupabaseAdmin()
  const { data: row, error: readErr } = await sb
    .from('site_config')
    .select('value')
    .eq('key', 'homepage')
    .maybeSingle()

  if (readErr) return { ok: false, error: readErr.message }

  const value = (row?.value ?? { sections: [] }) as {
    sections?: Array<{ id: string; data?: { source?: string; manualProductIds?: string[] } }>
  }
  const sections = value.sections ?? []
  const idx = sections.findIndex((s) => s.id === 'featured')
  if (idx < 0) return { ok: false, error: 'Homepage featured section not found in site_config' }

  const section = sections[idx]
  const data = section.data ?? {}
  const ids = new Set(data.manualProductIds ?? [])

  if (featured) ids.add(productId)
  else ids.delete(productId)

  sections[idx] = {
    ...section,
    data: {
      ...data,
      source: 'manual',
      manualProductIds: [...ids],
    },
  }

  const { error: writeErr } = await sb
    .from('site_config')
    .update({ value: { ...value, sections } })
    .eq('key', 'homepage')

  if (writeErr) return { ok: false, error: writeErr.message }

  const product = await getWebsiteProduct(productId)
  await logWebsiteAudit('website_set_featured', productId, { featured, slug: product?.slug })
  return { ok: true, productId, slug: product?.slug ?? productId }
}

export async function updateWebsiteProductFields(
  productId: string,
  fields: {
    priceBdt?: number
    description?: string
    shortDescription?: string
    categoryId?: string
    /** Product title/name — feeds the page <title> and product heading (SEO). */
    title?: string
  },
): Promise<WebsiteWriteResult> {
  const sb = getWebsiteSupabaseAdmin()
  const update: Record<string, unknown> = { updated_at: new Date().toISOString() }
  if (fields.priceBdt != null) update.price_bdt = fields.priceBdt
  if (fields.description != null) update.description = fields.description
  if (fields.shortDescription != null) update.short_description = fields.shortDescription
  if (fields.categoryId) update.category_id = fields.categoryId
  if (fields.title != null) update.title = fields.title

  const { data, error } = await sb
    .from('products')
    .update(update)
    .eq('id', productId)
    .is('deleted_at', null)
    .select('id, slug')
    .maybeSingle()

  if (error) return { ok: false, error: error.message }
  if (!data) return { ok: false, error: 'Product not found' }

  await logWebsiteAudit('website_update_product', productId, { slug: data.slug, fields })
  return { ok: true, productId, slug: data.slug as string }
}

/**
 * Set alt-text on a product's images (image SEO + accessibility). Each update is
 * matched by the image URL within this product, so a stale/removed image is
 * skipped rather than mis-updated. Returns how many image rows were updated.
 */
export async function updateWebsiteProductImageAlts(
  productId: string,
  alts: Array<{ url: string; alt: string }>,
): Promise<{ ok: true; updated: number } | { ok: false; error: string }> {
  const sb = getWebsiteSupabaseAdmin()
  let updated = 0
  for (const a of alts) {
    const url = String(a.url ?? '').trim()
    const alt = String(a.alt ?? '').trim()
    if (!url || !alt) continue
    const { data, error } = await sb
      .from('product_images')
      .update({ alt_text: alt })
      .eq('product_id', productId)
      .eq('url', url)
      .select('id')
    if (error) return { ok: false, error: error.message }
    updated += data?.length ?? 0
  }
  await logWebsiteAudit('website_update_image_alt', productId, { count: updated, alts })
  return { ok: true, updated }
}

/** Resolve category slug → UUID for writes. */
export async function getWebsiteCategoryIdBySlug(slug: string): Promise<string | null> {
  const sb = getWebsiteSupabaseAdmin()
  const { data, error } = await sb.from('categories').select('id').eq('slug', slug).maybeSingle()
  if (error) throw new Error(error.message)
  return (data?.id as string) ?? null
}

/**
 * Rename a product's URL — and leave a way back.
 *
 * A slug is the page's address on Google. Changing one without a redirect is not
 * an edit, it is a deletion: the old URL 404s and whatever ranking it earned is
 * gone. That is why nothing in this ERP could rename a slug until the storefront
 * gained a `product_redirects` table (alma-lifestyle PR #84), and why one live
 * product still carries a Bangla sentence as its slug.
 *
 * The order here is the safety property. The redirect is written FIRST: if the
 * rename then fails, the worst case is a redirect pointing at a slug nobody uses
 * — invisible and harmless. Writing the slug first and failing on the redirect
 * would leave the old URL dead, which is the exact damage this exists to prevent.
 */
export async function renameWebsiteProductSlug(
  productId: string,
  input: { fromSlug: string; toSlug: string; reason?: string },
): Promise<WebsiteWriteResult> {
  const sb = getWebsiteSupabaseAdmin()
  const fromSlug = input.fromSlug.trim()
  const toSlug = input.toSlug.trim()

  if (!fromSlug || !toSlug) return { ok: false, error: 'fromSlug ও toSlug দুটোই লাগবে।' }
  if (fromSlug === toSlug) return { ok: false, error: 'নতুন slug পুরনোটার মতোই — বদলানোর কিছু নেই।' }

  // Refuse rather than silently half-work: without the redirect table this write
  // would destroy the old URL. The storefront migration must be applied first.
  const probe = await sb.from('product_redirects').select('from_slug').limit(1)
  if (probe.error) {
    return {
      ok: false,
      error:
        'storefront-এ product_redirects টেবিল এখনো নেই — redirect ছাড়া slug বদলালে পুরনো লিংক ৪০৪ হবে। '
        + 'আগে alma-lifestyle-এর migration চালাতে হবে, তারপর এটা করা যাবে।',
    }
  }

  // Someone else may already own the target address.
  const taken = await sb.from('products').select('id').eq('slug', toSlug).is('deleted_at', null).maybeSingle()
  if (taken.error) return { ok: false, error: taken.error.message }
  if (taken.data && (taken.data as { id: string }).id !== productId) {
    return { ok: false, error: `"${toSlug}" slug অন্য একটা product ইতিমধ্যে ব্যবহার করছে।` }
  }

  const redirectWrite = await sb.from('product_redirects').upsert(
    {
      from_slug: fromSlug,
      to_slug: toSlug,
      reason: input.reason ?? null,
      created_by: 'agent',
    },
    { onConflict: 'from_slug' },
  )
  if (redirectWrite.error) return { ok: false, error: `redirect লেখা যায়নি: ${redirectWrite.error.message}` }

  const { data, error } = await sb
    .from('products')
    .update({ slug: toSlug, updated_at: new Date().toISOString() })
    .eq('id', productId)
    .is('deleted_at', null)
    .select('id, slug')
    .maybeSingle()

  if (error || !data) {
    // The rename failed after the redirect landed. Take the redirect back so we
    // do not leave a pointer to an address that was never created.
    await sb.from('product_redirects').delete().eq('from_slug', fromSlug)
    return { ok: false, error: error?.message ?? 'Product not found' }
  }

  // Anything that pointed AT the old slug must now point at the new one, or the
  // chain grows a hop every rename.
  await sb.from('product_redirects').update({ to_slug: toSlug }).eq('to_slug', fromSlug)

  await logWebsiteAudit('website_rename_slug', productId, {
    fromSlug,
    toSlug,
    reason: input.reason ?? null,
  })
  return { ok: true, productId, slug: data.slug as string }
}
