'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import styles from './CreativeStudioEnterpriseDemo.module.css'
import { CreativeStudioWorkspaceShell } from './CreativeStudioWorkspaceShell'
import { StudioV2Icon, type StudioIconName } from './StudioV2Icon'
import type { StudioV3Navigate } from './studio-v3-navigation'
import {
  GALLERY_ASSETS,
  GALLERY_TYPES,
  type GalleryAssetFixture,
  type GalleryAssetType,
  type GalleryDensity,
} from './studio-v3-fixtures'

type CreativeStudioGalleryProps = {
  initialType?: GalleryAssetType | 'all'
  onNavigate: StudioV3Navigate
}

type GalleryView = 'recent' | 'approved' | 'review' | 'archived'
type GallerySort = 'newest' | 'name' | 'status' | 'resolution'

const densityOptions: ReadonlyArray<{
  id: GalleryDensity
  label: string
  icon: StudioIconName
}> = [
  { id: 'large', label: 'Large thumbnails', icon: 'grid-large' },
  { id: 'comfortable', label: 'Comfortable grid', icon: 'projects' },
  { id: 'compact', label: 'Compact grid', icon: 'grid' },
  { id: 'list', label: 'Dense list', icon: 'list' },
] as const

function AssetArtwork({ asset }: { asset: GalleryAssetFixture }) {
  return (
    <span
      aria-hidden="true"
      className={`${styles.v3GalleryArtwork} ${styles[`v3Tone_${asset.tone}`]}`}
    >
      <span>ALMA</span>
      <i />
      <b />
      {asset.type === 'video' && (
        <em>
          <StudioV2Icon name="play" size={14} />
        </em>
      )}
      {asset.type === 'audio' || asset.type === 'voice' ? (
        <svg viewBox="0 0 120 28">
          <path d="M2 15 9 8l7 14 8-18 8 15 8-10 8 13 8-16 8 12 8-7 8 12 8-17 8 14 8-9 8 5" />
        </svg>
      ) : null}
      {asset.type === 'avatar' && <span className={styles.v3GalleryAvatarFace} />}
    </span>
  )
}

function AssetStatus({ asset }: { asset: GalleryAssetFixture }) {
  return (
    <span
      className={`${styles.v3GalleryStatus} ${styles[`v3GalleryStatus_${asset.status}`]}`}
    >
      <i />
      {asset.statusLabel}
    </span>
  )
}

