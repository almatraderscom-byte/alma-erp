'use client'

/* eslint-disable @next/next/no-img-element */
/* eslint-disable jsx-a11y/media-has-caption */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { StudioBrandProfile } from '@/agent/components/creative-studio/studio-api'
import {
  libraryItemFromGallery,
  libraryItemFromModel,
  libraryItemFromProject,
  libraryItemFromVoice,
  sortStudioV3Library,
  type StudioV3GalleryDensity,
  type StudioV3LibraryItem,
  type StudioV3Lifecycle,
} from '@/agent/components/creative-studio-v3/gallery-model'
import { StudioV3Icon } from '@/agent/components/creative-studio-v3/StudioV3Icon'
import {
  STUDIO_V3_SCOPE_BOUNDARY,
  type CreativeStudioV3ProductionPort,
} from '@/agent/components/creative-studio-v3/ports'
import type {
  CreativeStudioV3LibraryType,
  CreativeStudioV3Navigate,
  CreativeStudioV3ReviewTarget,
} from '@/agent/components/creative-studio-v3/types'
import {
  exactReviewLibraryItem,
  STUDIO_V3_GALLERY_CATEGORIES,
  STUDIO_V3_GALLERY_DENSITIES,
  STUDIO_V3_LIFECYCLES,
} from '@/agent/components/creative-studio-v3/ui-contract'
import styles from '@/agent/components/creative-studio-v3/creative-studio-v3.module.css'
import type { StudioProjectSummary } from '@/lib/creative-studio/project-contract'

function serverState(lifecycle: StudioV3Lifecycle) {
  if (lifecycle === 'approved') return 'ready' as const
  if (lifecycle === 'review') return 'review' as const
  return 'all' as const
}

function MediaPreview({ item }: { item: StudioV3LibraryItem }) {
  if (item.type === 'video' && item.previewUrl) return <video muted playsInline src={item.previewUrl} />
  if (item.previewUrl) return <img alt="" src={item.previewUrl} />
  return (
    <span className={styles.libraryFallback}>
      <StudioV3Icon name={item.type === 'audio' ? 'audio' : item.type === 'voice' ? 'voice' : item.type === 'avatar' ? 'voice' : item.type === 'project' ? 'project' : 'image'} />
    </span>
  )
}

function formatWhen(value: string | null): string {
  if (!value) return 'Date unavailable'
  const date = new Date(value)
  return Number.isFinite(date.getTime())
    ? new Intl.DateTimeFormat('en-BD', { month: 'short', day: 'numeric', year: 'numeric' }).format(date)
    : 'Date unavailable'
}

