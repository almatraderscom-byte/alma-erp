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
