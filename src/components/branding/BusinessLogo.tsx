'use client'
import { useBranding } from '@/contexts/BrandingContext'
import { useBusiness } from '@/contexts/BusinessContext'

export function BusinessLogo({
  size = 32,
  className = '',
}: {
  size?: number
  className?: string
}) {
  const { branding, loading } = useBranding()
  const { business } = useBusiness()

  if (!loading && branding?.logo_url) {
    return (
      <img
        src={branding.logo_url}
        alt={branding.company_name || business.name}
        width={size}
        height={size}
        className={`object-contain shrink-0 rounded-lg ${className}`}
        style={{ maxHeight: size, maxWidth: size * 2.5 }}
      />
    )
  }

  return (
    <div
      className={`rounded-lg bg-gold/10 border border-gold-dim/40 flex items-center justify-center shrink-0 ${className}`}
      style={{ width: size, height: size }}
    >
      <span className="text-xs font-black text-gold-lt tracking-wider">{business.brandInitial}</span>
    </div>
  )
}
