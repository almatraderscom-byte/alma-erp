'use client'

/* eslint-disable @next/next/no-img-element */

import { useCallback, useEffect, useState } from 'react'
import type { StudioBrandProfile } from '@/agent/components/creative-studio/studio-api'
import { StudioV3Icon, type StudioV3IconName } from '@/agent/components/creative-studio-v3/StudioV3Icon'
import type {
  CreativeStudioV3Navigate,
} from '@/agent/components/creative-studio-v3/types'
import type {
  CreativeStudioV3ProductionPort,
  StudioV3HomeSnapshot,
} from '@/agent/components/creative-studio-v3/ports'
import { STUDIO_V3_SCOPE_BOUNDARY } from '@/agent/components/creative-studio-v3/ports'
import styles from '@/agent/components/creative-studio-v3/creative-studio-v3.module.css'

const EMPTY_SNAPSHOT: StudioV3HomeSnapshot = {
  brands: [],
  projects: [],
  recipes: [],
  models: [],
  recentAssets: [],
  config: null,
  health: null,
  retention: null,
  issues: [],
}

type CreateCard = {
  title: string
  description: string
  icon: StudioV3IconName
  action: () => void
  disabled?: boolean
  badge?: string
}

function formatDate(value: string | null | undefined): string {
  if (!value) return 'No activity yet'
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) return 'Unknown date'
  return new Intl.DateTimeFormat('en-BD', { month: 'short', day: 'numeric' }).format(date)
}

function AssetPreview({
  url,
  type,
}: {
  url: string | null | undefined
  type: string
}) {
  if (url && type.includes('video')) {
    return <video aria-label="Video asset preview" muted playsInline src={url} />
  }
  if (url) return <img alt="" src={url} />
  return (
    <span className={styles.assetFallback}>
      <StudioV3Icon name={type.includes('audio') ? 'audio' : type.includes('video') ? 'video' : 'image'} />
    </span>
  )
}

