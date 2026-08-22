'use client'

/* eslint-disable @next/next/no-img-element */
/* eslint-disable jsx-a11y/media-has-caption */

import { useEffect, useMemo, useState } from 'react'
import toast from 'react-hot-toast'
import MaskEditor, { type MaskEditorResult } from '@/agent/components/creative-studio/MaskEditor'
import { StudioConfirmationDialog } from '@/agent/components/creative-studio/StudioUi'
import { TimelineLite } from '@/agent/components/creative-studio/TimelineLite'
import { TranscriptEditor } from '@/agent/components/creative-studio/TranscriptEditor'
import type {
  GalleryItem,
  RunPayload,
  StudioBrandProfile,
  StudioRunEstimateClient,
  VideoFinishTemplates,
} from '@/agent/components/creative-studio/studio-api'
import {
  type StudioProjectSummary,
} from '@/lib/creative-studio/project-contract'
import {
  createDefaultVideoEditContract,
  type VideoEditContract,
} from '@/lib/creative-studio/video-edit-contract'
import { StudioV3Icon } from '@/agent/components/creative-studio-v3/StudioV3Icon'
import type { CreativeStudioV3ProductionPort } from '@/agent/components/creative-studio-v3/ports'
import type { CreativeStudioV3Navigate } from '@/agent/components/creative-studio-v3/types'
import styles from '@/agent/components/creative-studio-v3/creative-studio-v3.module.css'

type ImageTool = 'brand' | 'mask'
type VideoTool = 'timeline' | 'motion'

const themes = ['default', 'eid', 'puja', 'boishakh', 'winter'] as const
const layouts = [
  { id: 'lifestyle', label: 'Lifestyle poster' },
  { id: 'model_overlay', label: 'Model overlay' },
  { id: 'product_card', label: 'Product card' },
] as const

function artifactPath(item: GalleryItem | null): string | null {
  return item?.originalVariant?.storagePath ?? item?.storagePath ?? null
}

function ArtifactPreview({ item, url }: { item: GalleryItem | null; url?: string | null }) {
  const source = url ?? item?.previewUrl ?? null
  if (!source) return <span className={styles.libraryFallback}><StudioV3Icon name={item?.type.includes('video') ? 'video' : 'image'} /></span>
  if (item?.type.includes('video')) return <video controls muted playsInline src={source} />
  return <img alt="" src={source} />
}

