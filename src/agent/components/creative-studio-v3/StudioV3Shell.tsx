'use client'

import Link from 'next/link'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { StudioVersionSwitcher } from '@/agent/components/creative-studio/StudioVersionSwitcher'
import type { StudioBrandProfile } from '@/agent/components/creative-studio/studio-api'
import { StudioV3Icon, type StudioV3IconName } from '@/agent/components/creative-studio-v3/StudioV3Icon'
import type {
  CreativeStudioV3Navigate,
  CreativeStudioV3View,
} from '@/agent/components/creative-studio-v3/types'
import type { StudioAccessRole } from '@/lib/creative-studio/studio-access'
import type { StudioProjectSummary } from '@/lib/creative-studio/project-contract'
import styles from '@/agent/components/creative-studio-v3/creative-studio-v3.module.css'

type NavItem = {
  label: string
  icon: StudioV3IconName
  view: CreativeStudioV3View
}

const primaryNav: NavItem[] = [
  { label: 'Home', icon: 'home', view: { id: 'home' } },
  { label: 'Projects', icon: 'project', view: { id: 'desk', desk: 'projects' } },
  { label: 'Assets & Gallery', icon: 'gallery', view: { id: 'gallery' } },
  { label: 'Finishing', icon: 'finish', view: { id: 'finishing' } },
  { label: 'Review', icon: 'review', view: { id: 'desk', desk: 'review' } },
]