export function StudioV3Home({
  activeBrand,
  onNavigate,
  port,
}: {
  activeBrand: StudioBrandProfile | null
  onNavigate: CreativeStudioV3Navigate
  port: CreativeStudioV3ProductionPort
}) {
  const [snapshot, setSnapshot] = useState<StudioV3HomeSnapshot>(EMPTY_SNAPSHOT)
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    try {
      setSnapshot(await port.loadHome(activeBrand?.brandProfileId))
    } finally {
      setLoading(false)
    }
  }, [activeBrand?.brandProfileId, port])

  useEffect(() => {
    void load()
  }, [load])

  const query = search.trim().toLocaleLowerCase('bn-BD')
  const matches = (value: string | null | undefined) => !query || String(value ?? '').toLocaleLowerCase('bn-BD').includes(query)
  const projects = snapshot.projects.filter((project) =>
    matches(`${project.name} ${project.description ?? ''} ${project.product?.code ?? ''}`))
  const assets = snapshot.recentAssets.filter((asset) =>
    matches(`${asset.summary ?? ''} ${asset.provider} ${asset.mode}`))
  const models = snapshot.models.filter((model) =>
    matches(`${model.name} ${model.role ?? ''}`))

  const createCards: CreateCard[] = [
    {
      title: 'Image',
      description: 'Auto or seven Advanced modes with capability truth.',
      icon: 'image',
      action: () => onNavigate({ id: 'image-lab' }),
    },
    {
      title: 'Video / Reel',
      description: 'Start from a gallery still, avatar or owned shoot.',
      icon: 'video',
      action: () => onNavigate({ id: 'video-lab' }),
    },
    {
      title: 'Voice',
      description: 'Consent, immutable identity versions and lifecycle.',
      icon: 'voice',
      action: () => onNavigate({ id: 'desk', desk: 'voice' }),
    },
    {
      title: 'Audio',
      description: 'Music, wish song, dubbing, clean voice and SFX.',
      icon: 'audio',
      action: () => onNavigate({ id: 'desk', desk: 'audio' }),
    },
    {
      title: 'Campaign Pack',
      description: 'Manifest, two drafts, stage retry and hard cap.',
      icon: 'campaign',
      action: () => onNavigate({ id: 'desk', desk: 'campaign' }),
    },
    {
      title: 'Long-form',
      description: 'Composition command foundation connects here.',
      icon: 'project',
      action: () => {},
      disabled: true,
      badge: 'Foundation hook',
    },
  ]

  const readyAssets = snapshot.recentAssets.filter((asset) => asset.publishable).length
  const reviewAssets = snapshot.recentAssets.filter((asset) => asset.assetState === 'qc_failed' || asset.assetState === 'draft').length
  const worker = snapshot.health?.worker
  const configuredEngines = snapshot.config?.engines.filter((engine) => engine.configured && engine.enabled && !engine.killed) ?? []

  return (
    <div className={styles.page}>
      <header className={styles.homeHero}>
        <div>
          <span className={styles.eyebrow}>ALMA Creative Studio</span>
          <h1>What are we making today?</h1>
          <p>
            {activeBrand?.name ?? 'Signed-in workspace'} · production assets, identity and guarded creation in one place.
          </p>
        </div>
        <label className={styles.globalSearch}>
          <StudioV3Icon name="search" />
          <span className="sr-only">Search Studio</span>
          <input
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search projects, assets, product codes, providers…"
            type="search"
            value={search}
          />
          {search && (
            <button aria-label="Clear Studio search" onClick={() => setSearch('')} type="button">
              <StudioV3Icon name="close" />
            </button>
          )}
        </label>
      </header>

      {snapshot.issues.length > 0 && (
        <details className={styles.issueBanner}>
          <summary>
            <StudioV3Icon name="warning" />
            {snapshot.issues.length} production resource{snapshot.issues.length === 1 ? '' : 's'} unavailable
          </summary>
          <ul>
            {snapshot.issues.map((item) => <li key={item.resource}><strong>{item.resource}</strong>: {item.message}</li>)}
          </ul>
          <button onClick={() => void load()} type="button"><StudioV3Icon name="refresh" /> Retry</button>
        </details>
      )}
      <p className={styles.scopeNotice}>
        <StudioV3Icon name="lock" />
        Active brand is selected only from the server-enforced accessible-brand list. Projects and
        recipes re-request the active brand through their current owner-only contracts; recent
        assets and identities do not imply brand filtering ({STUDIO_V3_SCOPE_BOUNDARY.gallery}).
      </p>

      <section aria-labelledby="studio-create-heading" className={styles.section}>
        <div className={styles.sectionHeading}>
          <div>
            <span className={styles.eyebrow}>Create</span>
            <h2 id="studio-create-heading">Choose the right production path</h2>
          </div>
          <span className={styles.sectionMeta}>Paid effects require a second server-gated action</span>
        </div>
        <div className={styles.createGrid}>
          {createCards.map((card) => (
            <button
              className={styles.createCard}
              disabled={card.disabled}
              key={card.title}
              onClick={card.action}
              type="button"
            >
              <span className={styles.createIcon}><StudioV3Icon name={card.icon} /></span>
              <span>
                <strong>{card.title}</strong>
                <small>{card.description}</small>
              </span>
              {card.badge ? <em>{card.badge}</em> : <StudioV3Icon className={styles.createArrow} name="arrow" />}
            </button>
          ))}
        </div>
      </section>

      <section aria-labelledby="studio-inventory-heading" className={styles.section}>
        <div className={styles.sectionHeading}>
          <div>
            <span className={styles.eyebrow}>Assets, catalog & identity</span>
            <h2 id="studio-inventory-heading">Start from approved business context</h2>
          </div>
          <button className={styles.textButton} onClick={() => onNavigate({ id: 'gallery' })} type="button">
            Open Gallery <StudioV3Icon name="arrow" />
          </button>
        </div>

        <div className={styles.inventoryGrid}>
          <div className={styles.inventoryAssets}>
            <header>
              <strong>Recent production assets</strong>
              <span>{snapshot.recentAssets.length} loaded · {readyAssets} publishable</span>
            </header>
            {loading ? (
              <div className={styles.cardSkeletons}>{Array.from({ length: 4 }).map((_, index) => <span key={index} />)}</div>
            ) : assets.length === 0 ? (
              <p className={styles.emptyState}>No production assets match this view.</p>
            ) : (
              <div className={styles.assetLane}>
                {assets.slice(0, 8).map((asset) => (
                  <button
                    className={styles.assetTile}
                    key={asset.id}
                    onClick={() => onNavigate({ id: 'gallery', initialType: asset.type.includes('video') ? 'video' : asset.type.includes('audio') ? 'audio' : 'image' })}
                    type="button"
                  >
                    <span className={styles.assetArt}><AssetPreview type={asset.type} url={asset.thumbUrl ?? asset.previewUrl} /></span>
                    <span className={styles.assetCopy}>
                      <strong>{asset.summary ?? asset.mode ?? 'Untitled asset'}</strong>
                      <small>{asset.provider} · {asset.assetState.replaceAll('_', ' ')}</small>
                    </span>
                  </button>
                ))}
              </div>
            )}
          </div>

          <div className={styles.identityPanel}>
            <header>
              <strong>Saved identities</strong>
              <button onClick={() => onNavigate({ id: 'desk', desk: 'systems' })} type="button">View all</button>
            </header>
            {models.length === 0 ? (
              <p className={styles.emptyState}>No saved identity is available for this access context.</p>
            ) : (
              <div className={styles.identityList}>
                {models.slice(0, 5).map((model) => (
                  <button
                    key={model.id}
                    onClick={() => onNavigate({ id: 'image-lab', avatarId: model.id })}
                    type="button"
                  >
                    <span className={styles.identityAvatar}>
                      {model.imageUrl ? <img alt="" src={model.imageUrl} /> : <StudioV3Icon name="voice" />}
                    </span>
                    <span>
                      <strong>{model.name}</strong>
                      <small>{model.role ?? 'Unassigned role'} · {model.avatar?.built ? `${model.avatar.count} angles` : 'single reference'}</small>
                    </span>
                    {model.isDefault && <em>Default</em>}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      </section>

      <div className={styles.homeColumns}>
        <section aria-labelledby="recent-projects-heading" className={styles.section}>
          <div className={styles.sectionHeading}>
            <div>
              <span className={styles.eyebrow}>Content OS</span>
              <h2 id="recent-projects-heading">Recent projects</h2>
            </div>
            <button className={styles.textButton} onClick={() => onNavigate({ id: 'desk', desk: 'projects' })} type="button">
              All projects <StudioV3Icon name="arrow" />
            </button>
          </div>
          <div className={styles.projectList}>
            {projects.length === 0 ? (
              <p className={styles.emptyState}>No production projects match this view.</p>
            ) : projects.slice(0, 5).map((project) => (
              <button key={project.id} onClick={() => onNavigate({ id: 'desk', desk: 'projects' })} type="button">
                <span className={styles.projectMark}><StudioV3Icon name="project" /></span>
                <span className={styles.projectCopy}>
                  <strong>{project.name}</strong>
                  <small>
                    {project.product?.code ?? 'No ERP product'} · {project.defaultFolder} · {project.assetCount} assets
                  </small>
                </span>
                <span className={styles.projectState}>
                  <strong>{project.currentRecipe?.name ?? 'No recipe'}</strong>
                  <small>{formatDate(project.updatedAt)}</small>
                </span>
              </button>
            ))}
          </div>
        </section>

        <aside aria-label="Studio pulse" className={styles.pulseColumn}>
          <section className={styles.pulseCard}>
            <header>
              <span className={styles.pulseIcon}><StudioV3Icon name="operations" /></span>
              <div><strong>Studio pulse</strong><small>Live production APIs</small></div>
              <button aria-label="Refresh Studio pulse" onClick={() => void load()} type="button"><StudioV3Icon name="refresh" /></button>
            </header>
            <dl>
              <div><dt>Worker</dt><dd data-tone={worker?.state ?? 'unknown'}>{worker?.labelBn ?? 'Unknown'}</dd></div>
              <div><dt>Needs review</dt><dd>{reviewAssets}</dd></div>
              <div><dt>Active engines</dt><dd>{configuredEngines.length}</dd></div>
              <div><dt>Archive receipts</dt><dd>{snapshot.retention?.stats.verifiedReceipts ?? 'Unavailable'}</dd></div>
            </dl>
            {worker?.lastSeenBn && <p>{worker.lastSeenBn}</p>}
          </section>

          <section className={styles.integrityCard}>
            <header><StudioV3Icon name="lock" /><strong>Provider integrity</strong></header>
            {configuredEngines.length === 0 ? (
              <p>No configured engine snapshot is available.</p>
            ) : (
              <ul>
                {configuredEngines.slice(0, 5).map((engine) => (
                  <li key={engine.id}>
                    <span>{engine.label}</span>
                    <em>{engine.status.replace('_', ' ')}</em>
                  </li>
                ))}
              </ul>
            )}
            <button onClick={() => onNavigate({ id: 'desk', desk: 'operations' })} type="button">
              Inspect policy and health <StudioV3Icon name="arrow" />
            </button>
          </section>
        </aside>
      </div>
    </div>
  )
}
