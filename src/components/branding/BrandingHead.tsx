'use client'
import { useEffect } from 'react'
import { useBranding } from '@/contexts/BrandingContext'
import { useBusiness } from '@/contexts/BusinessContext'

function brandIconHref(url: string) {
  return `/api/branding/image-proxy?raw=1&url=${encodeURIComponent(url)}`
}

export function BrandingHead() {
  const { branding } = useBranding()
  const { business } = useBusiness()

  useEffect(() => {
    if (!branding) return
    const title = branding.company_name || business.name
    document.title = document.title.includes('·') ? document.title : `${title} · Alma ERP`

    const iconUrl = branding.favicon_url || branding.logo_url
    const iconHref = iconUrl ? brandIconHref(iconUrl) : ''
    let link = document.querySelector<HTMLLinkElement>('link[data-brand-favicon][rel="icon"]')
    if (!link) {
      link = document.createElement('link')
      link.rel = 'icon'
      link.setAttribute('data-brand-favicon', '1')
      document.head.appendChild(link)
    }
    if (iconHref) link.href = iconHref

    let apple = document.querySelector<HTMLLinkElement>('link[data-brand-favicon][rel="apple-touch-icon"]')
    if (!apple) {
      apple = document.createElement('link')
      apple.rel = 'apple-touch-icon'
      apple.setAttribute('data-brand-favicon', '1')
      document.head.appendChild(apple)
    }
    if (iconHref) apple.href = iconHref

    const theme = branding.color_primary || '#C9A84C'
    let meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"][data-brand]')
    if (!meta) {
      meta = document.createElement('meta')
      meta.name = 'theme-color'
      meta.setAttribute('data-brand', '1')
      document.head.appendChild(meta)
    }
    meta.content = theme

    document.documentElement.style.setProperty('--brand-primary', theme)
    document.documentElement.style.setProperty('--brand-secondary', branding.color_secondary || '#8B6914')
    document.documentElement.style.setProperty('--brand-accent', branding.color_accent || '#F0D080')
  }, [branding, business.name])

  return null
}
