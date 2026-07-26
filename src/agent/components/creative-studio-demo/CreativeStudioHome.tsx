'use client'

import { useMemo, useState } from 'react'
import {
  CREATE_OPTIONS,
  PROJECTS,
  REUSABLE_SYSTEMS,
  type CreateKind,
  type StudioProject,
} from './studio-v2-fixtures'
import { AVATARS, GALLERY_ASSETS } from './studio-v3-fixtures'
import type { StudioV3Navigate } from './studio-v3-navigation'
import {
  StudioV2Icon,
  type StudioIconName,
} from './StudioV2Icon'
import styles from './CreativeStudioEnterpriseDemo.module.css'

type HomeSection =
  | 'home'
  | 'projects'
  | 'assets'
  | 'finishing'
  | 'systems'
  | 'review'
  | 'operations'

type CreativeStudioHomeProps = {
  onNavigate: StudioV3Navigate
}

const createIcons: Record<CreateKind, StudioIconName> = {
  image: 'image',
  video: 'video',
  voice: 'voice',
  audio: 'audio',
  campaign: 'campaign',
  longform: 'layers',
}

const navItems: ReadonlyArray<{
  id: HomeSection
  label: string
  icon: StudioIconName
  count?: string
}> = [
  { id: 'home', label: 'Home', icon: 'home' },
  { id: 'projects', label: 'Projects', icon: 'projects', count: '18' },
  { id: 'assets', label: 'Assets & catalog', icon: 'assets' },
  { id: 'finishing', label: 'Finishing', icon: 'palette' },
  { id: 'systems', label: 'Recipes & models', icon: 'template' },
  { id: 'review', label: 'Review queue', icon: 'review', count: '3' },
  { id: 'operations', label: 'Operations', icon: 'activity' },
] as const

function stateIcon(project: StudioProject): StudioIconName {
  if (project.state === 'approved') return 'check'
  if (project.state === 'rendering') return 'worker'
  if (project.state === 'review') return 'review'
  return 'clock'
}

function ProjectArtwork({ project }: { project: StudioProject }) {
  return (
    <div className={`${styles.projectArtwork} ${styles[`projectArtwork_${project.preview}`]}`}>
      <div className={styles.artworkWordmark}>ALMA</div>
      <div className={styles.artworkFigure}>
        <span />
        <i />
      </div>
      <div className={styles.artworkCopy}>
        <small>{project.collection}</small>
        <strong>
          {project.preview === 'coral'
            ? 'Quiet confidence.'
            : project.preview === 'sand'
              ? 'Every story, together.'
              : project.preview === 'sage'
                ? 'Summer, considered.'
                : 'Made with intention.'}
        </strong>
      </div>
      {project.state === 'rendering' && (
        <span className={styles.artworkRendering}>
          <StudioV2Icon name="worker" size={14} />
          Rendering {project.progress}%
        </span>
      )}
    </div>
  )
}