export function StudioV3Gallery({
  activeBrand,
  activeProject,
  initialType = 'all',
  onNavigate,
  port,
  reviewTarget,
}: {
  activeBrand: StudioBrandProfile | null
  activeProject: StudioProjectSummary | null
  initialType?: CreativeStudioV3LibraryType
  onNavigate: CreativeStudioV3Navigate
  port: CreativeStudioV3ProductionPort
  reviewTarget?: CreativeStudioV3ReviewTarget
}) {
  const [category, setCategory] = useState<CreativeStudioV3LibraryType>(initialType)
  const [lifecycle, setLifecycle] = useState<StudioV3Lifecycle>('recent')
  const [density, setDensity] = useState<StudioV3GalleryDensity>('compact')
  const [sort, setSort] = useState<'newest' | 'oldest' | 'name' | 'cost'>('newest')
  const [providerFilter, setProviderFilter] = useState('all')
  const [aspectFilter, setAspectFilter] = useState('all')
  const [searchDraft, setSearchDraft] = useState('')
  const [search, setSearch] = useState('')
  const [items, setItems] = useState<StudioV3LibraryItem[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [hasMore, setHasMore] = useState(false)
  const [total, setTotal] = useState(0)
  const [issues, setIssues] = useState<string[]>([])
  const loadSequence = useRef(0)
  const reviewLocked = Boolean(reviewTarget)

  const load = useCallback(async () => {
    const sequence = ++loadSequence.current
    setLoading(true)
    setIssues([])
    const wantsGallery = Boolean(reviewTarget)
      || ['all', 'image', 'video', 'audio'].includes(category)
    const requests: Array<Promise<unknown>> = []
    const keys: string[] = []
    if (wantsGallery) {
      requests.push(port.listGallery({
        media: reviewTarget
          ? 'all'
          : category === 'all'
            ? 'all'
            : category as 'image' | 'video' | 'audio',
        state: reviewTarget ? 'all' : serverState(lifecycle),
        query: reviewTarget ? '' : search,
        limit: 48,
        archived: reviewTarget ? false : lifecycle === 'archived',
        ...(reviewTarget
          ? {
              projectAssetId: reviewTarget.projectAssetId,
              assetVersionId: reviewTarget.currentVersionId,
              reviewSequence: reviewTarget.expectedSequence,
            }
          : {}),
      }, reviewTarget?.brandProfileId ?? activeBrand?.brandProfileId, reviewTarget?.projectId ?? activeProject?.id))
      keys.push('gallery')
    }
    if (!reviewTarget && (category === 'all' || category === 'voice')) { requests.push(port.listVoices(activeBrand?.brandProfileId, activeProject?.id)); keys.push('voice') }
    if (!reviewTarget && (category === 'all' || category === 'avatar')) { requests.push(port.listModels(activeBrand?.brandProfileId, activeProject?.id)); keys.push('avatar') }
    if (!reviewTarget && (category === 'all' || category === 'project')) { requests.push(port.listProjects(activeBrand?.brandProfileId)); keys.push('project') }

    const results = await Promise.allSettled(requests)
    if (sequence !== loadSequence.current) return
    const next: StudioV3LibraryItem[] = []
    const nextIssues: string[] = []
    let galleryCursor: string | null = null
    let galleryMore = false
    let galleryTotal = 0
    results.forEach((result, index) => {
      const key = keys[index]
      if (result.status === 'rejected') {
        nextIssues.push(`${key}: ${result.reason instanceof Error ? result.reason.message : 'unavailable'}`)
        return
      }
      if (key === 'gallery') {
        const page = result.value as Awaited<ReturnType<typeof port.listGallery>>
        next.push(...page.items.map(libraryItemFromGallery))
        galleryCursor = page.nextCursor
        galleryMore = page.hasMore
        galleryTotal = page.total
      } else if (key === 'voice') {
        next.push(...(result.value as Awaited<ReturnType<typeof port.listVoices>>).map(libraryItemFromVoice))
      } else if (key === 'avatar') {
        next.push(...(result.value as Awaited<ReturnType<typeof port.listModels>>).map(libraryItemFromModel))
      } else if (key === 'project') {
        next.push(...(result.value as Awaited<ReturnType<typeof port.listProjects>>).map(libraryItemFromProject))
      }
    })

    setItems(next)
    setNextCursor(galleryCursor)
    setHasMore(galleryMore)
    setTotal(galleryTotal || next.length)
    setIssues(nextIssues)
    const exactReviewItem = reviewTarget
      ? exactReviewLibraryItem(next, reviewTarget)
      : null
    setSelectedId((current) =>
      reviewTarget
        ? exactReviewItem?.id ?? null
        : current && next.some((item) => item.id === current)
          ? current
          : next[0]?.id ?? null)
    setLoading(false)
  }, [
    activeBrand?.brandProfileId,
    activeProject?.id,
    category,
    lifecycle,
    port,
    reviewTarget,
    search,
  ])

  useEffect(() => {
    void load()
    return () => { loadSequence.current += 1 }
  }, [activeBrand?.brandProfileId, activeProject?.id, load])

  const loadMore = async () => {
    if (
      reviewTarget
      || !nextCursor
      || loadingMore
      || !['all', 'image', 'video', 'audio'].includes(category)
    ) return
    setLoadingMore(true)
    try {
      const page = await port.listGallery({
        cursor: nextCursor,
        media: category === 'all' ? 'all' : category as 'image' | 'video' | 'audio',
        state: serverState(lifecycle),
        query: search,
        limit: 48,
        archived: lifecycle === 'archived',
      }, activeBrand?.brandProfileId, activeProject?.id)
      const additions = page.items.map(libraryItemFromGallery)
      setItems((current) => {
        const ids = new Set(current.map((item) => item.id))
        return [...current, ...additions.filter((item) => !ids.has(item.id))]
      })
      setNextCursor(page.nextCursor)
      setHasMore(page.hasMore)
    } catch (reason) {
      setIssues((current) => [...current, reason instanceof Error ? reason.message : 'Next Gallery page unavailable'])
    } finally {
      setLoadingMore(false)
    }
  }

  const providers = useMemo(() => [...new Set(items.map((item) => item.provider).filter((value): value is string => Boolean(value)))].sort(), [items])
  const aspects = useMemo(() => [...new Set(items.map((item) => item.aspect).filter((value): value is string => Boolean(value)))].sort(), [items])
  const visible = useMemo(() => {
    if (reviewTarget) {
      const exact = exactReviewLibraryItem(items, reviewTarget)
      return exact ? [exact] : []
    }
    const needle = search.toLocaleLowerCase('bn-BD')
    const filtered = items.filter((item) => {
      if (category !== 'all' && item.type !== category) return false
      if (lifecycle !== 'recent' && item.lifecycle !== lifecycle) return false
      if (providerFilter !== 'all' && item.provider !== providerFilter) return false
      if (aspectFilter !== 'all' && item.aspect !== aspectFilter) return false
      if (needle && !`${item.title} ${item.subtitle} ${item.provider ?? ''}`.toLocaleLowerCase('bn-BD').includes(needle)) return false
      return true
    })
    return sortStudioV3Library(filtered, sort)
  }, [aspectFilter, category, items, lifecycle, providerFilter, reviewTarget, search, sort])
  const selected = visible.find((item) => item.id === selectedId) ?? visible[0] ?? null

  const selectCategory = (value: CreativeStudioV3LibraryType) => {
    if (reviewLocked) return
    setCategory(value)
    setProviderFilter('all')
    setAspectFilter('all')
  }

  const primaryAction = (item: StudioV3LibraryItem) => {
    if (item.type === 'image') onNavigate({ id: 'image-lab', sourceAssetId: item.id })
    else if (item.type === 'video') onNavigate({ id: 'finishing', assetId: item.id })
    else if (item.type === 'avatar') onNavigate({ id: 'image-lab', avatarId: item.id })
    else if (item.type === 'voice') onNavigate({ id: 'desk', desk: 'voice' })
    else if (item.type === 'audio') onNavigate({ id: 'desk', desk: 'audio' })
    else onNavigate({ id: 'desk', desk: 'projects' })
  }

  return (
    <div className={styles.page}>
      <header className={styles.workspaceHeader}>
        <div className={styles.workspaceTitle}>
          <span><StudioV3Icon name="gallery" /></span>
          <div>
            <span className={styles.eyebrow}>Library</span>
            <h1>Gallery</h1>
            <p>Production media, identity and project context with truthful lifecycle and artifact metadata.</p>
          </div>
        </div>
        <span className={styles.serverBadge}><StudioV3Icon name="lock" /> {total} server result{total === 1 ? '' : 's'}</span>
      </header>

      <section aria-label="Gallery controls" className={styles.galleryControls}>
        <div className={styles.galleryTabs}>
          {STUDIO_V3_GALLERY_CATEGORIES.map((item) => <button aria-pressed={category === item.id} disabled={reviewLocked} key={item.id} onClick={() => selectCategory(item.id)} type="button">{item.label}</button>)}
        </div>
        <div className={styles.lifecycleTabs}>
          {STUDIO_V3_LIFECYCLES.map((item) => <button aria-pressed={lifecycle === item.id} disabled={reviewLocked} key={item.id} onClick={() => setLifecycle(item.id)} type="button">{item.label}</button>)}
        </div>
        <form className={styles.gallerySearch} onSubmit={(event) => { event.preventDefault(); if (!reviewLocked) setSearch(searchDraft.trim()) }}>
          <StudioV3Icon name="search" />
          <input aria-label="Search Gallery" disabled={reviewLocked} onChange={(event) => setSearchDraft(event.target.value)} placeholder="Search title, product code, mode or provider" type="search" value={searchDraft} />
          <button disabled={reviewLocked} type="submit">Search</button>
        </form>
        <div className={styles.galleryFilters}>
          <label><StudioV3Icon name="filter" /><span className="sr-only">Provider filter</span><select aria-label="Provider filter" disabled={reviewLocked} onChange={(event) => setProviderFilter(event.target.value)} value={providerFilter}><option value="all">All providers</option>{providers.map((value) => <option key={value}>{value}</option>)}</select></label>
          <label><span className="sr-only">Aspect filter</span><select aria-label="Aspect filter" disabled={reviewLocked} onChange={(event) => setAspectFilter(event.target.value)} value={aspectFilter}><option value="all">All aspects</option>{aspects.map((value) => <option key={value}>{value}</option>)}</select></label>
          <label><span className="sr-only">Sort Gallery</span><select aria-label="Sort Gallery" disabled={reviewLocked} onChange={(event) => setSort(event.target.value as typeof sort)} value={sort}><option value="newest">Newest</option><option value="oldest">Oldest</option><option value="name">Name</option><option value="cost">Cost</option></select></label>
          <div aria-label="Gallery density" className={styles.densityControl}>{STUDIO_V3_GALLERY_DENSITIES.map((item) => <button aria-label={`${item.label} density`} aria-pressed={density === item.id} key={item.id} onClick={() => setDensity(item.id)} title={item.label} type="button">{item.id === 'list' ? <StudioV3Icon name="list" /> : <StudioV3Icon name="grid" />}<span>{item.label}</span></button>)}</div>
          <button aria-label="Refresh Gallery" className={styles.iconButton} onClick={() => void load()} type="button"><StudioV3Icon name="refresh" /></button>
        </div>
      </section>

      {reviewTarget && (
        <div className={styles.scopeNotice} role="status">
          <StudioV3Icon name="review" />
          <span>
            Exact Review handoff · asset {reviewTarget.projectAssetId} · version {reviewTarget.currentVersionId} · sequence {reviewTarget.expectedSequence}. Gallery will not substitute another asset or current version.
          </span>
        </div>
      )}
      {lifecycle === 'archived' && (
        <div className={styles.scopeNotice} role="status">
          <StudioV3Icon name="archive" />
          <span>Archived results come from canonical project asset versions and durable archive receipts for the active brand/project.</span>
        </div>
      )}
      <p className={styles.scopeNotice}>
        <StudioV3Icon name="lock" />
        Brand or project changes reload every lane through canonical project-asset/version
        queries authorized against the signed-in actor. Legacy unscoped media never enters this
        result ({STUDIO_V3_SCOPE_BOUNDARY.gallery}).
      </p>
      {issues.length > 0 && <div className={styles.inlineWarning}><StudioV3Icon name="warning" /><span>{issues.join(' · ')}</span></div>}

      <div className={selected ? styles.galleryLayout : styles.galleryLayoutFull}>
        <section aria-busy={loading} aria-label="Gallery results" className={styles.galleryResults}>
          {loading ? (
            <div className={styles.gallerySkeleton} data-density={density}>{Array.from({ length: 12 }).map((_, index) => <span key={index} />)}</div>
          ) : visible.length === 0 ? (
            <div className={styles.galleryEmpty}>
              <StudioV3Icon name={lifecycle === 'archived' ? 'archive' : 'gallery'} />
              <h2>No production records match this view.</h2>
              <p>Change category/lifecycle/filter, or create a new asset through a gated Lab.</p>
            </div>
          ) : (
            <>
              <div className={styles.libraryGrid} data-density={density}>
                {visible.map((item) => (
                  <button
                    aria-pressed={selected?.id === item.id}
                    className={styles.libraryCard}
                    key={`${item.source}:${item.id}`}
                    onClick={() => setSelectedId(item.id)}
                    type="button"
                  >
                    <span className={styles.libraryArt}><MediaPreview item={item} /><em data-lifecycle={item.lifecycle}>{item.status.replaceAll('_', ' ')}</em></span>
                    <span className={styles.libraryCopy}>
                      <strong>{item.title}</strong>
                      <small>{item.subtitle}</small>
                      <span><em>{item.dimensions ?? item.aspect ?? item.type}</em><em>{formatWhen(item.createdAt)}</em></span>
                    </span>
                  </button>
                ))}
              </div>
              {hasMore && <button className={styles.loadMore} disabled={loadingMore} onClick={() => void loadMore()} type="button">{loadingMore ? 'Loading…' : 'Load more production assets'}</button>}
            </>
          )}
        </section>

        {selected && (
          <aside aria-label="Selected asset detail" className={styles.assetDetail}>
            <header>
              <div><span className={styles.eyebrow}>{selected.type}</span><h2>{selected.title}</h2></div>
              <button aria-label="Close asset detail" onClick={() => setSelectedId(null)} type="button"><StudioV3Icon name="close" /></button>
            </header>
            <div className={styles.detailPreview}><MediaPreview item={selected} /></div>
            <dl className={styles.detailFacts}>
              <div><dt>Lifecycle</dt><dd>{selected.lifecycle} · {selected.status}</dd></div>
              <div><dt>Provider/model</dt><dd>{selected.provider ?? 'Not applicable'}</dd></div>
              <div><dt>Delivered dimensions</dt><dd>{selected.dimensions ?? 'No verified descriptor on this record'}</dd></div>
              <div><dt>Requested aspect</dt><dd>{selected.aspect ?? 'Not recorded'}</dd></div>
              <div><dt>Cost</dt><dd>{selected.costUsd === null ? 'Not recorded' : `$${selected.costUsd.toFixed(3)}`}</dd></div>
              <div><dt>Publishable</dt><dd>{selected.publishable ? 'Server says yes' : 'No'}</dd></div>
              <div><dt>Created/updated</dt><dd>{formatWhen(selected.createdAt)}</dd></div>
              {reviewTarget && (
                <>
                  <div><dt>Review asset</dt><dd>{reviewTarget.projectAssetId}</dd></div>
                  <div><dt>Pinned version</dt><dd>{reviewTarget.currentVersionId}</dd></div>
                  <div><dt>Review sequence</dt><dd>{reviewTarget.expectedSequence}</dd></div>
                </>
              )}
            </dl>
            {selected.galleryItem?.referenceReceipt && (
              <div className={styles.referenceReceipt}>
                <StudioV3Icon name={selected.galleryItem.referenceReceipt.allRequiredSent ? 'check' : 'warning'} />
                <div>
                  <strong>Reference receipt</strong>
                  <span>{selected.galleryItem.referenceReceipt.sentCount}/{selected.galleryItem.referenceReceipt.expectedCount} sent · {selected.galleryItem.referenceReceipt.roles.join(', ')}</span>
                </div>
              </div>
            )}
            <div className={styles.detailActions}>
              <button className={styles.primaryButton} onClick={() => primaryAction(selected)} type="button">
                {selected.type === 'image' ? 'Create from asset' : selected.type === 'video' ? 'Open Finishing' : selected.type === 'avatar' ? 'Use identity' : 'Open desk'} <StudioV3Icon name="arrow" />
              </button>
              {selected.type === 'image' && (
                <button className={styles.secondaryButton} onClick={() => onNavigate({ id: 'finishing', assetId: selected.id })} type="button">Finish non-destructively</button>
              )}
            </div>
          </aside>
        )}
      </div>
    </div>
  )
}
