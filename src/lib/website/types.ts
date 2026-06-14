/** Read-only types mirroring almatraders.com Supabase tables (src/server/db/schema.ts). */

export type WebsiteProductType =
  | 'simple'
  | 'men_panjabi'
  | 'boy_panjabi'
  | 'women_three_piece'
  | 'girl_two_piece'

export type WebsiteCategorySlug =
  | 'panjabi'
  | 'electronics'
  | 'accessories'
  | 'home-decor'
  | 'islamic'
  | string

export interface WebsiteCategoryRow {
  id: string
  slug: string
  name: string
}

export interface WebsiteProductImageRow {
  id: string
  product_id: string
  url: string
  alt_text: string | null
  sort_order: number
}

export interface WebsiteProductVariantRow {
  id: string
  product_id: string
  sku: string
  size: string | null
  color: string | null
  stock_quantity: number
}

export interface WebsiteProductRow {
  id: string
  category_id: string
  sku: string
  slug: string
  title: string
  product_type: WebsiteProductType
  design_group_id: string | null
  design_group_name: string | null
  short_description: string | null
  description: string | null
  price_bdt: number
  compare_at_price_bdt: number | null
  published: boolean
  published_at: string | null
  deleted_at: string | null
  created_at: string
  updated_at: string
  categories?: WebsiteCategoryRow | WebsiteCategoryRow[] | null
  product_images?: WebsiteProductImageRow[]
  product_variants?: WebsiteProductVariantRow[]
}

export interface WebsiteProductSummary {
  id: string
  slug: string
  name: string
  sku: string
  price: number
  category: string
  categoryLabel: string
  type: string
  published: boolean
  featured: boolean
  imageCount: number
  stock: number
  updatedAt: string
}

export interface WebsiteProductDetail extends WebsiteProductSummary {
  description: string | null
  shortDescription: string | null
  compareAtPrice: number | null
  images: Array<{ url: string; alt: string | null; sortOrder: number }>
  variants: Array<{ sku: string; size: string | null; color: string | null; stock: number }>
  designGroupId: string | null
  designGroupName: string | null
}

export interface WebsiteCatalogStats {
  totalProducts: number
  totalPublished: number
  totalDraft: number
  noImageCount: number
  recentlyAdded: Array<{ slug: string; name: string; createdAt: string }>
  recentlyUpdated: Array<{ slug: string; name: string; updatedAt: string }>
  byCategory: Array<{
    slug: string
    name: string
    published: number
    draft: number
    total: number
  }>
}