export function CreativeStudioHome({ onNavigate }: CreativeStudioHomeProps) {
  const [activeSection, setActiveSection] = useState<HomeSection>('home')
  const [search, setSearch] = useState('')
  const [agentBrief, setAgentBrief] = useState(
    'Turn the approved Eid product selects into a 24-second reel. Plan the edit only.',
  )
  const [notice, setNotice] = useState(
    'V3 prototype · safe fixtures only · providers and publishing disconnected',
  )

  const normalizedSearch = search.trim().toLowerCase()
  const visibleProjects = useMemo(() => {
    if (!normalizedSearch) return PROJECTS
    return PROJECTS.filter((project) =>
      [project.title, project.collection, project.format, project.stateLabel]
        .join(' ')
        .toLowerCase()
        .includes(normalizedSearch),
    )
  }, [normalizedSearch])
  const visibleSystems = useMemo(() => {
    if (!normalizedSearch) return REUSABLE_SYSTEMS
    return REUSABLE_SYSTEMS.filter((system) =>
      [system.kind, system.name, system.meta, system.detail]
        .join(' ')
        .toLowerCase()
        .includes(normalizedSearch),
    )
  }, [normalizedSearch])

  function selectSection(section: HomeSection) {
    setActiveSection(section)
    if (section === 'projects') onNavigate({ id: 'desk', desk: 'projects' })
    if (section === 'assets') onNavigate({ id: 'gallery' })
    if (section === 'finishing') onNavigate({ id: 'finishing' })
    if (section === 'systems') onNavigate({ id: 'desk', desk: 'systems' })
    if (section === 'review') onNavigate({ id: 'desk', desk: 'review' })
    if (section === 'operations') onNavigate({ id: 'desk', desk: 'operations' })
  }

  function openCreate(kind: CreateKind) {
    if (kind === 'image') onNavigate({ id: 'image-lab' })
    if (kind === 'video') onNavigate({ id: 'video-lab' })
    if (kind === 'voice') onNavigate({ id: 'desk', desk: 'voice' })
    if (kind === 'audio') onNavigate({ id: 'desk', desk: 'audio' })
    if (kind === 'campaign') onNavigate({ id: 'desk', desk: 'campaign' })
    if (kind === 'longform') onNavigate({ id: 'project-setup', kind: 'longform' })
  }

  return (
    <section aria-label="ALMA Creative Studio Home" className={styles.studioHome}>
      <a className={styles.skipLink} href="#studio-home-content">
        Skip to Studio content
      </a>

      <header className={styles.homeTopbar}>
        <a className={styles.almaIdentity} href="/agent" aria-label="Return to ALMA Agent">
          <span className={styles.v4HomeBackIcon}>
            <StudioV2Icon name="arrow-left" size={17} />
          </span>
          <span className={styles.almaMark}>A</span>
          <span>
            <strong>ALMA</strong>
            <small>Creative Studio</small>
          </span>
        </a>

        <label className={styles.globalSearch}>
          <StudioV2Icon name="search" size={19} />
          <span className={styles.srOnly}>Search Creative Studio</span>
          <input
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search projects, assets, recipes or product codes"
            value={search}
          />
          <kbd>⌘ K</kbd>
        </label>

        <div className={styles.homeTopActions}>
          <span className={styles.prototypePill}>
            <span />
            Prototype · ৳0
          </span>
          <button
            className={styles.secondaryButton}
            onClick={() => onNavigate({ id: 'editor', kind: 'video', openAgent: true })}
            type="button"
          >
            <StudioV2Icon name="agent" size={18} />
            Ask Creative Agent
          </button>
          <button className={styles.avatarButton} aria-label="Owner account" type="button">
            MB
          </button>
        </div>
      </header>

      <div className={styles.homeFrame}>
        <aside className={styles.homeSidebar} aria-label="Creative Studio navigation">
          <div className={styles.brandContext}>
            <span className={styles.brandMonogram}>A</span>
            <div>
              <small>ACTIVE BRAND</small>
              <strong>ALMA Lifestyle</strong>
              <span>
                <StudioV2Icon name="lock" size={12} />
                Strict isolation
              </span>
            </div>
            <StudioV2Icon name="chevron-down" size={16} />
          </div>

          <nav>
            {navItems.map((item) => (
              <button
                aria-current={activeSection === item.id ? 'page' : undefined}
                className={activeSection === item.id ? styles.sidebarActive : undefined}
                key={item.id}
                onClick={() => selectSection(item.id)}
                type="button"
              >
                <StudioV2Icon name={item.icon} size={19} />
                <span>{item.label}</span>
                {item.count && <em>{item.count}</em>}
              </button>
            ))}
          </nav>

          <section className={styles.sidebarSecurity}>
            <div>
              <StudioV2Icon name="lock" size={17} />
              <span>
                <strong>Owner controls active</strong>
                <small>Spend · publish · voice</small>
              </span>
            </div>
            <button onClick={() => selectSection('operations')} type="button">
              View safeguards
            </button>
          </section>
        </aside>

        <div className={styles.homeContent} id="studio-home-content">
          <section className={styles.homeHero} aria-labelledby="studio-home-title">
            <div>
              <span className={styles.eyebrow}>CREATIVE OPERATING SPACE</span>
              <h1 id="studio-home-title">What are we making today?</h1>
              <p>
                Create, edit and govern every ALMA asset from one brand-safe workspace.
              </p>
            </div>
            <div className={styles.homeHeroMeta}>
              <span>
                <StudioV2Icon name="check" size={15} />
                6 providers healthy
              </span>
              <span>
                <StudioV2Icon name="review" size={15} />
                3 awaiting review
              </span>
            </div>
          </section>

          <section className={styles.createDock} aria-labelledby="create-dock-title">
            <div className={styles.sectionHeading}>
              <div>
                <h2 id="create-dock-title">Create</h2>
                <p>Begin with a format; configure provenance and cost before execution.</p>
              </div>
              <button
                className={styles.textButton}
                onClick={() => onNavigate({ id: 'desk', desk: 'campaign' })}
                type="button"
              >
                View all workflows
                <StudioV2Icon name="chevron-right" size={16} />
              </button>
            </div>
            <div className={styles.createGrid}>
              {CREATE_OPTIONS.map((option) => (
                <button
                  className={styles.createOption}
                  key={option.id}
                  onClick={() => openCreate(option.id)}
                  type="button"
                >
                  <span className={styles.createOptionIcon}>
                    <StudioV2Icon name={createIcons[option.id]} size={23} />
                  </span>
                  <span className={styles.createOptionCopy}>
                    <strong>{option.title}</strong>
                    <small>{option.description}</small>
                    <em>{option.detail}</em>
                  </span>
                  <span className={styles.createOptionArrow}>
                    <StudioV2Icon name="chevron-right" size={18} />
                  </span>
                </button>
              ))}
            </div>
          </section>

          <section className={styles.v3HomeInventory} aria-labelledby="home-inventory-title">
            <header className={styles.sectionHeading}>
              <div>
                <span className={styles.eyebrow}>CREATIVE INVENTORY</span>
                <h2 id="home-inventory-title">Assets, catalog & identity</h2>
                <p>Move a verified source into a Lab, Finishing or the Project Editor.</p>
              </div>
              <div className={styles.v3HomeInventoryActions}>
                <button
                  className={styles.secondaryButton}
                  onClick={() => onNavigate({ id: 'finishing' })}
                  type="button"
                >
                  <StudioV2Icon name="palette" size={16} />
                  Finishing
                </button>
                <button
                  className={styles.primaryButton}
                  onClick={() => onNavigate({ id: 'gallery' })}
                  type="button"
                >
                  Open Gallery
                  <StudioV2Icon name="chevron-right" size={16} />
                </button>
              </div>
            </header>
            <div className={styles.v3HomeInventoryGrid}>
              <div className={styles.v3HomeAssetLane}>
                {GALLERY_ASSETS.filter((asset) => asset.type === 'image' || asset.type === 'video')
                  .slice(0, 5)
                  .map((asset) => (
                    <button
                      key={asset.id}
                      onClick={() =>
                        onNavigate(
                          asset.type === 'video'
                            ? { id: 'video-lab', sourceAssetId: asset.id }
                            : { id: 'image-lab', sourceAssetId: asset.id },
                        )
                      }
                      type="button"
                    >
                      <span
                        className={`${styles.v3HomeAssetThumb} ${styles[`v3Tone_${asset.tone}`]}`}
                      >
                        <i />
                        <b />
                        {asset.type === 'video' && (
                          <em>
                            <StudioV2Icon name="play" size={12} />
                          </em>
                        )}
                      </span>
                      <span>
                        <strong>{asset.title}</strong>
                        <small>{asset.statusLabel} · {asset.resolution}</small>
                      </span>
                    </button>
                  ))}
              </div>
              <div className={styles.v3HomeAvatarLane}>
                <header>
                  <span>AVATARS / SAVED MODELS</span>
                  <button
                    onClick={() => onNavigate({ id: 'gallery', initialType: 'avatar' })}
                    type="button"
                  >
                    View all
                  </button>
                </header>
                <div>
                  {AVATARS.slice(0, 4).map((avatar) => (
                    <button
                      aria-label={`Use ${avatar.name} in Image Lab`}
                      key={avatar.id}
                      onClick={() => onNavigate({ id: 'image-lab', avatarId: avatar.id })}
                      type="button"
                    >
                      <span
                        className={`${styles.v3HomeAvatar} ${styles[`v3Tone_${avatar.tone}`]}`}
                      >
                        <i />
                        <b />
                      </span>
                      <span>
                        <strong>{avatar.name}</strong>
                        <small>{avatar.role} · {avatar.status}</small>
                      </span>
                    </button>
                  ))}
                </div>
              </div>
            </div>
          </section>

          <div className={styles.homeColumns}>
            <div className={styles.homePrimaryColumn}>
              <section className={styles.projectsSection} aria-labelledby="recent-projects-title">
                <div className={styles.sectionHeading}>
                  <div>
                    <h2 id="recent-projects-title">
                      {normalizedSearch ? 'Search results' : 'Continue working'}
                    </h2>
                    <p>
                      {normalizedSearch
                        ? `${visibleProjects.length + visibleSystems.length} matching Studio items`
                        : 'Recent projects across production, review and delivery.'}
                    </p>
                  </div>
                  <button className={styles.textButton} onClick={() => selectSection('projects')} type="button">
                    All projects
                    <StudioV2Icon name="chevron-right" size={16} />
                  </button>
                </div>

                {visibleProjects.length > 0 ? (
                  <div className={styles.projectGrid}>
                    {visibleProjects.map((project) => (
                      <article className={styles.projectCard} key={project.id}>
                        <button
                          aria-label={`Open ${project.title}`}
                          className={styles.projectOpenTarget}
                          onClick={() => onNavigate({ id: 'editor', kind: project.kind, project })}
                          type="button"
                        >
                          <ProjectArtwork project={project} />
                        </button>
                        <div className={styles.projectCardBody}>
                          <div className={styles.projectCardTitle}>
                            <div>
                              <span>{project.collection}</span>
                              <h3>{project.title}</h3>
                              <p>{project.format}</p>
                            </div>
                            <button
                              aria-label={`More options for ${project.title}`}
                              onClick={() => setNotice(`${project.title} actions are prototype-only.`)}
                              type="button"
                            >
                              <StudioV2Icon name="more" />
                            </button>
                          </div>
                          <div className={styles.projectProgress}>
                            <span style={{ width: `${project.progress}%` }} />
                          </div>
                          <footer className={styles.projectCardFooter}>
                            <span className={`${styles.projectState} ${styles[`projectState_${project.state}`]}`}>
                              <StudioV2Icon name={stateIcon(project)} size={14} />
                              {project.stateLabel}
                            </span>
                            <div className={styles.collaborators} aria-label="Project collaborators">
                              <span>{project.owner}</span>
                              {project.collaborators.slice(0, 2).map((person) => (
                                <span key={person}>{person}</span>
                              ))}
                            </div>
                            <time>{project.activity}</time>
                          </footer>
                        </div>
                      </article>
                    ))}
                  </div>
                ) : (
                  <div className={styles.searchEmpty}>
                    <span>
                      <StudioV2Icon name="search" size={24} />
                    </span>
                    <h3>No projects match “{search}”</h3>
                    <p>Try a product code, collection, recipe or project state.</p>
                    <button className={styles.secondaryButton} onClick={() => setSearch('')} type="button">
                      Clear search
                    </button>
                  </div>
                )}
              </section>

              <section className={styles.systemsSection} aria-labelledby="systems-title">
                <div className={styles.sectionHeading}>
                  <div>
                    <h2 id="systems-title">Reusable systems</h2>
                    <p>Approved templates, recipes, models and campaign workflows.</p>
                  </div>
                  <button className={styles.textButton} onClick={() => selectSection('systems')} type="button">
                    Manage library
                    <StudioV2Icon name="chevron-right" size={16} />
                  </button>
                </div>
                <div className={styles.systemList}>
                  {visibleSystems.map((system, index) => (
                    <button
                      key={system.id}
                      onClick={() => {
                        setNotice(`${system.name} selected with its current locked version.`)
                        onNavigate(
                          index === 3
                            ? { id: 'desk', desk: 'campaign' }
                            : index === 1
                              ? { id: 'desk', desk: 'systems' }
                              : { id: 'image-lab' },
                        )
                      }}
                      type="button"
                    >
                      <span className={styles.systemIcon}>
                        <StudioV2Icon
                          name={index === 0 ? 'template' : index === 1 ? 'layers' : index === 2 ? 'video' : 'campaign'}
                          size={20}
                        />
                      </span>
                      <span>
                        <small>{system.kind}</small>
                        <strong>{system.name}</strong>
                        <em>{system.detail}</em>
                      </span>
                      <span className={styles.systemMeta}>{system.meta}</span>
                      <StudioV2Icon name="chevron-right" size={17} />
                    </button>
                  ))}
                </div>
              </section>
            </div>

            <aside className={styles.homePulse} aria-label="Creative Studio activity and controls">
              <section className={styles.agentBrief}>
                <header>
                  <span className={styles.agentMark}>
                    <StudioV2Icon name="agent" size={21} />
                  </span>
                  <div>
                    <span>CREATIVE AGENT</span>
                    <h2>Orchestrate the workspace</h2>
                  </div>
                </header>
                <p>
                  Describe the outcome. Agent starts with a reviewable plan and never silently
                  spends or publishes.
                </p>
                <label>
                  <span className={styles.srOnly}>Creative Agent brief</span>
                  <textarea
                    onChange={(event) => setAgentBrief(event.target.value)}
                    value={agentBrief}
                  />
                </label>
                <div className={styles.agentBriefContext}>
                  <span>ALMA Lifestyle</span>
                  <span>Plan only</span>
                  <span>৳0</span>
                </div>
                <button
                  className={styles.agentPlanButton}
                  disabled={!agentBrief.trim()}
                  onClick={() => onNavigate({ id: 'editor', kind: 'video', openAgent: true })}
                  type="button"
                >
                  Build reviewable plan
                  <StudioV2Icon name="chevron-right" size={18} />
                </button>
              </section>

              <section className={styles.studioPulseCard}>
                <div className={styles.pulseHeading}>
                  <div>
                    <span>STUDIO PULSE</span>
                    <h2>Today</h2>
                  </div>
                  <span className={styles.liveState}>
                    <i />
                    Healthy
                  </span>
                </div>

                <div className={styles.pulseList}>
                  <button onClick={() => selectSection('review')} type="button">
                    <span className={styles.pulseIcon}>
                      <StudioV2Icon name="review" size={18} />
                    </span>
                    <span>
                      <strong>3 items need review</strong>
                      <small>1 caption · 2 campaign variants</small>
                    </span>
                    <em>Review</em>
                  </button>
                  <button onClick={() => selectSection('operations')} type="button">
                    <span className={styles.pulseIcon}>
                      <StudioV2Icon name="publish" size={18} />
                    </span>
                    <span>
                      <strong>Distribution dry-run ready</strong>
                      <small>External publish remains owner-blocked</small>
                    </span>
                    <em>Inspect</em>
                  </button>
                  <button onClick={() => selectSection('operations')} type="button">
                    <span className={styles.pulseIcon}>
                      <StudioV2Icon name="analytics" size={18} />
                    </span>
                    <span>
                      <strong>Reels drove 18.4% assisted revenue</strong>
                      <small>7-day attributed performance</small>
                    </span>
                    <em>Report</em>
                  </button>
                  <button onClick={() => selectSection('operations')} type="button">
                    <span className={styles.pulseIcon}>
                      <StudioV2Icon name="archive" size={18} />
                    </span>
                    <span>
                      <strong>12 assets archive in 8 days</strong>
                      <small>Retention policy CSE7 · recoverable</small>
                    </span>
                    <em>Manage</em>
                  </button>
                </div>

                <div className={styles.operationsSummary}>
                  <div>
                    <span>
                      <StudioV2Icon name="worker" size={15} />
                      Workers
                    </span>
                    <strong>6 / 6 healthy</strong>
                  </div>
                  <div>
                    <span>
                      <StudioV2Icon name="wallet" size={15} />
                      Today
                    </span>
                    <strong>৳420 / ৳2,500</strong>
                  </div>
                  <div>
                    <span>
                      <StudioV2Icon name="lock" size={15} />
                      Security
                    </span>
                    <strong>0 policy alerts</strong>
                  </div>
                </div>
              </section>

              <section className={styles.providerIntegrity}>
                <header>
                  <span>PROVIDER INTEGRITY</span>
                  <strong>Workstreams A + B</strong>
                </header>
                <div>
                  <span>
                    <StudioV2Icon name="check" size={14} />
                    1080 × 1920 verified
                  </span>
                  <span>
                    <StudioV2Icon name="lock" size={14} />
                    Upscale prohibited
                  </span>
                  <span>
                    <StudioV2Icon name="check" size={14} />
                    FASHN commercial approved
                  </span>
                </div>
                <p>IDM-VTON remains research-only. Model choice is explicit before paid runs.</p>
              </section>
            </aside>
          </div>
        </div>
      </div>

      <div className={styles.homeNotice} role="status">
        <span>{notice}</span>
        <button aria-label="Dismiss status" onClick={() => setNotice('')} type="button">
          <StudioV2Icon name="close" size={15} />
        </button>
      </div>

    </section>
  )
}
