'use client'

/* eslint-disable @next/next/no-img-element */

import { useCallback, useEffect, useState } from 'react'
import toast from 'react-hot-toast'
import type { StudioBrandProfile } from '@/agent/components/creative-studio/studio-api'
import { StudioV3Icon, type StudioV3IconName } from '@/agent/components/creative-studio-v3/StudioV3Icon'
import type {
  CreativeStudioV3Navigate,
} from '@/agent/components/creative-studio-v3/types'
import type {
  CreativeStudioV3ProductionPort,
  StudioV3HomeSnapshot,
} from '@/agent/components/creative-studio-v3/ports'
import type { StudioProjectSummary } from '@/lib/creative-studio/project-contract'
import { STUDIO_V3_SCOPE_BOUNDARY } from '@/agent/components/creative-studio-v3/ports'
import type { CreativeStudioV4CanvasInput } from '@/agent/components/creative-studio-v3/composition-client'
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

function canvasFromDimensions(widthValue: number, heightValue: number): CreativeStudioV4CanvasInput {
  const width = Math.max(64, Math.min(16_384, Math.round(widthValue || 1080)))
  const height = Math.max(64, Math.min(16_384, Math.round(heightValue || 1080)))
  const greatestCommonDivisor = (left: number, right: number): number =>
    right === 0 ? left : greatestCommonDivisor(right, left % right)
  const divisor = greatestCommonDivisor(width, height)
  const reducedWidth = width / divisor
  const reducedHeight = height / divisor
  const scale = Math.max(reducedWidth, reducedHeight) > 100
    ? 100 / Math.max(reducedWidth, reducedHeight)
    : 1
  return {
    width,
    height,
    aspectWidth: Math.max(1, Math.round(reducedWidth * scale)),
    aspectHeight: Math.max(1, Math.round(reducedHeight * scale)),
  }
}

