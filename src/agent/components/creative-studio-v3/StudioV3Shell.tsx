'use client'

import Link from 'next/link'
import type { ReactNode } from 'react'
import type { StudioBrandProfile } from '@/agent/components/creative-studio/studio-api'
import { StudioV3Icon, type StudioV3IconName } from '@/agent/components/creative-studio-v3/StudioV3Icon'
import type {
  CreativeStudioV3Navigate,
  CreativeStudioV3View,
} from '@/agent/components/creative-studio-v3/types'
import type { StudioAccessRole } from '@/lib/creative-studio/studio-access'
import styles from '@/agent/components/creative-studio-v3/creative-studio-v3.module.css'

type NavItem = {
  label: string
  icon: StudioV3IconName
  view: CreativeStudioV3View
}

const primaryNav: NavItem[] = [
  { label: 'Studio Home', icon: 'home', view: { id: 'home' } },
  { label: 'Projects', icon: 'project', view: { id: 'desk', desk: 'projects' } },
  { label: 'Gallery', icon: 'gallery', view: { id: 'gallery' } },
  { label: 'Finishing', icon: 'finish', view: { id: 'finishing' } },
  { label: 'Recipes & Models', icon: 'systems', view: { id: 'desk', desk: 'systems' } },
  { label: 'Review', icon: 'review', view: { id: 'desk', desk: 'review' } },
  { label: 'Operations', icon: 'operations', view: { id: 'desk', desk: 'operations' } },
]

const capabilityNav: NavItem[] = [
  { label: 'Voice', icon: 'voice', view: { id: 'desk', desk: 'voice' } },
  { label: 'Audio', icon: 'audio', view: { id: 'desk', desk: 'audio' } },
  { label: 'Campaign', icon: 'campaign', view: { id: 'desk', desk: 'campaign' } },
]

const mobileNav: NavItem[] = [
  { label: 'Home', icon: 'home', view: { id: 'home' } },
  { label: 'Image', icon: 'image', view: { id: 'image-lab' } },
  { label: 'Video', icon: 'video', view: { id: 'video-lab' } },
  { label: 'Gallery', icon: 'gallery', view: { id: 'gallery' } },
  { label: 'Finish', icon: 'finish', view: { id: 'finishing' } },
]

function isCurrent(current: CreativeStudioV3View, candidate: CreativeStudioV3View): boolean {
  if (candidate.id === 'desk') return current.id === 'desk' && current.desk === candidate.desk
  return current.id === candidate.id
}

export function StudioV3Shell({
  children,
  currentView,
  onNavigate,
  brands,
  activeBrandId,
  onBrandChange,
  accountLabel,
  immersive,
  legacyAllowed,
  studioRole,
}: {
  children: ReactNode
  currentView: CreativeStudioV3View
  onNavigate: CreativeStudioV3Navigate
  brands: StudioBrandProfile[]
  activeBrandId: string | null
  onBrandChange: (brandId: string) => void
  accountLabel: string
  immersive: boolean
  legacyAllowed: boolean
  studioRole: StudioAccessRole
}) {
  const activeBrand = brands.find((brand) => brand.brandProfileId === activeBrandId) ?? brands[0] ?? null
  const legacyHref = '/agent/creative-studio?studio=legacy'
  const accessLabel = activeBrand
    ? `${activeBrand.role.slice(0, 1).toUpperCase()}${activeBrand.role.slice(1)}`
    : `${studioRole.slice(0, 1).toUpperCase()}${studioRole.slice(1)}`

  const navButton = (item: NavItem) => {
    const active = isCurrent(currentView, item.view)
    return (
      <button
        aria-current={active ? 'page' : undefined}
        className={active ? styles.navItemActive : styles.navItem}
        key={`${item.view.id}-${item.label}`}
        onClick={() => onNavigate(item.view)}
        type="button"
      >
        <StudioV3Icon name={item.icon} />
        <span>{item.label}</span>
      </button>
    )
  }

  return (
    <section aria-label="ALMA Creative Studio V3" className={styles.shell}>
      <a className={styles.skipLink} href="#creative-studio-v3-main">Skip to Studio workspace</a>

      <header className={styles.topbar}>
        <div className={styles.topbarIdentity}>
          <Link aria-label="Return to ALMA Agent" className={styles.almaMark} href="/agent">A</Link>
          <div>
            <strong>Creative Studio</strong>
            <span>{activeBrand?.organization ?? activeBrand?.name ?? 'Signed-in workspace'} · access-scoped</span>
          </div>
        </div>

        <div className={styles.topbarControls}>
          <label className={styles.brandSelect}>
            <span className="sr-only">Active brand</span>
            <select
              aria-label="Active Creative Studio brand"
              disabled={brands.length === 0}
              onChange={(event) => onBrandChange(event.target.value)}
              value={activeBrandId ?? ''}
            >
              {brands.length === 0 && <option value="">Brand context unavailable</option>}
              {brands.map((brand) => (
                <option key={brand.brandProfileId} value={brand.brandProfileId}>
                  {brand.name}
                </option>
              ))}
            </select>
          </label>
          <span className={styles.guardBadge}><StudioV3Icon name="lock" /> Server gated</span>
          {legacyAllowed && <Link className={styles.legacyLink} href={legacyHref}>Legacy Studio</Link>}
          <span
            aria-label={`${accountLabel} · ${accessLabel}`}
            className={styles.accountBadge}
            title={`${accountLabel} · ${accessLabel}`}
          >
            <StudioV3Icon name="account" />
            <span>{accessLabel}</span>
          </span>
        </div>
      </header>

      <div className={`${styles.shellBody} ${immersive ? styles.shellBodyImmersive : ''}`}>
        <aside aria-label="Creative Studio sections" className={styles.sidebar}>
          <nav className={styles.sidebarNav}>{primaryNav.map(navButton)}</nav>
          <div className={styles.sidebarDivider} />
          <p className={styles.sidebarLabel}>Capability desks</p>
          <nav className={styles.sidebarNav}>{capabilityNav.map(navButton)}</nav>
          <div className={styles.sidebarTrust}>
            <StudioV3Icon name="lock" />
            <div>
              <strong>Production truth</strong>
              <span>Provider, spend, review and publish authority stay on the server.</span>
            </div>
          </div>
        </aside>

        <main
          className={`${styles.main} ${immersive ? styles.mainImmersive : ''}`}
          id="creative-studio-v3-main"
          tabIndex={-1}
        >
          {children}
        </main>
      </div>

      {!immersive && (
        <nav aria-label="Creative Studio mobile navigation" className={styles.mobileNav}>
          {mobileNav.map(navButton)}
        </nav>
      )}
    </section>
  )
}