function SelectionPanel({
  asset,
  onClose,
  onNavigate,
}: {
  asset: GalleryAssetFixture
  onClose: () => void
  onNavigate: StudioV3Navigate
}) {
  const canFinish = asset.type === 'image' || asset.type === 'video'
  const canUseInImage = asset.type === 'image' || asset.type === 'avatar'
  const canUseInVideo = asset.type === 'image' || asset.type === 'video' || asset.type === 'avatar'

  return (
    <aside aria-label={`Selected asset ${asset.title}`} className={styles.v3GallerySelection}>
      <header>
        <div>
          <span className={styles.eyebrow}>SELECTED ASSET</span>
          <h2>{asset.title}</h2>
          <p>{asset.subtype} · {asset.project}</p>
        </div>
        <button aria-label="Close selected asset" onClick={onClose} type="button">
          <StudioV2Icon name="close" size={17} />
        </button>
      </header>

      <AssetArtwork asset={asset} />

      <dl className={styles.v3AssetFacts}>
        <div>
          <dt>State</dt>
          <dd><AssetStatus asset={asset} /></dd>
        </div>
        <div>
          <dt>Provider / path</dt>
          <dd>{asset.provider}</dd>
        </div>
        <div>
          <dt>Delivered truth</dt>
          <dd>{asset.resolution} · {asset.aspect}</dd>
        </div>
        <div>
          <dt>Source lineage</dt>
          <dd>{asset.source}</dd>
        </div>
        <div>
          <dt>Cost record</dt>
          <dd>{asset.cost}</dd>
        </div>
        <div>
          <dt>Activity</dt>
          <dd>{asset.date}</dd>
        </div>
      </dl>

      {asset.status === 'qc_failed' && (
        <div className={styles.v3SelectionWarning}>
          <StudioV2Icon name="lock" size={16} />
          <span>
            <strong>Promotion blocked by QC</strong>
            <small>Repair or retry is required before Finishing, Reel or publish eligibility.</small>
          </span>
        </div>
      )}

      <div className={styles.v3SelectionActions}>
        {canUseInImage && (
          <button
            className={styles.secondaryButton}
            onClick={() =>
              onNavigate(
                asset.type === 'avatar'
                  ? { id: 'image-lab', avatarId: asset.id === 'asset-11' ? 'maruf-test' : 'father-01' }
                  : { id: 'image-lab', sourceAssetId: asset.id },
              )
            }
            type="button"
          >
            <StudioV2Icon name="image" size={16} />
            Use in Image Lab
          </button>
        )}
        {canUseInVideo && (
          <button
            className={styles.secondaryButton}
            onClick={() =>
              onNavigate(
                asset.type === 'avatar'
                  ? { id: 'video-lab', avatarId: asset.id === 'asset-11' ? 'maruf-test' : 'father-01' }
                  : { id: 'video-lab', sourceAssetId: asset.id },
              )
            }
            type="button"
          >
            <StudioV2Icon name="video" size={16} />
            Use in Video Lab
          </button>
        )}
        {canFinish && (
          <button
            className={styles.primaryButton}
            disabled={asset.status === 'qc_failed'}
            onClick={() => onNavigate({ id: 'finishing', assetId: asset.id })}
            type="button"
          >
            <StudioV2Icon name="palette" size={16} />
            Open Finishing
          </button>
        )}
        {asset.type === 'project' && (
          <button
            className={styles.primaryButton}
            onClick={() => onNavigate({ id: 'editor', kind: 'video' })}
            type="button"
          >
            Open Project Editor
            <StudioV2Icon name="chevron-right" size={16} />
          </button>
        )}
      </div>

      <p className={styles.v3SelectionBoundary}>
        No upload, download, provider request, review write or external effect is connected.
      </p>
    </aside>
  )
}