async function measureCanvasMedia(file: File): Promise<{ width: number; height: number }> {
  const url = URL.createObjectURL(file)
  try {
    if (file.type.startsWith('image/')) {
      const bitmap = await createImageBitmap(file)
      const dimensions = { width: bitmap.width, height: bitmap.height }
      bitmap.close()
      return dimensions
    }
    if (file.type.startsWith('video/')) {
      return await new Promise((resolve, reject) => {
        const video = document.createElement('video')
        video.preload = 'metadata'
        video.onloadedmetadata = () => resolve({
          width: video.videoWidth,
          height: video.videoHeight,
        })
        video.onerror = () => reject(new Error('The video dimensions could not be read.'))
        video.src = url
      })
    }
    throw new Error('Choose an image or video file.')
  } finally {
    URL.revokeObjectURL(url)
  }
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
  activeProject,
  accessibleProjects,
  foundationReadEnabled,
  initialProjectId,
  launchingProjectId,
  onNavigate,
  onCreateProject,
  onOpenComposition,
  port,
}: {
  activeBrand: StudioBrandProfile | null
  activeProject: StudioProjectSummary | null
  accessibleProjects: StudioProjectSummary[]
  foundationReadEnabled: boolean
  initialProjectId: string | null
  launchingProjectId: string | null
  onNavigate: CreativeStudioV3Navigate
  onCreateProject: (input: {
    name: string
    description?: string
  }) => Promise<StudioProjectSummary>
  onOpenComposition: (
    project: StudioProjectSummary,
    canvas?: CreativeStudioV4CanvasInput,
  ) => Promise<boolean>
  port: CreativeStudioV3ProductionPort
}) {
  const [snapshot, setSnapshot] = useState<StudioV3HomeSnapshot>(EMPTY_SNAPSHOT)
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [projectSetupOpen, setProjectSetupOpen] = useState(false)
  const [projectSetupStep, setProjectSetupStep] = useState<'name' | 'canvas'>('name')
  const [projectName, setProjectName] = useState('')
  const [projectDescription, setProjectDescription] = useState('')
  const [createdProject, setCreatedProject] = useState<StudioProjectSummary | null>(null)
  const [canvasPreset, setCanvasPreset] = useState<'4:5' | '1:1' | '9:16' | '16:9' | 'custom' | 'media' | 'upload'>('4:5')
  const [customWidth, setCustomWidth] = useState(1080)
  const [customHeight, setCustomHeight] = useState(1350)
  const [canvasMediaId, setCanvasMediaId] = useState('')
  const [canvasUploadName, setCanvasUploadName] = useState('')
  const [creatingProject, setCreatingProject] = useState(false)

  const resetProjectSetup = useCallback(() => {
    setProjectSetupOpen(false)
    setProjectSetupStep('name')
    setProjectName('')
    setProjectDescription('')
    setCreatedProject(null)
    setCanvasPreset('4:5')
    setCustomWidth(1080)
    setCustomHeight(1350)
    setCanvasMediaId('')
    setCanvasUploadName('')
  }, [])

  const load = useCallback(async () => {
    if (!activeBrand) {
      setSnapshot(EMPTY_SNAPSHOT)
      setLoading(false)
      return
    }
    setLoading(true)
    try {
      const loaded = await port.loadHome(activeBrand.brandProfileId, activeProject?.id)
      setSnapshot({
        ...loaded,
        projects: accessibleProjects.filter((project) =>
          project.brandProfileId === activeBrand.brandProfileId),
      })
    } finally {
      setLoading(false)
    }
  }, [activeBrand, activeProject?.id, accessibleProjects, port])

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    if (!projectSetupOpen) return
    const previousOverflow = document.body.style.overflow
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !creatingProject) {
        resetProjectSetup()
      }
    }
    document.body.style.overflow = 'hidden'
    window.addEventListener('keydown', onKeyDown)
    return () => {
      document.body.style.overflow = previousOverflow
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [creatingProject, projectSetupOpen, resetProjectSetup])

  const query = search.trim().toLocaleLowerCase('bn-BD')
  const matches = (value: string | null | undefined) => !query || String(value ?? '').toLocaleLowerCase('bn-BD').includes(query)
  const accessScopedProjects = accessibleProjects.filter((project) =>
    project.brandProfileId === activeBrand?.brandProfileId)
  const compositionProjects = accessScopedProjects.filter((project) =>
    !project.readonly)
  const initialProject = initialProjectId
    ? compositionProjects.find((project) =>
      project.id === initialProjectId) ?? null
    : compositionProjects[0] ?? null
  const projects = accessScopedProjects.filter((project) =>
    matches(`${project.name} ${project.description ?? ''} ${project.product?.code ?? ''}`))
  const assets = snapshot.recentAssets.filter((asset) =>
    matches(`${asset.summary ?? ''} ${asset.provider} ${asset.mode}`))
  const models = snapshot.models.filter((model) =>
    matches(`${model.name} ${model.role ?? ''}`))

  const createCards: CreateCard[] = [
    {
      title: 'Image',
      description: 'Create campaign-ready product visuals with guided or advanced controls.',
      icon: 'image',
      action: () => onNavigate({ id: 'image-lab' }),
    },
    {
      title: 'Video / Reel',
      description: 'Turn an approved image, avatar, or shoot into motion.',
      icon: 'video',
      action: () => onNavigate({ id: 'video-lab' }),
    },
    {
      title: 'Avatar',
      description: 'Manage consistent people and model identities for every campaign.',
      icon: 'account',
      action: () => onNavigate({ id: 'desk', desk: 'systems' }),
    },
    {
      title: 'Voice',
      description: 'Create and manage approved brand voices with consent built in.',
      icon: 'voice',
      action: () => onNavigate({ id: 'desk', desk: 'voice' }),
    },
    {
      title: 'Audio',
      description: 'Produce music, dubbing, clean voice, and sound effects.',
      icon: 'audio',
      action: () => onNavigate({ id: 'desk', desk: 'audio' }),
    },
    {
      title: 'Campaign Pack',
      description: 'Build a coordinated set of campaign assets in one workflow.',
      icon: 'campaign',
      action: () => onNavigate({ id: 'desk', desk: 'campaign' }),
    },
    {
      title: 'Long-form',
      description: 'Open a versioned canvas for structured, longer creative projects.',
      icon: 'project',
      action: () => {
        if (initialProject) void onOpenComposition(initialProject)
      },
      disabled:
        !foundationReadEnabled
        || !initialProject
        || launchingProjectId !== null,
      badge: !foundationReadEnabled
        ? 'Foundation off'
        : compositionProjects.length === 0
          ? 'Editable project required'
          : !initialProject
            ? 'Selected project unavailable'
            : launchingProjectId
              ? 'Opening…'
              : 'Versioned editor',
    },
  ]

  const readyAssets = snapshot.recentAssets.filter((asset) => asset.publishable).length
  const reviewAssets = snapshot.recentAssets.filter((asset) => asset.assetState === 'qc_failed' || asset.assetState === 'draft').length
  const worker = snapshot.health?.worker
  const configuredEngines = snapshot.config?.engines.filter((engine) => engine.configured && engine.enabled && !engine.killed) ?? []
  const canvasMedia = snapshot.recentAssets.filter((asset) =>
    Boolean(asset.originalVariant?.width && asset.originalVariant?.height))

  const createNamedProject = async () => {
    const name = projectName.trim()
    if (!name) {
      toast.error('Enter a project name first.')
      return
    }
    setCreatingProject(true)
    try {
      const project = await onCreateProject({
        name,
        description: projectDescription.trim() || undefined,
      })
      setCreatedProject(project)
      setProjectSetupStep('canvas')
      setProjectSetupOpen(false)
      toast.success(`${project.name} opened. Set its canvas in the project workspace.`)
    } catch (reason) {
      toast.error(reason instanceof Error ? reason.message : 'The project could not be created.')
    } finally {
      setCreatingProject(false)
    }
  }

  const canvasInput = (): CreativeStudioV4CanvasInput => {
    const presets = {
      '4:5': { width: 1080, height: 1350, aspectWidth: 4, aspectHeight: 5 },
      '1:1': { width: 1080, height: 1080, aspectWidth: 1, aspectHeight: 1 },
      '9:16': { width: 1080, height: 1920, aspectWidth: 9, aspectHeight: 16 },
      '16:9': { width: 1920, height: 1080, aspectWidth: 16, aspectHeight: 9 },
    } as const
    if (canvasPreset in presets) {
      return presets[canvasPreset as keyof typeof presets]
    }
    if (canvasPreset === 'media') {
      const asset = canvasMedia.find((item) => item.id === canvasMediaId)
      const width = asset?.originalVariant?.width ?? customWidth
      const height = asset?.originalVariant?.height ?? customHeight
      return canvasFromDimensions(width, height)
    }
    return canvasFromDimensions(customWidth, customHeight)
  }

  const selectUploadedCanvas = async (file: File) => {
    try {
      const dimensions = await measureCanvasMedia(file)
      if (!dimensions.width || !dimensions.height) {
        throw new Error('The media has no readable dimensions.')
      }
      setCustomWidth(dimensions.width)
      setCustomHeight(dimensions.height)
      setCanvasUploadName(file.name)
      setCanvasPreset('upload')
      toast.success(`${file.name} · ${dimensions.width} × ${dimensions.height} selected.`)
    } catch (reason) {
      toast.error(reason instanceof Error ? reason.message : 'The media dimensions could not be read.')
    }
  }

  const openCreatedProject = async () => {
    if (!createdProject) return
    if (canvasPreset === 'media' && !canvasMediaId) {
      toast.error('Choose a media asset whose dimensions should become the canvas.')
      return
    }
    setCreatingProject(true)
    try {
      const opened = await onOpenComposition(createdProject, canvasInput())
      if (opened) resetProjectSetup()
    } finally {
      setCreatingProject(false)
    }
  }

  if (createdProject && projectSetupStep === 'canvas') {
    const selectedCanvas = canvasInput()
    return (
      <div className={`${styles.page} ${styles.projectCanvasPage}`}>
        <header className={styles.workspaceHeader}>
          <div className={styles.workspaceTitle}>
            <span><StudioV3Icon name="project" /></span>
            <div>
              <span className={styles.eyebrow}>PROJECT OPEN · CANVAS SETUP</span>
              <h1>{createdProject.name}</h1>
              <p>
                The project already exists in the active workspace. Choose its first canvas now,
                or finish later without creating a composition.
              </p>
            </div>
          </div>
          <span className={styles.serverBadge}><StudioV3Icon name="check" /> Project saved</span>
        </header>

        <section aria-labelledby="project-canvas-heading" className={styles.projectCanvasSurface}>
          <header>
            <div>
              <span className={styles.eyebrow}>CANVAS</span>
              <h2 id="project-canvas-heading">Choose the working frame</h2>
              <p>Use a standard preset, exact custom dimensions, scoped current media, or a local image/video frame.</p>
            </div>
            <strong>{selectedCanvas.width} × {selectedCanvas.height} px</strong>
          </header>

          <div className={styles.canvasSetupStep}>
            <div className={styles.canvasPresetGrid}>
              {([
                ['4:5', 'Portrait', '1080 × 1350'],
                ['1:1', 'Square', '1080 × 1080'],
                ['9:16', 'Story / Reel', '1080 × 1920'],
                ['16:9', 'Landscape', '1920 × 1080'],
                ['custom', 'Custom size', `${customWidth} × ${customHeight}`],
                ['media', 'Current media', canvasMedia.length ? 'Use asset dimensions' : 'No measured media'],
              ] as const).map(([id, label, meta]) => (
                <button
                  aria-pressed={canvasPreset === id}
                  disabled={id === 'media' && canvasMedia.length === 0}
                  key={id}
                  onClick={() => setCanvasPreset(id)}
                  type="button"
                >
                  <span>{id}</span>
                  <strong>{label}</strong>
                  <small>{meta}</small>
                </button>
              ))}
              <label
                aria-label="Use dimensions from an uploaded image or video"
                className={styles.canvasUploadCard}
                data-selected={canvasPreset === 'upload'}
              >
                <input
                  accept="image/*,video/*"
                  onChange={(event) => {
                    const file = event.target.files?.[0]
                    event.currentTarget.value = ''
                    if (file) void selectUploadedCanvas(file)
                  }}
                  type="file"
                />
                <span>UPLOAD</span>
                <strong>Image / video frame</strong>
                <small>{canvasUploadName || 'Read local media dimensions'}</small>
              </label>
            </div>

            {(canvasPreset === 'custom' || canvasPreset === 'upload') && (
              <div className={styles.customCanvasFields}>
                <label>
                  <span>Width</span>
                  <input min={64} max={16384} onChange={(event) => setCustomWidth(Number(event.target.value))} type="number" value={customWidth} />
                </label>
                <span>×</span>
                <label>
                  <span>Height</span>
                  <input min={64} max={16384} onChange={(event) => setCustomHeight(Number(event.target.value))} type="number" value={customHeight} />
                </label>
                <em>px</em>
              </div>
            )}

            {canvasPreset === 'media' && (
              <label className={styles.field}>
                <span>Use dimensions from scoped current media</span>
                <select onChange={(event) => setCanvasMediaId(event.target.value)} value={canvasMediaId}>
                  <option value="">Choose media…</option>
                  {canvasMedia.map((asset) => (
                    <option key={asset.id} value={asset.id}>
                      {asset.summary ?? asset.mode} · {asset.originalVariant?.width} × {asset.originalVariant?.height}
                    </option>
                  ))}
                </select>
              </label>
            )}

            <p className={styles.scopeNotice}>
              <StudioV3Icon name="lock" />
              Local media is read only to measure the canvas. This step does not upload, generate, or spend.
            </p>

            <div className={styles.projectSetupActions}>
              <button className={styles.secondaryButton} onClick={resetProjectSetup} type="button">Finish later</button>
              <button
                className={styles.primaryButton}
                disabled={creatingProject || (canvasPreset === 'media' && !canvasMediaId)}
                onClick={() => void openCreatedProject()}
                type="button"
              >
                {creatingProject ? 'Opening editor…' : 'Open canvas in editor'}
                <StudioV3Icon name="arrow" />
              </button>
            </div>
          </div>
        </section>
      </div>
    )
  }

  return (
    <div className={styles.page}>
      <header className={styles.homeHero}>
        <div>
          <span className={styles.eyebrow}>ALMA Creative Studio</span>
          <h1>What are we making today?</h1>
          <p>
            {activeBrand?.name ?? 'Signed-in workspace'} · create, organize, review, and finish every brand asset in one place.
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
      <details className={styles.scopeDetails}>
        <summary><StudioV3Icon name="lock" /> Workspace security</summary>
        <p>
          Brand, project, Gallery, recipe, and identity data stay inside the selected workspace.
          Access is verified by the server ({STUDIO_V3_SCOPE_BOUNDARY.gallery}).
        </p>
      </details>

      <section aria-labelledby="studio-create-heading" className={styles.section}>
        <div className={styles.sectionHeading}>
          <div>
            <span className={styles.eyebrow}>Create</span>
            <h2 id="studio-create-heading">Start creating</h2>
          </div>
          <div className={styles.sectionActions}>
            <span className={styles.sectionMeta}>Nothing is spent without confirmation</span>
            <button
              className={styles.primaryButton}
              disabled={!activeBrand || activeBrand.role !== 'owner'}
              onClick={() => setProjectSetupOpen(true)}
              type="button"
            >
              <StudioV3Icon name="project" />
              {activeBrand?.role === 'owner' ? 'New project' : 'Owner creates projects'}
            </button>
          </div>
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
            <span className={styles.eyebrow}>Your workspace</span>
            <h2 id="studio-inventory-heading">Recent assets and saved identities</h2>
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
              <button
                key={project.id}
                onClick={() => onNavigate({
                  id: 'desk',
                  desk: 'projects',
                  projectId: project.id,
                })}
                type="button"
              >
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

      {projectSetupOpen && (
        <div
          aria-labelledby="studio-project-setup-title"
          aria-modal="true"
          className={styles.projectSetupBackdrop}
          role="dialog"
        >
          <section className={styles.projectSetupDialog}>
            <header>
              <div>
                <span className={styles.eyebrow}>NEW PRODUCTION PROJECT</span>
                <h2 id="studio-project-setup-title">Name the project first</h2>
                <p>The project opens before any canvas decision. Nothing is generated.</p>
              </div>
              <button
                aria-label="Close project setup"
                className={styles.iconButton}
                onClick={resetProjectSetup}
                type="button"
              >
                <StudioV3Icon name="close" />
              </button>
            </header>

            <div className={styles.projectNameStep}>
              <label className={styles.field}>
                <span>Project name <em>Required</em></span>
                <input
                  autoFocus
                  maxLength={160}
                  onChange={(event) => setProjectName(event.target.value)}
                  placeholder="Eid campaign · Panjabi launch"
                  value={projectName}
                />
              </label>
              <label className={styles.field}>
                <span>Description <em>Optional</em></span>
                <textarea
                  maxLength={500}
                  onChange={(event) => setProjectDescription(event.target.value)}
                  placeholder="What this production project will deliver…"
                  value={projectDescription}
                />
              </label>
              <div className={styles.projectSetupActions}>
                <button className={styles.secondaryButton} onClick={resetProjectSetup} type="button">Cancel</button>
                <button
                  className={styles.primaryButton}
                  disabled={!projectName.trim() || creatingProject}
                  onClick={() => void createNamedProject()}
                  type="button"
                >
                  {creatingProject ? 'Creating project…' : 'Create & open project'}
                  <StudioV3Icon name="arrow" />
                </button>
              </div>
            </div>
          </section>
        </div>
      )}
    </div>
  )
}
