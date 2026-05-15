import type { BusinessId } from '@/lib/businesses'

export interface BusinessBranding {
  business_id: BusinessId
  company_name: string
  tagline: string
  phone: string
  email: string
  website: string
  address: string
  facebook: string
  logo_file_id: string
  logo_url: string
  favicon_file_id: string
  favicon_url: string
  color_primary: string
  color_secondary: string
  color_accent: string
  invoice_footer_thanks: string
  invoice_footer_policy: string
  invoice_footer_note: string
  invoice_prefix: string
  created_at?: string
  updated_at?: string
  created_by?: string
}

export type BrandAssetType = 'logo' | 'favicon'
