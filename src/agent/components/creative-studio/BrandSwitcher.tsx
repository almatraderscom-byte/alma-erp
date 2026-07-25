'use client'

import type { StudioBrandProfile } from '@/agent/components/creative-studio/studio-api'

const ROLE_LABEL = {
  owner: 'মালিক',
  creator: 'নির্মাতা',
  reviewer: 'পর্যালোচক',
} as const

export function BrandSwitcher({
  brands,
  activeBrandProfileId,
  loading,
  onChange,
}: {
  brands: StudioBrandProfile[]
  activeBrandProfileId: string | null
  loading?: boolean
  onChange: (brandProfileId: string) => void
}) {
  if (loading) {
    return <div className="h-8 w-32 animate-pulse rounded-xl bg-white/[0.06]" aria-label="ব্র্যান্ড লোড হচ্ছে" />
  }
  if (!brands.length) {
    return (
      <span className="rounded-xl border border-amber-400/25 bg-amber-400/10 px-2 py-1 text-[9px] text-amber-200">
        কোনো ব্র্যান্ডে প্রবেশাধিকার নেই
      </span>
    )
  }
  return (
    <label className="relative">
      <span className="sr-only">সক্রিয় ব্র্যান্ড</span>
      <select
        value={activeBrandProfileId ?? brands[0].brandProfileId}
        onChange={(event) => onChange(event.target.value)}
        className="max-w-[9.5rem] rounded-xl border border-border-subtle bg-card px-2.5 py-1.5 pr-7 text-[10px] font-bold text-cream outline-none focus:border-[#E07A5F]/60 sm:max-w-[12rem]"
      >
        {brands.map((brand) => (
          <option key={brand.brandProfileId} value={brand.brandProfileId}>
            {brand.name} · {ROLE_LABEL[brand.role]}
          </option>
        ))}
      </select>
    </label>
  )
}