const capabilityNav: NavItem[] = [
  { label: 'Image Lab', icon: 'image', view: { id: 'image-lab' } },
  { label: 'Video & Reel', icon: 'video', view: { id: 'video-lab' } },
  { label: 'Avatars & Models', icon: 'account', view: { id: 'desk', desk: 'systems' } },
  { label: 'Voice', icon: 'voice', view: { id: 'desk', desk: 'voice' } },
  { label: 'Audio & Music', icon: 'audio', view: { id: 'desk', desk: 'audio' } },
  { label: 'Campaign Packs', icon: 'campaign', view: { id: 'desk', desk: 'campaign' } },
  { label: 'Operations', icon: 'operations', view: { id: 'desk', desk: 'operations' } },
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

function studioViewKey(view: CreativeStudioV3View): string {
  if (view.id === 'desk') return `${view.id}:${view.desk}:${view.projectId ?? ''}`
  if (view.id === 'editor') return `${view.id}:${view.compositionId}`
  if (view.id === 'gallery') {
    return `${view.id}:${view.initialType ?? ''}:${view.reviewTarget?.projectAssetId ?? ''}`
  }
  if (view.id === 'finishing') return `${view.id}:${view.assetId ?? ''}`
  if (view.id === 'image-lab' || view.id === 'video-lab') {
    return `${view.id}:${view.sourceAssetId ?? ''}:${view.avatarId ?? ''}`
  }
  return view.id
}

export function StudioV3Shell({
  children,
  currentView,
  onNavigate,
  brands,
  activeBrandId,
  activeProjectId,
  onBrandChange,
  onProjectChange,
  onAskCreativeAgent,
  projects,
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
  activeProjectId: string | null
  onBrandChange: (brandId: string) => void
  onProjectChange: (projectId: string) => void
  onAskCreativeAgent: () => void
  projects: StudioProjectSummary[]
  accountLabel: string
  immersive: boolean
  legacyAllowed: boolean
  studioRole: StudioAccessRole
}) {
  const [creativeAgentOpen, setCreativeAgentOpen] = useState(false)
  const mainRef = useRef<HTMLElement>(null)
  const agentTriggerRef = useRef<HTMLButtonElement>(null)
  const agentDialogRef = useRef<HTMLElement>(null)
  const activeBrand = brands.find((brand) => brand.brandProfileId === activeBrandId) ?? brands[0] ?? null
  const activeProject = projects.find((project) => project.id === activeProjectId) ?? null
  const viewKey = studioViewKey(currentView)

  useEffect(() => {
    mainRef.current?.scrollTo({ top: 0, left: 0, behavior: 'auto' })
  }, [viewKey])

  useEffect(() => {
    if (!creativeAgentOpen) return
    const previousOverflow = document.body.style.overflow
    const trigger = agentTriggerRef.current
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setCreativeAgentOpen(false)
        return
      }
      if (event.key !== 'Tab') return
      const controls = Array.from(
        agentDialogRef.current?.querySelectorAll<HTMLElement>(
          'button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ) ?? [],
      )
      const first = controls[0]
      const last = controls.at(-1)
      if (!first || !last) return
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }
    document.body.style.overflow = 'hidden'
    window.addEventListener('keydown', onKeyDown)
    agentDialogRef.current?.querySelector<HTMLElement>('button')?.focus()
    return () => {
      document.body.style.overflow = previousOverflow
      window.removeEventListener('keydown', onKeyDown)
      trigger?.focus()
    }
  }, [creativeAgentOpen])
  const legacyQuery = new URLSearchParams({ studio: 'legacy' })
  if (activeBrandId) legacyQuery.set('brand', activeBrandId)
  if (activeProjectId) legacyQuery.set('project', activeProjectId)
  if (currentView.id === 'home') {
    legacyQuery.set('mode', 'home')
  } else if (currentView.id === 'image-lab') {
    legacyQuery.set('mode', 'image')
    if (currentView.sourceAssetId) legacyQuery.set('asset', currentView.sourceAssetId)
    if (currentView.avatarId) legacyQuery.set('avatar', currentView.avatarId)
  } else if (currentView.id === 'video-lab') {
    legacyQuery.set('mode', 'video')
    if (currentView.sourceAssetId) legacyQuery.set('asset', currentView.sourceAssetId)
    if (currentView.avatarId) legacyQuery.set('avatar', currentView.avatarId)
  } else if (currentView.id === 'gallery') {
    legacyQuery.set('mode', 'gallery')
    if (currentView.initialType) legacyQuery.set('type', currentView.initialType)
    if (currentView.reviewTarget) {
      legacyQuery.set('brand', currentView.reviewTarget.brandProfileId)
      legacyQuery.set('project', currentView.reviewTarget.projectId)
      legacyQuery.set('asset', currentView.reviewTarget.projectAssetId)
      legacyQuery.set('version', currentView.reviewTarget.currentVersionId)
      legacyQuery.set('sequence', String(currentView.reviewTarget.expectedSequence))
    }
  } else if (currentView.id === 'finishing') {
    legacyQuery.set('mode', 'finishing')
    if (currentView.assetId) legacyQuery.set('asset', currentView.assetId)
  } else if (currentView.id === 'desk') {
    legacyQuery.set('mode', currentView.desk)
    legacyQuery.set('desk', currentView.desk)
    if (currentView.projectId) legacyQuery.set('project', currentView.projectId)
  } else {
    legacyQuery.set('mode', 'editor')
    legacyQuery.set('composition', currentView.compositionId)
    legacyQuery.set('project', currentView.projectId)
  }
  const legacyHref = `/agent/creative-studio?${legacyQuery.toString()}`
  const accessLabel = activeBrand
    ? `${activeBrand.role.slice(0, 1).toUpperCase()}${activeBrand.role.slice(1)}`
    : `${studioRole.slice(0, 1).toUpperCase()}${studioRole.slice(1)}`

  const navButton = (item: NavItem) => {
    const active = isCurrent(currentView, item.view)
    return (
      <button
        aria-label={item.label}
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
    <section aria-label="ALMA Creative Studio V4" className={styles.shell}>
      <a className={styles.skipLink} href="#creative-studio-v3-main">Skip to Studio workspace</a>

      <header className={styles.topbar}>
        <div className={styles.topbarIdentity}>
          <Link aria-label="Return to ALMA Agent" className={styles.almaMark} href="/agent">A</Link>
          <div>
            <strong>Creative Studio</strong>
            <span>{activeBrand?.organization ?? activeBrand?.name ?? 'Signed-in workspace'}</span>
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
          <label className={styles.brandSelect}>
            <span className="sr-only">Active project</span>
            <select
              aria-label="Active Creative Studio project"
              disabled={projects.length === 0}
              onChange={(event) => onProjectChange(event.target.value)}
              value={activeProjectId ?? ''}
            >
              {projects.length === 0 && <option value="">No accessible project</option>}
              {projects.map((project) => (
                <option key={project.id} value={project.id}>{project.name}</option>
              ))}
            </select>
          </label>
          <span className={styles.guardBadge}><StudioV3Icon name="lock" /> Protected</span>
          <button
            className={styles.agentButton}
            disabled={!activeProject || immersive}
            onClick={() => setCreativeAgentOpen(true)}
            ref={agentTriggerRef}
            type="button"
          >
            <StudioV3Icon name="spark" />
            Ask Creative Agent
          </button>
          {legacyAllowed && (
            <StudioVersionSwitcher
              activeVersion="v4"
              canUseV4
              disabled={immersive}
              legacyHref={legacyHref}
              tone="light"
            />
          )}
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
          <nav aria-label="Creative Studio navigation" className={styles.sidebarNav}>{primaryNav.map(navButton)}</nav>
          <div className={styles.sidebarDivider} />
          <p className={styles.sidebarLabel}>Create</p>
          <nav aria-label="Creative Studio capability navigation" className={styles.sidebarNav}>{capabilityNav.map(navButton)}</nav>
          <div className={styles.sidebarTrust}>
            <StudioV3Icon name="lock" />
            <div>
              <strong>Safe by design</strong>
              <span>Spend, review and publishing always require the correct approval.</span>
            </div>
          </div>
        </aside>

        <main
          className={`${styles.main} ${immersive ? styles.mainImmersive : ''}`}
          id="creative-studio-v3-main"
          ref={mainRef}
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

      {creativeAgentOpen && (
        <div
          className={styles.agentLaunchBackdrop}
          onMouseDown={(event) => {
            if (event.currentTarget === event.target) setCreativeAgentOpen(false)
          }}
        >
          <section
            aria-labelledby="creative-agent-launch-title"
            aria-modal="true"
            className={styles.agentLaunchDialog}
            ref={agentDialogRef}
            role="dialog"
          >
            <header>
              <span><StudioV3Icon name="spark" /></span>
              <div>
                <span className={styles.eyebrow}>CREATIVE AGENT</span>
                <h2 id="creative-agent-launch-title">Work inside this project</h2>
              </div>
              <button
                aria-label="Close Creative Agent panel"
                className={styles.iconButton}
                onClick={() => setCreativeAgentOpen(false)}
                type="button"
              >
                <StudioV3Icon name="close" />
              </button>
            </header>
            <div className={styles.agentLaunchContext}>
              <span><StudioV3Icon name="project" /></span>
              <div>
                <small>ACTIVE PROJECT</small>
                <strong>{activeProject?.name ?? 'No project selected'}</strong>
                <p>
                  The Agent opens in this project&apos;s versioned workspace. It will not
                  queue generation, publish, or spend without the separate guarded action.
                </p>
              </div>
            </div>
            <div className={styles.projectSetupActions}>
              <button className={styles.secondaryButton} onClick={() => setCreativeAgentOpen(false)} type="button">
                Stay here
              </button>
              <button
                className={styles.primaryButton}
                onClick={() => {
                  setCreativeAgentOpen(false)
                  onAskCreativeAgent()
                }}
                type="button"
              >
                Open project Agent
                <StudioV3Icon name="arrow" />
              </button>
            </div>
          </section>
        </div>
      )}
    </section>
  )
}