export function StudioV3Finishing({
  activeBrand,
  activeProject,
  assetId,
  onNavigate,
  port,
}: {
  activeBrand: StudioBrandProfile | null
  activeProject: StudioProjectSummary | null
  assetId?: string
  onNavigate: CreativeStudioV3Navigate
  port: CreativeStudioV3ProductionPort
}) {
  const [media, setMedia] = useState<'image' | 'video'>('image')
  const [imageTool, setImageTool] = useState<ImageTool>('brand')
  const [videoTool, setVideoTool] = useState<VideoTool>('timeline')
  const [images, setImages] = useState<GalleryItem[]>([])
  const [videos, setVideos] = useState<GalleryItem[]>([])
  const [selectedId, setSelectedId] = useState(assetId ?? '')
  const [loading, setLoading] = useState(true)
  const [issues, setIssues] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [resultUrl, setResultUrl] = useState<string | null>(null)
  const [maskRequest, setMaskRequest] = useState<RunPayload | null>(null)
  const [maskEstimate, setMaskEstimate] = useState<StudioRunEstimateClient | null>(null)
  const [maskConfirmOpen, setMaskConfirmOpen] = useState(false)

  const [eyebrow, setEyebrow] = useState('')
  const [headline, setHeadline] = useState('')
  const [offer, setOffer] = useState('')
  const [productCode, setProductCode] = useState('')
  const [productName, setProductName] = useState('')
  const [price, setPrice] = useState('')
  const [layout, setLayout] = useState<(typeof layouts)[number]['id']>('lifestyle')
  const [theme, setTheme] = useState<(typeof themes)[number]>('default')
  const [fit, setFit] = useState<'cover' | 'contain'>('cover')
  const [footer, setFooter] = useState(true)

  const [editContract, setEditContract] = useState<VideoEditContract>(() => createDefaultVideoEditContract(15))
  const [editLoading, setEditLoading] = useState(false)
  const [pricePop, setPricePop] = useState('')
  const [lowerCode, setLowerCode] = useState('')
  const [lowerName, setLowerName] = useState('')
  const [watermark, setWatermark] = useState(true)
  const [endCard, setEndCard] = useState(true)
  const [cta, setCta] = useState('')
  const [countdown, setCountdown] = useState('')

  useEffect(() => {
    let live = true
    setLoading(true)
    void Promise.allSettled([
      port.listGallery(
        { media: 'image', state: 'ready', limit: 48 },
        activeBrand?.brandProfileId,
        activeProject?.id,
      ),
      port.listGallery(
        { media: 'video', state: 'ready', limit: 48 },
        activeBrand?.brandProfileId,
        activeProject?.id,
      ),
    ]).then(([imageResult, videoResult]) => {
      if (!live) return
      const nextIssues: string[] = []
      const imageRows = imageResult.status === 'fulfilled' ? imageResult.value.items : []
      const videoRows = videoResult.status === 'fulfilled' ? videoResult.value.items : []
      if (imageResult.status === 'rejected') nextIssues.push(imageResult.reason instanceof Error ? imageResult.reason.message : 'Image Gallery unavailable')
      if (videoResult.status === 'rejected') nextIssues.push(videoResult.reason instanceof Error ? videoResult.reason.message : 'Video Gallery unavailable')
      setImages(imageRows)
      setVideos(videoRows)
      const requestedImage = imageRows.find((item) => item.id === assetId)
      const requestedVideo = videoRows.find((item) => item.id === assetId)
      if (requestedVideo) {
        setMedia('video')
        setSelectedId(requestedVideo.id)
      } else {
        setMedia('image')
        setSelectedId(requestedImage?.id ?? imageRows[0]?.id ?? videoRows[0]?.id ?? '')
      }
      setIssues(nextIssues)
    }).finally(() => {
      if (live) setLoading(false)
    })
    return () => { live = false }
  }, [activeBrand?.brandProfileId, activeProject?.id, assetId, port])

  const currentItems = media === 'image' ? images : videos
  const selected = currentItems.find((item) => item.id === selectedId) ?? currentItems[0] ?? null
  const selectedPath = artifactPath(selected)
  const ownerActionAvailable = activeBrand?.role === 'owner'
  const selectedScope = useMemo(() => (
    activeBrand
    && activeProject
    && selected?.projectAssetId
    && selected.projectId === activeProject.id
    && selected.brandProfileId === activeBrand.brandProfileId
      ? {
          brandProfileId: activeBrand.brandProfileId,
          projectId: activeProject.id,
          projectAssetId: selected.projectAssetId,
        }
      : null
  ), [activeBrand, activeProject, selected])
  const ownerScopedActionAvailable = Boolean(ownerActionAvailable && selectedScope)
  const maskActionAvailable = Boolean(
    activeBrand
    && activeBrand.role !== 'reviewer'
    && activeProject
    && activeProject.brandProfileId === activeBrand.brandProfileId,
  )

  useEffect(() => {
    if (!ownerScopedActionAvailable || media !== 'video' || !selected?.id || !selectedScope) return
    let live = true
    setEditLoading(true)
    void port.getVideoEditSource(selected.id, selectedScope)
      .then((source) => {
        if (live) setEditContract(source.editContract ?? createDefaultVideoEditContract(source.durationSec))
      })
      .catch((reason) => {
        if (live) setIssues((current) => [...current, reason instanceof Error ? reason.message : 'Timeline source unavailable'])
      })
      .finally(() => {
        if (live) setEditLoading(false)
      })
    return () => { live = false }
  }, [media, ownerScopedActionAvailable, port, selected?.id, selectedScope])

  const switchMedia = (value: 'image' | 'video') => {
    setMedia(value)
    setSelectedId((value === 'image' ? images[0] : videos[0])?.id ?? '')
    setResultUrl(null)
  }

  const finishBrand = async () => {
    if (!selectedPath || !selected) return
    if (!ownerScopedActionAvailable || !selectedScope) {
      toast.error('Finishing requires an owner-accessible canonical asset in the active brand and project.')
      return
    }
    setBusy(true)
    try {
      const result = await port.finishImage({
        storagePath: selectedPath,
        hook: headline.trim(),
        productCode: productCode.trim() || undefined,
        productName: productName.trim() || undefined,
        price: price.trim() || undefined,
        eyebrow: eyebrow.trim() || undefined,
        offer: offer.trim() || undefined,
        mode: layout,
        theme,
        footer,
        fit,
        pendingActionId: selected.id,
        ...selectedScope,
      })
      setResultUrl(result.framedUrl)
      toast.success('Server created a separate branded derivative; the original remains preserved.')
    } catch (reason) {
      toast.error(reason instanceof Error ? reason.message : 'Brand layout was rejected.')
    } finally {
      setBusy(false)
    }
  }

  const runMask = async (result: MaskEditorResult) => {
    if (!selectedPath) return
    if (
      !maskActionAvailable
      || !activeBrand
      || !activeProject
      || !selected
      || !selected.projectAssetId
    ) {
      toast.error('Mask repair requires an editable, canonical project asset in the active brand scope.')
      return
    }
    setBusy(true)
    try {
      const uploaded = await port.uploadMask(result.maskBlob, selectedPath, {
        brandProfileId: activeBrand.brandProfileId,
        projectId: activeProject.id,
        projectAssetId: selected.projectAssetId,
        pendingActionId: selected.id,
      })
      const request: RunPayload = {
        brandProfileId: activeBrand.brandProfileId,
        projectId: activeProject.id,
        productId: activeProject.product?.code,
        sourceAssetIds: [selected.projectAssetId],
        sourcePendingActionId: selected.id,
        studioSurface: 'v3',
        mode: 'edit',
        provider: 'fashn',
        vtonEngine: 'fal_flux_fill',
        sourceImagePath: selectedPath,
        maskPath: uploaded.maskPath,
        maskPreset: result.preset,
        prompt: result.detail,
        baseWidth: uploaded.width,
        baseHeight: uploaded.height,
      }
      const estimate = await port.estimateRun(request, 500)
      setMaskRequest(request)
      setMaskEstimate(estimate)
      setMaskConfirmOpen(true)
    } catch (reason) {
      toast.error(reason instanceof Error ? reason.message : 'Mask repair was rejected.')
    } finally {
      setBusy(false)
    }
  }

  const confirmMask = async () => {
    if (!maskActionAvailable || !maskRequest || !maskEstimate) {
      toast.error('Refresh the exact signed estimate before confirming.')
      return
    }
    setBusy(true)
    try {
      const queued = await port.confirmRun(maskRequest, maskEstimate, {
        maxCostBdt: maskEstimate.maxCostBdt,
      })
      toast.success(`${queued.message} · queued is not complete`)
      setMaskConfirmOpen(false)
      setMaskRequest(null)
      setMaskEstimate(null)
      onNavigate({ id: 'gallery', initialType: 'image' })
    } catch (reason) {
      toast.error(reason instanceof Error ? reason.message : 'Mask repair was rejected.')
    } finally {
      setBusy(false)
    }
  }

  const submitTimeline = async () => {
    if (!selected || editContract.rerender.length === 0) return
    if (!ownerScopedActionAvailable || !selectedScope) {
      toast.error('Timeline rendering requires an owner-accessible canonical asset in the active scope.')
      return
    }
    setBusy(true)
    try {
      const result = await port.partiallyFinishVideo(selected.id, editContract, selectedScope)
      toast.success(`${result.message} · source remains preserved · queued is not complete`)
      onNavigate({ id: 'gallery', initialType: 'video' })
    } catch (reason) {
      toast.error(reason instanceof Error ? reason.message : 'Timeline edit was rejected.')
    } finally {
      setBusy(false)
    }
  }

  const motionTemplates = useMemo<VideoFinishTemplates>(() => ({
    ...(pricePop.trim() ? { pricePop: { price: pricePop.trim() } } : {}),
    ...(lowerCode.trim() ? { lowerThird: { code: lowerCode.trim(), name: lowerName.trim() || undefined } } : {}),
    ...(watermark ? { logoWatermark: true } : {}),
    ...(endCard ? { endCard: { cta: cta.trim() || undefined, code: lowerCode.trim() || undefined, price: pricePop.trim() || undefined } } : {}),
    ...(Number(countdown) > 0 ? { countdown: { days: Number(countdown) } } : {}),
  }), [countdown, cta, endCard, lowerCode, lowerName, pricePop, watermark])

  const submitMotion = async () => {
    if (!selected || Object.keys(motionTemplates).length === 0) return
    if (!ownerScopedActionAvailable || !selectedScope) {
      toast.error('Motion rendering requires an owner-accessible canonical asset in the active scope.')
      return
    }
    setBusy(true)
    try {
      const result = await port.finishVideo(selected.id, motionTemplates, selectedScope)
      toast.success(`${result.message} · queued is not complete`)
      onNavigate({ id: 'gallery', initialType: 'video' })
    } catch (reason) {
      toast.error(reason instanceof Error ? reason.message : 'Motion finishing was rejected.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className={styles.page}>
      <header className={styles.workspaceHeader}>
        <div className={styles.workspaceTitle}>
          <span><StudioV3Icon name="finish" /></span>
          <div>
            <span className={styles.eyebrow}>Non-destructive production</span>
            <h1>Finishing</h1>
            <p>Brand layout, exact mask repair, Timeline Lite, transcript and motion templates preserve the source version.</p>
          </div>
        </div>
        <div className={styles.segmented}>
          <button aria-pressed={media === 'image'} onClick={() => switchMedia('image')} type="button">Image</button>
          <button aria-pressed={media === 'video'} onClick={() => switchMedia('video')} type="button">Video</button>
        </div>
      </header>

      {issues.length > 0 && <div className={styles.inlineWarning}><StudioV3Icon name="warning" /><span>{issues.join(' · ')}</span></div>}
      <p className={styles.scopeNotice}>
        <StudioV3Icon name="lock" />
        Brand or project changes reload canonical Gallery sources through the authenticated
        access-scoped API. A query value never grants access.
      </p>
      {!ownerActionAvailable && (
        <div className={styles.truthBoundary}>
          <StudioV3Icon name="lock" />
          <div>
            <strong>{activeBrand?.role ?? 'Collaborator'} finishing permissions</strong>
            <p>{activeBrand?.role === 'creator'
              ? 'Canonical mask repair is available within the creator spend threshold; branded derivatives and video-render commands remain owner-only.'
              : 'Preview controls remain available, while derivative, mask and video-render commands stay read-only.'}</p>
          </div>
        </div>
      )}

      <div className={styles.finishingLayout}>
        <aside aria-label="Finishing source versions" className={styles.finishingSources}>
          <header><span className={styles.eyebrow}>Source versions</span><h2>{media === 'image' ? 'Ready images' : 'Ready videos'}</h2></header>
          {loading ? <div className={styles.laneSkeleton} /> : currentItems.length === 0 ? (
            <p className={styles.emptyState}>No ready source is available. QC-failed assets remain visible in Gallery but server finishing gates block them.</p>
          ) : (
            <div className={styles.finishSourceList}>
              {currentItems.map((item) => (
                <button aria-pressed={selected?.id === item.id} key={item.id} onClick={() => { setSelectedId(item.id); setResultUrl(null) }} type="button">
                  <span><ArtifactPreview item={item} /></span>
                  <span><strong>{item.summary ?? item.mode}</strong><small>{item.provider} · {item.originalVariant ? `${item.originalVariant.width}×${item.originalVariant.height}` : item.assetState}</small></span>
                </button>
              ))}
            </div>
          )}
          <div className={styles.sourceIntegrity}>
            <StudioV3Icon name="lock" />
            <div><strong>Original preserved</strong><span>Every output is a separate derivative or linked job. Server QC and source-path validation run again.</span></div>
          </div>
        </aside>

        <section aria-label="Finishing preview" className={styles.finishingPreview}>
          <header>
            <div><span className={styles.eyebrow}>{resultUrl ? 'Server derivative' : 'Source preview'}</span><h2>{selected?.summary ?? 'Select an asset'}</h2></div>
            {selected?.originalVariant && <span>{selected.originalVariant.width}×{selected.originalVariant.height} · {selected.originalVariant.format}</span>}
          </header>
          <div className={styles.finishCanvas} data-fit={fit} data-layout={layout} data-theme={theme}>
            <ArtifactPreview item={selected} url={resultUrl} />
            {!resultUrl && media === 'image' && imageTool === 'brand' && selected?.previewUrl && (
              <div className={styles.layoutOverlay}>
                <span>{eyebrow || 'NEW ARRIVAL'}</span>
                <strong>{headline || 'Headline / hook preview'}</strong>
                <em>{offer || price || 'Offer or price'}</em>
                <small>{productCode || 'PRODUCT CODE'}</small>
              </div>
            )}
          </div>
          <div className={styles.previewToggle}>
            <button aria-pressed={!resultUrl} onClick={() => setResultUrl(null)} type="button">Original / local preview</button>
            <button aria-pressed={Boolean(resultUrl)} disabled={!resultUrl} type="button">Server derivative</button>
          </div>
        </section>

        <aside aria-label="Finishing controls" className={styles.finishInspector}>
          {media === 'image' ? (
            <>
              <div className={styles.segmented}>
                <button aria-pressed={imageTool === 'brand'} onClick={() => setImageTool('brand')} type="button">Brand layout</button>
                <button aria-pressed={imageTool === 'mask'} onClick={() => setImageTool('mask')} type="button">Mask repair</button>
              </div>
              {imageTool === 'brand' ? (
                <div className={styles.inspectorBody}>
                  <fieldset className={styles.optionGroup}><legend>Layout</legend><div className={styles.modeGrid}>{layouts.map((item) => <button aria-pressed={layout === item.id} key={item.id} onClick={() => setLayout(item.id)} type="button">{item.label}</button>)}</div></fieldset>
                  <fieldset className={styles.optionGroup}><legend>Theme</legend><div className={styles.chipRow}>{themes.map((item) => <button aria-pressed={theme === item} key={item} onClick={() => setTheme(item)} type="button">{item}</button>)}</div></fieldset>
                  <label className={styles.field}><span>Eyebrow</span><input maxLength={80} onChange={(event) => setEyebrow(event.target.value)} value={eyebrow} /></label>
                  <label className={styles.field}><span>Headline / hook</span><textarea maxLength={180} onChange={(event) => setHeadline(event.target.value)} rows={3} value={headline} /></label>
                  <label className={styles.field}><span>Offer</span><input maxLength={100} onChange={(event) => setOffer(event.target.value)} value={offer} /></label>
                  <div className={styles.inlineFields}>
                    <label><span>Product code</span><input maxLength={64} onChange={(event) => setProductCode(event.target.value)} value={productCode} /></label>
                    <label><span>Price</span><input maxLength={32} onChange={(event) => setPrice(event.target.value)} value={price} /></label>
                  </div>
                  <label className={styles.field}><span>Product name</span><input maxLength={120} onChange={(event) => setProductName(event.target.value)} value={productName} /></label>
                  <fieldset className={styles.optionGroup}><legend>Image fit</legend><div className={styles.chipRow}><button aria-pressed={fit === 'cover'} onClick={() => setFit('cover')} type="button">Cover</button><button aria-pressed={fit === 'contain'} onClick={() => setFit('contain')} type="button">Contain</button></div></fieldset>
                  <label className={styles.toggleRow}><span><strong>Model-overlay footer</strong><small>Optional brand footer for applicable layouts.</small></span><input checked={footer} onChange={(event) => setFooter(event.target.checked)} type="checkbox" /></label>
                  <button className={styles.primaryButton} disabled={!ownerScopedActionAvailable || busy || !selectedPath || !headline.trim()} onClick={() => void finishBrand()} type="button">{busy ? 'Server checking…' : 'Create branded derivative · local service'} <StudioV3Icon name="arrow" /></button>
                </div>
              ) : maskActionAvailable && selected?.previewUrl && selectedPath && selected.projectAssetId ? (
                <div className={styles.maskHost}>
                  <div className={styles.truthBoundary}><StudioV3Icon name="lock" /><div><strong>Paid precision edit</strong><p>Brush/erase, undo, clear, invert, size, feather and preview are exact current tools. Mask dimensions and cost are validated before the provider request.</p></div></div>
                  <MaskEditor imageUrl={selected.previewUrl} onCancel={() => setImageTool('brand')} onRun={(result) => void runMask(result)} running={busy} />
                </div>
              ) : <p className={styles.emptyState}>Select a viewable, ready image source for Mask repair.</p>}
            </>
          ) : (
            <>
              <div className={styles.segmented}>
                <button aria-pressed={videoTool === 'timeline'} onClick={() => setVideoTool('timeline')} type="button">Timeline Lite</button>
                <button aria-pressed={videoTool === 'motion'} onClick={() => setVideoTool('motion')} type="button">Motion templates</button>
              </div>
              {videoTool === 'timeline' ? (
                <div className={styles.inspectorBody}>
                  {editLoading ? <div className={styles.laneSkeleton} /> : (
                    <>
                      <TimelineLite onChange={setEditContract} value={editContract} />
                      <TranscriptEditor onChange={setEditContract} value={editContract} />
                      <div className={styles.truthBoundary}><StudioV3Icon name="check" /><div><strong>Selected-track partial rerender · ৳0</strong><p>Trim, reorder, crop, focus, safe zones, volume, captions and cover retain the immutable visual source.</p></div></div>
                      <button className={styles.primaryButton} disabled={!ownerScopedActionAvailable || busy || !selected || editContract.rerender.length === 0} onClick={() => void submitTimeline()} type="button">{busy ? 'Server checking…' : 'Render selected tracks · ৳0'} <StudioV3Icon name="arrow" /></button>
                    </>
                  )}
                </div>
              ) : (
                <div className={styles.inspectorBody}>
                  <label className={styles.field}><span>Price pop</span><input maxLength={32} onChange={(event) => setPricePop(event.target.value)} placeholder="৳2,490" value={pricePop} /></label>
                  <div className={styles.inlineFields}><label><span>Lower third code</span><input maxLength={64} onChange={(event) => setLowerCode(event.target.value)} value={lowerCode} /></label><label><span>Name</span><input maxLength={80} onChange={(event) => setLowerName(event.target.value)} value={lowerName} /></label></div>
                  <label className={styles.toggleRow}><span><strong>Logo watermark</strong><small>Uses the server-owned brand logo.</small></span><input checked={watermark} onChange={(event) => setWatermark(event.target.checked)} type="checkbox" /></label>
                  <label className={styles.toggleRow}><span><strong>End card</strong><small>CTA, code and price remain human-authored.</small></span><input checked={endCard} onChange={(event) => setEndCard(event.target.checked)} type="checkbox" /></label>
                  <label className={styles.field}><span>End-card CTA</span><input maxLength={100} onChange={(event) => setCta(event.target.value)} value={cta} /></label>
                  <label className={styles.field}><span>Countdown days</span><input max={365} min={0} onChange={(event) => setCountdown(event.target.value)} type="number" value={countdown} /></label>
                  <div className={styles.motionChecklist}>
                    {['Price pop', 'Lower third code/name', 'Logo watermark', 'End card CTA/code/price', 'Countdown days'].map((item) => <span key={item}><StudioV3Icon name="check" /> {item}</span>)}
                  </div>
                  <button className={styles.primaryButton} disabled={!ownerScopedActionAvailable || busy || !selected || Object.keys(motionTemplates).length === 0} onClick={() => void submitMotion()} type="button">{busy ? 'Server checking…' : 'Queue motion-template render · ৳0'} <StudioV3Icon name="arrow" /></button>
                </div>
              )}
            </>
          )}
        </aside>
      </div>
      <StudioConfirmationDialog
        ariaLabel="Review mask repair queue request"
        confirmDisabled={!maskActionAvailable || !maskEstimate || busy}
        confirmLabel={busy ? 'Revalidating…' : `Confirm up to ৳${maskEstimate?.maxCostBdt.toLocaleString('en-BD') ?? '—'}`}
        onCancel={() => {
          setMaskConfirmOpen(false)
          setMaskRequest(null)
          setMaskEstimate(null)
        }}
        onConfirm={() => void confirmMask()}
        open={maskConfirmOpen}
        summary="The mask upload is a $0 preparation step. This separate confirmation authorizes only the exact source, mask, provider/model selection, whole-taka estimate, and whole-taka hard BDT cap shown below; the server and worker revalidate before the paid call."
        title="Confirm signed mask-repair estimate?"
      >
        <dl className={styles.confirmationFacts}>
          <div><dt>Provider</dt><dd>{maskEstimate?.selection.provider ?? 'Waiting for server'}</dd></div>
          <div><dt>Exact model</dt><dd>{maskEstimate?.selection.model ?? 'Waiting for server'}</dd></div>
          <div><dt>Canonical source</dt><dd>{selected?.projectAssetId ?? 'Unavailable'}</dd></div>
          <div><dt>Exact authorized ceiling</dt><dd>{maskEstimate ? `৳${maskEstimate.estimateBdt.toLocaleString('en-BD')} of hard cap ৳${maskEstimate.maxCostBdt.toLocaleString('en-BD')}` : 'No receipt issued'}</dd></div>
          <div><dt>Receipt expires</dt><dd>{maskEstimate ? new Date(maskEstimate.confirmBy).toLocaleTimeString('en-BD') : '—'}</dd></div>
          <div><dt>Success truth</dt><dd>Queued is not complete; Gallery shows the verified derivative state.</dd></div>
        </dl>
      </StudioConfirmationDialog>
    </div>
  )
}
