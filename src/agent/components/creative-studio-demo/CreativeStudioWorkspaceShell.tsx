'use client'

import type { ReactNode } from 'react'
import styles from './CreativeStudioEnterpriseDemo.module.css'
import { StudioV2Icon, type StudioIconName } from './StudioV2Icon'
import type { StudioV3Navigate } from './studio-v3-navigation'

type WorkspaceSection = 'image' | 'video' | 'gallery' | 'finishing' | 'desk'

type CreativeStudioWorkspaceShellProps = {
  active: WorkspaceSection
  eyebrow: string
  title: string
  description: string
  icon: StudioIconName
  children: ReactNode
  onNavigate: StudioV3Navigate
  actions?: ReactNode
  status?: string
}

const workspaceNav: ReadonlyArray<{
  id: Exclude<WorkspaceSection, 'desk'>
  label: string
  icon: StudioIconName
}> = [
  { id: 'image', label: 'Image Lab', icon: 'image' },
  { id: 'video', label: 'Video Lab', icon: 'video' },
  { id: 'gallery', label: 'Gallery', icon: 'assets' },
  { id: 'finishing', label: 'Finishing', icon: 'palette' },
] as const

export function CreativeStudioWorkspaceShell({
  active,
  eyebrow,
  title,
  description,
  icon,
  children,
  onNavigate,
  actions,
  status = 'Fixture workspace · no provider calls',
}: CreativeStudioWorkspaceShellProps) {
  function navigateTo(id: Exclude<WorkspaceSection, 'desk'>) {
    if (id === 'image') onNavigate({ id: 'image-lab' })
    if (id === 'video') onNavigate({ id: 'video-lab' })
    if (id === 'gallery') onNavigate({ id: 'gallery' })
    if (id === 'finishing') onNavigate({ id: 'finishing' })
  }

  return (
    <section aria-label={`ALMA Creative Studio ${title}`} className={styles.v3Workspace}>
      <a className={styles.skipLink} href="#studio-workspace-content">
        Skip to workspace
      </a>

      <header className={styles.v3Topbar}>
        <div className={styles.v3TopbarStart}>
          <button
            aria-label="Return to Creative Studio Home"
            className={styles.v3BackButton}
            onClick={() => onNavigate({ id: 'home' })}
            type="button"
          >
            <StudioV2Icon name="arrow-left" size={18} />
          </button>
          <button
            className={styles.v3Identity}
            onClick={() => onNavigate({ id: 'home' })}
            type="button"
          >
            <span className={styles.almaMark}>A</span>
            <span>
              <strong>Creative Studio</strong>
              <small>ALMA Lifestyle · strict isolation</small>
            </span>
          </button>
        </div>

        <nav aria-label="Create and library workspaces" className={styles.v3TopNav}>
          {workspaceNav.map((item) => (
            <button
              aria-current={active === item.id ? 'page' : undefined}
              className={active === item.id ? styles.v3TopNavActive : undefined}
              key={item.id}
              onClick={() => navigateTo(item.id)}
              type="button"
            >
              <StudioV2Icon name={item.icon} size={17} />
              <span>{item.label}</span>
            </button>
          ))}
        </nav>

        <div className={styles.v3TopbarEnd}>
          <span className={styles.v3SafeState}>
            <span />
            Prototype · ৳0
          </span>
          <button
            aria-label="Owner controls"
            className={styles.avatarButton}
            onClick={() => onNavigate({ id: 'desk', desk: 'operations' })}
            type="button"
          >
            MB
          </button>
        </div>
      </header>

      <main className={styles.v3WorkspaceMain} id="studio-workspace-content">
        <header className={styles.v3WorkspaceHeader}>
          <div className={styles.v3WorkspaceHeading}>
            <span className={styles.v3WorkspaceIcon}>
              <StudioV2Icon name={icon} size={22} />
            </span>
            <div>
              <span className={styles.eyebrow}>{eyebrow}</span>
              <h1>{title}</h1>
              <p>{description}</p>
            </div>
          </div>
          <div className={styles.v3WorkspaceActions}>
            <span className={styles.v3WorkspaceStatus}>
              <StudioV2Icon name="lock" size={14} />
              {status}
            </span>
            {actions}
          </div>
        </header>

        {children}
      </main>
    </section>
  )
}