export function CreativeStudioGallery({
  initialType = 'all',
  onNavigate,
}: CreativeStudioGalleryProps) {
  const [view, setView] = useState<GalleryView>('recent')
  const [type, setType] = useState<GalleryAssetType | 'all'>(initialType)
  const [status, setStatus] = useState('all')
  const [provider, setProvider] = useState('all')
  const [aspect, setAspect] = useState('all')
  const [sort, setSort] = useState<GallerySort>('newest')
  const [search, setSearch] = useState('')
  const [density, setDensity] = useState<GalleryDensity>('comfortable')
  const [selectedId, setSelectedId] = useState('')
  const [loading, setLoading] = useState(false)
  const refreshTimer = useRef<number | null>(null)

  useEffect(() => {
    try {
      const stored = window.localStorage.getItem('alma-demo-gallery-density')
      if (stored && densityOptions.some((item) => item.id === stored)) {
        setDensity(stored as GalleryDensity)
      }
    } catch {
      // Local preference is optional; the demo remains fully usable without storage.
    }

    return () => {
      if (refreshTimer.current !== null) window.clearTimeout(refreshTimer.current)
    }
  }, [])

  const providers = useMemo(
    () => Array.from(new Set(GALLERY_ASSETS.map((asset) => asset.provider))),
    [],
  )

  const visibleAssets = useMemo(() => {
    const normalized = search.trim().toLowerCase()
    const filtered = GALLERY_ASSETS.filter((asset) => {
      if (type !== 'all' && asset.type !== type) return false
      if (status !== 'all' && asset.status !== status) return false
      if (provider !== 'all' && asset.provider !== provider) return false
      if (aspect !== 'all' && asset.aspect !== aspect) return false
      if (view === 'approved' && asset.status !== 'approved') return false
      if (view === 'review' && asset.status !== 'review' && asset.status !== 'qc_failed') return false
      if (view === 'archived' && asset.status !== 'archived') return false
      if (view !== 'archived' && asset.status === 'archived') return false
      if (
        normalized &&
        ![
          asset.title,
          asset.type,
          asset.subtype,
          asset.provider,
          asset.statusLabel,
          asset.project,
          asset.source,
          asset.resolution,
          asset.aspect,
        ]
          .join(' ')
          .toLowerCase()
          .includes(normalized)
      ) {
        return false
      }
      return true
    })

    return [...filtered].sort((a, b) => {
      if (sort === 'name') return a.title.localeCompare(b.title)
      if (sort === 'status') return a.statusLabel.localeCompare(b.statusLabel)
      if (sort === 'resolution') return b.resolution.localeCompare(a.resolution)
      return a.id.localeCompare(b.id)
    })
  }, [aspect, provider, search, sort, status, type, view])

  const selectedAsset = GALLERY_ASSETS.find((asset) => asset.id === selectedId)

  function changeDensity(next: GalleryDensity) {
    setDensity(next)
    try {
      window.localStorage.setItem('alma-demo-gallery-density', next)
    } catch {
      // Persistence is a convenience only.
    }
  }

  function refreshFixtures() {
    if (refreshTimer.current !== null) window.clearTimeout(refreshTimer.current)
    setLoading(true)
    refreshTimer.current = window.setTimeout(() => {
      setLoading(false)
      refreshTimer.current = null
    }, 650)
  }

  return (
    <CreativeStudioWorkspaceShell
      active="gallery"
      description="Search and govern every image, video, audio, voice, identity and project without sacrificing density or provenance."
      eyebrow="LIBRARY / CATALOG"
      icon="assets"
      onNavigate={onNavigate}
      title="Gallery"
      actions={
        <button className={styles.secondaryButton} onClick={refreshFixtures} type="button">
          <StudioV2Icon name="refresh" size={16} />
          Refresh fixtures
        </button>
      }
    >
      <div className={styles.v3GalleryShell}>
        <aside className={styles.v3GallerySidebar} aria-label="Gallery media types">
          <div>
            <span className={styles.eyebrow}>COLLECTION</span>
            <strong>ALMA Lifestyle</strong>
            <small>28 demo records · brand isolated</small>
          </div>
          <nav>
            {GALLERY_TYPES.map((item) => (
              <button
                aria-current={type === item.id ? 'page' : undefined}
                className={type === item.id ? styles.v3GalleryTypeActive : undefined}
                key={item.id}
                onClick={() => setType(item.id)}
                type="button"
              >
                <StudioV2Icon name={item.icon} size={17} />
                <span>{item.label}</span>
                <em>
                  {item.id === 'all'
                    ? GALLERY_ASSETS.length
                    : GALLERY_ASSETS.filter((asset) => asset.type === item.id).length}
                </em>
              </button>
            ))}
          </nav>
          <div className={styles.v3CatalogBoundary}>
            <StudioV2Icon name="lock" size={15} />
            <span>
              <strong>ERP catalog linked</strong>
              <small>Source product code and lineage are immutable.</small>
            </span>
          </div>
        </aside>

        <section aria-labelledby="gallery-results-title" className={styles.v3GalleryMain}>
          <header className={styles.v3GalleryToolbar}>
            <div className={styles.v3GalleryViews} role="tablist" aria-label="Gallery views">
              {(
                [
                  ['recent', 'Recent'],
                  ['approved', 'Approved'],
                  ['review', 'Review'],
                  ['archived', 'Archived'],
                ] as const
              ).map(([id, label]) => (
                <button
                  aria-selected={view === id}
                  className={view === id ? styles.v3GalleryViewActive : undefined}
                  key={id}
                  onClick={() => setView(id)}
                  role="tab"
                  type="button"
                >
                  {label}
                </button>
              ))}
            </div>

            <label className={styles.v3GallerySearch}>
              <StudioV2Icon name="search" size={17} />
              <span className={styles.srOnly}>Search Gallery</span>
              <input
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Search name, code, provider or project"
                value={search}
              />
            </label>
          </header>

          <div className={styles.v3GalleryFilters}>
            <label>
              <span>Status</span>
              <select onChange={(event) => setStatus(event.target.value)} value={status}>
                <option value="all">All states</option>
                <option value="ready">Ready</option>
                <option value="approved">Approved</option>
                <option value="review">Needs review</option>
                <option value="draft">Draft</option>
                <option value="qc_failed">QC failed</option>
              </select>
            </label>
            <label>
              <span>Provider / path</span>
              <select onChange={(event) => setProvider(event.target.value)} value={provider}>
                <option value="all">All providers</option>
                {providers.map((item) => <option key={item}>{item}</option>)}
              </select>
            </label>
            <label>
              <span>Aspect</span>
              <select onChange={(event) => setAspect(event.target.value)} value={aspect}>
                <option value="all">All aspects</option>
                {['4:5', '1:1', '9:16', '16:9', 'Mixed'].map((item) => (
                  <option key={item}>{item}</option>
                ))}
              </select>
            </label>
            <label>
              <span>Sort</span>
              <select
                onChange={(event) => setSort(event.target.value as GallerySort)}
                value={sort}
              >
                <option value="newest">Newest first</option>
                <option value="name">Name</option>
                <option value="status">Status</option>
                <option value="resolution">Resolution</option>
              </select>
            </label>
            <div className={styles.v3DensityControl} role="group" aria-label="Gallery density">
              {densityOptions.map((item) => (
                <button
                  aria-label={item.label}
                  aria-pressed={density === item.id}
                  className={density === item.id ? styles.v3DensityActive : undefined}
                  key={item.id}
                  onClick={() => changeDensity(item.id)}
                  title={item.label}
                  type="button"
                >
                  <StudioV2Icon name={item.icon} size={16} />
                </button>
              ))}
            </div>
          </div>

          <div className={styles.v3GalleryResultHeading}>
            <div>
              <h2 id="gallery-results-title">
                {GALLERY_TYPES.find((item) => item.id === type)?.label ?? 'Assets'}
              </h2>
              <p>{visibleAssets.length} results · {density} density · source aspect preserved</p>
            </div>
            <span>
              <StudioV2Icon name="check" size={14} />
              Test artifacts hidden by default
            </span>
          </div>

          {loading ? (
            <div className={styles.v3GalleryLoading} role="status">
              <span className={styles.srOnly}>Refreshing Gallery fixtures</span>
              {Array.from({ length: density === 'compact' ? 12 : 8 }).map((_, index) => (
                <span key={index} />
              ))}
            </div>
          ) : visibleAssets.length ? (
            <div
              className={`${styles.v3GalleryGrid} ${styles[`v3GalleryGrid_${density}`]}`}
            >
              {visibleAssets.map((asset) => (
                <article
                  className={`${styles.v3GalleryCard} ${
                    selectedId === asset.id ? styles.v3GalleryCardSelected : ''
                  }`}
                  key={asset.id}
                >
                  <button
                    aria-label={`Select ${asset.title}`}
                    className={styles.v3GalleryCardTarget}
                    onClick={() => setSelectedId(asset.id)}
                    type="button"
                  >
                    <AssetArtwork asset={asset} />
                  </button>
                  <div className={styles.v3GalleryCardBody}>
                    <div>
                      <span>{asset.type} · {asset.subtype}</span>
                      <h3>{asset.title}</h3>
                      <p>{asset.provider}</p>
                    </div>
                    <button
                      aria-label={`More actions for ${asset.title}`}
                      onClick={() => setSelectedId(asset.id)}
                      type="button"
                    >
                      <StudioV2Icon name="more" size={17} />
                    </button>
                  </div>
                  <footer>
                    <AssetStatus asset={asset} />
                    <span>{asset.resolution}</span>
                    <time>{asset.date}</time>
                  </footer>
                </article>
              ))}
            </div>
          ) : (
            <div className={styles.v3GalleryEmpty}>
              <span>
                <StudioV2Icon name="search" size={24} />
              </span>
              <h3>No assets match this view</h3>
              <p>Clear search or widen the status, provider and aspect filters.</p>
              <button
                className={styles.secondaryButton}
                onClick={() => {
                  setSearch('')
                  setStatus('all')
                  setProvider('all')
                  setAspect('all')
                  setView('recent')
                }}
                type="button"
              >
                Reset filters
              </button>
            </div>
          )}
        </section>

        {selectedAsset && (
          <SelectionPanel
            asset={selectedAsset}
            onClose={() => setSelectedId('')}
            onNavigate={onNavigate}
          />
        )}
      </div>
    </CreativeStudioWorkspaceShell>
  )
}
