'use client'

/* eslint-disable @next/next/no-img-element */

import { useEffect, useMemo, useState } from 'react'
import toast from 'react-hot-toast'
import type {
  GalleryItem,
  SavedStudioModel,
  StudioBrandProfile,
  StudioConfig,
  StudioHealth,
  StudioSettings,
  StudioRunEstimateClient,
  RunPayload,
} from '@/agent/components/creative-studio/studio-api'
import {
  ASPECT_RATIOS,
  BACKGROUND_PRESETS,
  FAMILY_PRESETS,
  GEN_MODES,
  STUDIO_MODES,
  type FamilyPresetId,
  type StudioModeId,
  type StudioProvider,
} from '@/lib/creative-studio/constants'
import {
  getAdvancedModeCapability,
  type StudioFidelityClass,
} from '@/lib/creative-studio/advanced-image-capabilities'
import {
  STUDIO_ENGINES,
  type StudioEngineId,
} from '@/lib/creative-studio/provider-registry'
import type { FashnGenerationMode, FashnResolution } from '@/lib/fashn/types'
import type {
  StudioBrandRecipe,
  StudioProductOption,
  StudioProjectSummary,
} from '@/lib/creative-studio/project-contract'
import {
  buildStudioResolutionUiState,
  resolutionEngineForGenericModel,
  resolutionFieldsForRun,
} from '@/agent/components/creative-studio/resolution-ui'
import { StudioConfirmationDialog } from '@/agent/components/creative-studio/StudioUi'
import { StudioV3Icon } from '@/agent/components/creative-studio-v3/StudioV3Icon'
import {
  STUDIO_V3_SCOPE_BOUNDARY,
  type CreativeStudioV3ProductionPort,
} from '@/agent/components/creative-studio-v3/ports'
import type { CreativeStudioV3Navigate } from '@/agent/components/creative-studio-v3/types'
import styles from '@/agent/components/creative-studio-v3/creative-studio-v3.module.css'

type LabData = {
  products: StudioProductOption[]
  models: SavedStudioModel[]
  recipes: StudioBrandRecipe[]
  sources: GalleryItem[]
  config: StudioConfig | null
  health: StudioHealth | null
  settings: StudioSettings | null
  issues: string[]
}

const EMPTY_DATA: LabData = {
  products: [],
  models: [],
  recipes: [],
  sources: [],
  config: null,
  health: null,
  settings: null,
  issues: [],
}

const fidelityLabel: Record<StudioFidelityClass, string> = {
  purpose_built: 'Purpose-built preservation',
  identity_guided: 'Identity-guided generation',
  unsupported: 'Unsupported',
}

function fieldRequirement(mode: StudioModeId) {
  return STUDIO_MODES.find((item) => item.id === mode) ?? STUDIO_MODES[0]
}

function engineAvailability(config: StudioConfig | null, id: StudioEngineId) {
  return config?.engines.find((engine) => engine.id === id) ?? null
}

function engineIsSelectable(config: StudioConfig | null, id: StudioEngineId): boolean {
  const availability = engineAvailability(config, id)
  return Boolean(availability?.configured && availability.enabled && availability.runnable && !availability.killed)
}

function sourceImage(item: GalleryItem | null): string | null {
  return item?.originalVariant?.storagePath ?? item?.storagePath ?? null
}

function previewBackground(value: string | null | undefined) {
  return value ? { backgroundImage: `url(${JSON.stringify(value)})` } : undefined
}

function SourceArtwork({
  kind,
  label,
  preview,
}: {
  kind: 'product' | 'model'
  label: string
  preview: string | null | undefined
}) {
  const [previewFailed, setPreviewFailed] = useState(false)
  useEffect(() => setPreviewFailed(false), [preview])
  const hasPreview = Boolean(preview) && !previewFailed
  return (
    <div
      aria-label={hasPreview ? `${kind} preview: ${label}` : undefined}
      className={`${styles.v4SourceArtwork} ${
        kind === 'model'
          ? `${styles.v4ModelArtwork} ${styles.v3Tone_ink}`
          : styles.v3Tone_coral
      } ${hasPreview ? styles.v7HasSourcePreview : ''}`}
      role={hasPreview ? 'img' : undefined}
    >
      {hasPreview && (
        <img
          alt=""
          onError={() => setPreviewFailed(true)}
          src={preview ?? ''}
        />
      )}
      {!hasPreview && (
        <>
          <span>{kind === 'model' ? 'MODEL' : 'PRODUCT'}</span>
          <i />
          <b />
        </>
      )}
    </div>
  )
}

export function StudioV3ImageLab({
  activeBrand,
  activeProject,
  initialAvatarId,
  initialSourceAssetId,
  onNavigate,
  port,
}: {
  activeBrand: StudioBrandProfile | null
  activeProject: StudioProjectSummary | null
  initialAvatarId?: string
  initialSourceAssetId?: string
  onNavigate: CreativeStudioV3Navigate
  port: CreativeStudioV3ProductionPort
}) {
  const [data, setData] = useState<LabData>(EMPTY_DATA)
  const [loading, setLoading] = useState(true)
  const [workspaceTab, setWorkspaceTab] = useState<'explore' | 'history'>('explore')
  const [architecture, setArchitecture] = useState<'auto' | 'advanced'>('auto')
  const [isExpanded, setIsExpanded] = useState(false)
  const [sourceTray, setSourceTray] = useState<'product' | 'model' | null>(null)
  const [mode, setMode] = useState<StudioModeId>('product_to_model')
  const [engine, setEngine] = useState<StudioEngineId>('fashn')
  const [familyPreset, setFamilyPreset] = useState<FamilyPresetId>('single')
  const [selectedProductCode, setSelectedProductCode] = useState('')
  const [selectedModelId, setSelectedModelId] = useState(initialAvatarId ?? '')
  const [selectedSourceId, setSelectedSourceId] = useState(initialSourceAssetId ?? '')
  const [recipeId, setRecipeId] = useState('')
  const [prompt, setPrompt] = useState('')
  const [backgroundId, setBackgroundId] = useState('studio')
  const [aspectRatio, setAspectRatio] = useState<string>('4:5')
  const [resolution, setResolution] = useState<FashnResolution>('2k')
  const [generationMode, setGenerationMode] = useState<FashnGenerationMode>('balanced')
  const [numImages, setNumImages] = useState(1)
  const [includeFamily, setIncludeFamily] = useState(false)
  const [includeReel, setIncludeReel] = useState(false)
  const [uploadedProductPath, setUploadedProductPath] = useState('')
  const [uploadedProductReferenceId, setUploadedProductReferenceId] = useState('')
  const [uploadedProductPreview, setUploadedProductPreview] = useState('')
  const [uploadedProductName, setUploadedProductName] = useState('')
  const [uploadedModelPath, setUploadedModelPath] = useState('')
  const [uploadedModelReferenceId, setUploadedModelReferenceId] = useState('')
  const [uploadedModelPreview, setUploadedModelPreview] = useState('')
  const [uploadedModelName, setUploadedModelName] = useState('')
  const [uploadingKind, setUploadingKind] = useState<'product' | 'model' | null>(null)
  const [localStatus, setLocalStatus] = useState(
    'Production APIs are connected. Nothing has been queued.',
  )
  const [reviewOpen, setReviewOpen] = useState(false)
  const [reviewEstimate, setReviewEstimate] = useState<StudioRunEstimateClient | null>(null)
  const [reviewRequest, setReviewRequest] = useState<(RunPayload & {
    auto?: boolean
    includeFamily?: boolean
    includeReel?: boolean
  }) | null>(null)
  const [estimating, setEstimating] = useState(false)
  const [queueing, setQueueing] = useState(false)

  useEffect(() => {
    let live = true
    setLoading(true)
    void Promise.allSettled([
      activeProject?.product
        ? port.listProducts(activeProject.product.code).then((products) => {
            const exact = products.find((product) => product.code === activeProject.product?.code)
            return [exact ?? activeProject.product!]
          })
        : Promise.resolve([]),
      port.listModels(activeBrand?.brandProfileId, activeProject?.id),
      port.listRecipes(activeBrand?.brandProfileId),
      port.listGallery(
        { media: 'image', state: 'ready', limit: 24 },
        activeBrand?.brandProfileId,
        activeProject?.id,
      ),
      port.getConfig(),
      port.getSettings(),
      port.getHealth(),
    ]).then((results) => {
      if (!live) return
      const issues: string[] = []
      const take = <T,>(index: number, name: string, fallback: T): T => {
        const result = results[index]
        if (result.status === 'fulfilled') return result.value as T
        issues.push(`${name}: ${result.reason instanceof Error ? result.reason.message : 'unavailable'}`)
        return fallback
      }
      const next: LabData = {
        products: take(0, 'Catalog', []),
        models: take<SavedStudioModel[]>(1, 'Saved models', []),
        recipes: take(2, 'Recipes', []),
        sources: take<{ items: GalleryItem[] }>(3, 'Gallery', { items: [] }).items,
        config: take(4, 'Capability config', null),
        settings: take(5, 'Studio settings', null),
        health: take(6, 'Operational health', null),
        issues,
      }
      setData(next)
      setSelectedProductCode((current) => current || next.products[0]?.code || '')
      setSelectedModelId((current) => current || next.models.find((model) => model.isDefault)?.id || next.models[0]?.id || '')
      setSelectedSourceId((current) => current || next.sources[0]?.id || '')
      setRecipeId((current) => current || next.recipes[0]?.id || '')
      const defaultEngine = next.config?.singleVtonDefault ?? 'fashn'
      setEngine((current) => engineIsSelectable(next.config, current)
        ? current
        : engineIsSelectable(next.config, defaultEngine)
          ? defaultEngine
          : next.config?.engines.find((item) => item.configured && item.enabled && item.runnable && !item.killed)?.id ?? 'fashn')
    }).finally(() => {
      if (live) setLoading(false)
    })
    return () => { live = false }
  }, [activeBrand?.brandProfileId, activeProject, port])

  useEffect(() => {
    if (!isExpanded) return
    const previousOverflow = document.body.style.overflow
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setIsExpanded(false)
    }
    document.body.style.overflow = 'hidden'
    window.addEventListener('keydown', onKeyDown)
    return () => {
      document.body.style.overflow = previousOverflow
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [isExpanded])

  useEffect(
    () => () => {
      if (uploadedProductPreview) URL.revokeObjectURL(uploadedProductPreview)
    },
    [uploadedProductPreview],
  )
  useEffect(
    () => () => {
      if (uploadedModelPreview) URL.revokeObjectURL(uploadedModelPreview)
    },
    [uploadedModelPreview],
  )

  const selectedProduct = data.products.find((product) => product.code === selectedProductCode) ?? null
  const selectedModel = data.models.find((model) => model.id === selectedModelId) ?? null
  const selectedSource = data.sources.find((asset) => asset.id === selectedSourceId) ?? null
  const requirements = fieldRequirement(mode)
  const multiPerson = familyPreset !== 'single'
    && (mode === 'product_to_model' || mode === 'try_on')
  const selectedEngine = STUDIO_ENGINES.find((item) => item.id === engine)
  const capability = multiPerson && selectedEngine?.singlePersonOnly
    ? undefined
    : getAdvancedModeCapability(engine, mode)

  const engines = useMemo(
    () => STUDIO_ENGINES.filter((item) =>
      getAdvancedModeCapability(item.id, mode)
      && !(multiPerson && item.singlePersonOnly)),
    [mode, multiPerson],
  )

  useEffect(() => {
    if (engines.some((item) => item.id === engine && engineIsSelectable(data.config, item.id))) return
    const next = engines.find((item) => engineIsSelectable(data.config, item.id)) ?? engines[0]
    if (next) setEngine(next.id)
  }, [data.config, engine, engines])

  const genericModel = data.config?.genericImageModels[
    generationMode === 'fast' ? 'standard' : 'pro'
  ]
  const genericEngine = resolutionEngineForGenericModel(
    genericModel,
    data.settings?.imageEngine ?? 'gemini',
  )
  const providerForResolution: StudioProvider | 'xai_imagine' =
    engine === 'xai_imagine' ? 'xai_imagine' : engine === 'gemini' ? 'gemini' : 'fashn'
  const resolutionState = useMemo(
    () => buildStudioResolutionUiState(
      {
        mode,
        provider: providerForResolution,
        vtonEngine: engine,
        familyPreset,
        protectedComposite: false,
        imageEngine: genericEngine,
        xaiWillRun: engine === 'xai_imagine',
      },
      { aspectRatio, resolution },
    ),
    [aspectRatio, engine, familyPreset, genericEngine, mode, providerForResolution, resolution],
  )

  useEffect(() => {
    if (resolutionState.kind !== 'tiered') return
    if (resolutionState.aspectRatio && resolutionState.aspectRatio !== aspectRatio) {
      setAspectRatio(resolutionState.aspectRatio)
    }
    if (resolutionState.resolution && resolutionState.resolution !== resolution) {
      setResolution(resolutionState.resolution)
    }
  }, [aspectRatio, resolution, resolutionState])

  const productPath = uploadedProductPath || selectedProduct?.sourceImage || null
  const personPath = uploadedModelPath || selectedModel?.imagePath || null
  const sourcePath = sourceImage(selectedSource)
  const needsPrompt = mode === 'generate' || mode === 'edit'
  const hasPerson = Boolean(selectedModelId || personPath)
  const creationAvailable = Boolean(
    activeBrand
    && activeBrand.role !== 'reviewer'
    && activeProject
    && activeProject.brandProfileId === activeBrand.brandProfileId,
  )
  const ready =
    (!requirements.needsProduct || Boolean(productPath))
    && (!requirements.needsModel || hasPerson)
    && (!requirements.needsSource || Boolean(sourcePath))
    && (!needsPrompt || Boolean(prompt.trim()))
    && Boolean(capability)
    && engineIsSelectable(data.config, engine)
    && resolutionState.kind !== 'unsupported'
    && engine !== 'fal_flux_fill'

  const uploadReference = async (file: File, kind: 'product' | 'model') => {
    if (!activeBrand || !activeProject || !creationAvailable) {
      toast.error('Choose an editable, access-scoped project before uploading.')
      return
    }
    setUploadingKind(kind)
    try {
      const uploaded = await port.uploadReference(file, {
        brandProfileId: activeBrand.brandProfileId,
        projectId: activeProject.id,
        kind,
      })
      const preview = URL.createObjectURL(file)
      if (kind === 'product') {
        setUploadedProductPath(uploaded.path)
        setUploadedProductReferenceId(uploaded.id)
        setUploadedProductPreview(preview)
        setUploadedProductName(file.name)
      } else {
        setUploadedModelPath(uploaded.path)
        setUploadedModelReferenceId(uploaded.id)
        setUploadedModelPreview(preview)
        setUploadedModelName(file.name)
        setSelectedModelId('')
      }
      setLocalStatus(
        `${file.name} uploaded to the scoped Studio workspace. No generation was queued.`,
      )
      toast.success(
        kind === 'model' && architecture === 'auto'
          ? 'Model uploaded. Auto stayed open; save it as an identity before a paid run.'
          : `${kind === 'product' ? 'Product' : 'Model'} reference uploaded.`,
      )
    } catch (reason) {
      toast.error(reason instanceof Error ? reason.message : 'The upload failed.')
    } finally {
      setUploadingKind(null)
    }
  }

  const pasteProductReference = async () => {
    if (!navigator.clipboard?.read) {
      toast.error('Image paste is not available in this browser. Use Upload instead.')
      return
    }
    try {
      const items = await navigator.clipboard.read()
      for (const item of items) {
        const imageType = item.types.find((type) => type.startsWith('image/'))
        if (!imageType) continue
        const blob = await item.getType(imageType)
        const extension = imageType.split('/')[1]?.replace('jpeg', 'jpg') || 'png'
        await uploadReference(
          new File([blob], `pasted-product-${Date.now()}.${extension}`, { type: imageType }),
          'product',
        )
        return
      }
      toast.error('The clipboard does not contain an image.')
    } catch (reason) {
      toast.error(
        reason instanceof Error && reason.name === 'NotAllowedError'
          ? 'Allow clipboard access, then press Paste again.'
          : 'The clipboard image could not be read. Use Upload instead.',
      )
    }
  }

  const buildRequest = (): RunPayload & {
    auto?: boolean
    includeFamily?: boolean
    includeReel?: boolean
  } => {
    if (!activeBrand || !activeProject) throw new Error('Choose an accessible brand project.')
    const scope = {
      brandProfileId: activeBrand.brandProfileId,
      projectId: activeProject.id,
      productId: selectedProduct?.code,
      sourceAssetIds: selectedSource?.projectAssetId ? [selectedSource.projectAssetId] : [],
      studioSurface: 'v3' as const,
    }
    if (architecture === 'auto') {
      if (!productPath || !selectedModel) {
        throw new Error('Choose the active project product and a scoped identity.')
      }
      return {
        ...scope,
        auto: true,
        mode: 'try_on',
        productImagePath: productPath,
        productReferenceId: uploadedProductReferenceId || undefined,
        modelId: selectedModel.id,
        includeFamily,
        includeReel,
      }
    }
    const provider: StudioProvider = engine === 'gemini' ? 'gemini' : 'fashn'
    const isVton = mode === 'product_to_model' || mode === 'try_on'
    return {
      ...scope,
      mode,
      provider,
      vtonEngine: engine === 'xai_imagine' || isVton ? engine : undefined,
      productImagePath: productPath ?? undefined,
      modelImagePath: uploadedModelPath || undefined,
      productReferenceId: uploadedProductReferenceId || undefined,
      modelReferenceId: uploadedModelReferenceId || undefined,
      faceReferencePath: mode === 'face_to_model' ? personPath ?? undefined : undefined,
      modelId: uploadedModelPath ? undefined : selectedModelId || undefined,
      sourceImagePath: sourcePath ?? undefined,
      sourcePendingActionId: selectedSource?.id,
      familyPreset: isVton ? familyPreset : undefined,
      prompt: prompt.trim() || undefined,
      backgroundPrompt: BACKGROUND_PRESETS.find((item) => item.id === backgroundId)?.prompt || prompt.trim() || undefined,
      ...resolutionFieldsForRun(resolutionState),
      generationMode,
      numImages,
    }
  }

  const openReview = async () => {
    if (!creationAvailable) {
      toast.error('Choose an accessible project. Reviewers cannot create paid runs.')
      return
    }
    setEstimating(true)
    try {
      const request = buildRequest()
      const estimate = await port.estimateRun(request, 500)
      setReviewRequest(request)
      setReviewEstimate(estimate)
      setReviewOpen(true)
    } catch (reason) {
      toast.error(reason instanceof Error ? reason.message : 'The server could not issue an exact estimate.')
    } finally {
      setEstimating(false)
    }
  }

  const queue = async () => {
    if (!creationAvailable || !reviewRequest || !reviewEstimate) {
      toast.error('Refresh the exact server estimate before confirming.')
      return
    }
    setQueueing(true)
    try {
      const result = await port.confirmRun(reviewRequest, reviewEstimate, {
        maxCostBdt: reviewEstimate.maxCostBdt,
      })
      toast.success(result.message)
      setReviewOpen(false)
      setReviewEstimate(null)
      setReviewRequest(null)
      onNavigate({ id: 'gallery' })
    } catch (reason) {
      toast.error(reason instanceof Error ? reason.message : 'The server rejected the queue request.')
    } finally {
      setQueueing(false)
    }
  }

  const selectedEngineDefinition = STUDIO_ENGINES.find((item) => item.id === engine)
  const autoReady = Boolean(productPath && selectedModel && !uploadedModelPath)
  const liveEngineCount = data.config?.engines.filter((item) =>
    item.configured && item.enabled && item.runnable && !item.killed).length ?? 0
  const selectedProductPreview =
    uploadedProductPreview
    || selectedProduct?.previewImage
    || selectedProduct?.sourceImage
  const selectedModelPreview =
    uploadedModelPreview
    || selectedModel?.imageUrl
    || selectedModel?.imagePath

  const productLabel = uploadedProductName || selectedProduct?.name || 'Choose product'
  const productMeta = uploadedProductName
    ? 'Uploaded project reference'
    : selectedProduct?.code ?? 'Required for garment modes'
  const modelLabel = uploadedModelName || selectedModel?.name || 'Choose model'
  const modelMeta = uploadedModelName
    ? 'Uploaded temporary reference'
    : selectedModel
      ? `${selectedModel.role ?? 'Identity'} · ${selectedModel.avatar?.built ? `${selectedModel.avatar.count} angles` : 'single reference'}`
      : 'Saved identity or upload'

  const sourceCards = (
    <div
      aria-label="Image composer sources"
      className={architecture === 'auto' ? styles.v4AutoSourceGrid : styles.v6AdvancedSourceGrid}
    >
      <section
        className={styles.v4SourceCard}
        data-required={architecture === 'auto' || requirements.needsProduct}
      >
        <SourceArtwork
          kind="product"
          label={productLabel}
          preview={selectedProductPreview}
        />
        <div className={styles.v4SourceContent}>
          <span>
            PRODUCT
            {architecture === 'advanced' && (
              <em>{requirements.needsProduct ? 'REQUIRED' : 'OPTIONAL'}</em>
            )}
          </span>
          <strong>{productLabel}</strong>
          <small>{productMeta}</small>
          <div className={styles.v4SourceActions}>
            <button
              onClick={() => void pasteProductReference()}
              type="button"
            >
              <StudioV3Icon name="project" />
              Paste
            </button>
            <label aria-disabled={uploadingKind !== null}>
              <input
                accept="image/*"
                disabled={uploadingKind !== null}
                onChange={(event) => {
                  const file = event.target.files?.[0]
                  event.currentTarget.value = ''
                  if (file) void uploadReference(file, 'product')
                }}
                type="file"
              />
              <StudioV3Icon name="image" />
              {uploadingKind === 'product' ? 'Uploading…' : 'Upload'}
            </label>
            <button
              aria-expanded={sourceTray === 'product'}
              onClick={() => setSourceTray((current) => current === 'product' ? null : 'product')}
              type="button"
            >
              <StudioV3Icon name="gallery" />
              Gallery
            </button>
          </div>
        </div>
      </section>

      <section
        className={styles.v4SourceCard}
        data-required={architecture === 'auto' || requirements.needsModel}
      >
        <SourceArtwork
          kind="model"
          label={modelLabel}
          preview={selectedModelPreview}
        />
        <div className={styles.v4SourceContent}>
          <span>
            MODEL
            {architecture === 'advanced' && (
              <em>{requirements.needsModel ? 'REQUIRED' : 'OPTIONAL'}</em>
            )}
          </span>
          <strong>{modelLabel}</strong>
          <small>{modelMeta}</small>
          <div className={styles.v4SourceActions}>
            <button
              aria-expanded={sourceTray === 'model'}
              onClick={() => setSourceTray((current) => current === 'model' ? null : 'model')}
              type="button"
            >
              <StudioV3Icon name="systems" />
              Library
            </button>
            <label aria-disabled={uploadingKind !== null}>
              <input
                accept="image/*"
                disabled={uploadingKind !== null}
                onChange={(event) => {
                  const file = event.target.files?.[0]
                  event.currentTarget.value = ''
                  if (file) void uploadReference(file, 'model')
                }}
                type="file"
              />
              <StudioV3Icon name="image" />
              {uploadingKind === 'model' ? 'Uploading…' : 'Upload'}
            </label>
            <button
              onClick={() => onNavigate({ id: 'desk', desk: 'systems' })}
              type="button"
            >
              <StudioV3Icon name="voice" />
              Avatar
            </button>
          </div>
        </div>
      </section>
    </div>
  )

  return (
    <div className={`${styles.page} ${styles.v4LabWithFloatingComposer}`}>
      <header className={styles.workspaceHeader}>
        <div className={styles.workspaceTitle}>
          <span><StudioV3Icon name="image" /></span>
          <div>
            <span className={styles.eyebrow}>Production create</span>
            <h1>Image Lab</h1>
            <p>{activeProject?.name ?? 'Choose a project'} · real catalog, identity and provider contracts.</p>
          </div>
        </div>
        <div className={styles.segmented}>
          <button aria-pressed={workspaceTab === 'explore'} onClick={() => setWorkspaceTab('explore')} type="button">Compose</button>
          <button aria-pressed={workspaceTab === 'history'} onClick={() => setWorkspaceTab('history')} type="button">History</button>
        </div>
      </header>

      {data.issues.length > 0 && (
        <div className={styles.inlineWarning} role="status">
          <StudioV3Icon name="warning" />
          <span>{data.issues.join(' · ')}</span>
        </div>
      )}
      {!creationAvailable && (
        <div className={styles.truthBoundary}>
          <StudioV3Icon name="lock" />
          <div>
            <strong>{activeBrand?.role ?? 'Unassigned'} cannot create in this scope</strong>
            <p>Choose an editable project. Reviewer access remains read-only.</p>
          </div>
        </div>
      )}

      {workspaceTab === 'history' ? (
        <section className={styles.historyPanel}>
          <header>
            <div><span className={styles.eyebrow}>Production history</span><h2>Recent image artifacts</h2></div>
            <button onClick={() => onNavigate({ id: 'gallery', initialType: 'image' })} type="button">Full Gallery <StudioV3Icon name="arrow" /></button>
          </header>
          {data.sources.length === 0 ? (
            <p className={styles.emptyState}>No ready image artifacts were returned by the Gallery API.</p>
          ) : (
            <div className={styles.historyGrid}>
              {data.sources.map((asset) => (
                <button
                  key={asset.id}
                  onClick={() => {
                    setSelectedSourceId(asset.id)
                    setWorkspaceTab('explore')
                    setArchitecture('advanced')
                  }}
                  type="button"
                >
                  <span>{asset.thumbUrl || asset.previewUrl ? <img alt="" src={asset.thumbUrl ?? asset.previewUrl ?? ''} /> : <StudioV3Icon name="image" />}</span>
                  <strong>{asset.summary ?? asset.mode}</strong>
                  <small>{asset.provider} · {asset.assetState}</small>
                </button>
              ))}
            </div>
          )}
        </section>
      ) : (
        <>
          <section className={styles.historyPanel}>
            <header>
              <div>
                <span className={styles.eyebrow}>Active production scope</span>
                <h2>{activeProject?.name ?? 'No project selected'}</h2>
              </div>
              <span className={styles.serverBadge}>
                <StudioV3Icon name="lock" />
                {data.health?.worker.healthy ? 'Worker healthy' : 'Server-gated'}
              </span>
            </header>
            <p className={styles.scopeNotice}>
              <StudioV3Icon name="lock" />
              Product, identity and Gallery reads are authenticated and project-scoped:
              {' '}{STUDIO_V3_SCOPE_BOUNDARY.gallery}; {STUDIO_V3_SCOPE_BOUNDARY.models}.
            </p>
          </section>

          <section
            aria-labelledby="image-composer-title"
            className={`${styles.v3Composer} ${styles.v4FloatingComposer} ${
              architecture === 'auto' ? styles.v4ComposerAuto : styles.v4ComposerAdvanced
            } ${isExpanded ? styles.v6ComposerExpanded : ''}`}
            data-workspace={isExpanded ? 'expanded' : 'compact'}
          >
            {architecture === 'auto' && (
              <div className={styles.v4ComposerRecipes} aria-label="Project recipes">
                {data.recipes.slice(0, 3).map((recipe) => (
                  <button
                    aria-pressed={recipeId === recipe.id}
                    key={recipe.id}
                    onClick={() => setRecipeId(recipe.id)}
                    type="button"
                  >
                    <StudioV3Icon name="systems" />
                    {recipe.name}
                  </button>
                ))}
              </div>
            )}

            <header className={architecture === 'auto' ? styles.v4ComposerHeader : styles.v3ComposerHeader}>
              <div>
                <span className={styles.eyebrow}>IMAGE COMPOSER</span>
                <h2 id="image-composer-title">
                  {architecture === 'auto' ? 'Create a product image' : 'Advanced control desk'}
                </h2>
                {architecture === 'advanced' && <p>Mode-aware references, exact provider truth and owner-reviewed cost.</p>}
              </div>
              <div className={styles.v4ComposerTabs} role="tablist" aria-label="Image workflow">
                <button
                  aria-selected={architecture === 'auto'}
                  className={architecture === 'auto' ? styles.v4ComposerTabActive : undefined}
                  onClick={() => setArchitecture('auto')}
                  role="tab"
                  type="button"
                >
                  Auto
                </button>
                <button
                  aria-selected={architecture === 'advanced'}
                  className={architecture === 'advanced' ? styles.v4ComposerTabActive : undefined}
                  onClick={() => setArchitecture('advanced')}
                  role="tab"
                  type="button"
                >
                  Advanced
                </button>
              </div>
              <div className={styles.v6ComposerHeaderActions}>
                <button
                  aria-label={isExpanded ? 'Collapse image workspace' : 'Expand image workspace'}
                  className={styles.v6ComposerExpand}
                  onClick={() => setIsExpanded((current) => !current)}
                  title={isExpanded ? 'Return to compact composer' : 'Open full workspace'}
                  type="button"
                >
                  <span aria-hidden="true" className={styles.v6ExpandGlyph}><i /><i /></span>
                </button>
                <span
                  className={`${styles.v9ComposerApiBadge} ${
                    data.config && data.health ? '' : styles.v9ComposerApiBadgeWarning
                  }`}
                >
                  <i />
                  <span>
                    <strong>{loading ? 'Checking API' : data.config ? `Live API · ${liveEngineCount} ready` : 'API unavailable'}</strong>
                    <small>৳0 read-only status</small>
                  </span>
                </span>
              </div>
            </header>

            {architecture === 'advanced' && (
              <>
                <div className={styles.v3ModeScroller} role="tablist" aria-label="Advanced image modes">
                  {STUDIO_MODES.map((item) => (
                    <button
                      aria-selected={mode === item.id}
                      className={mode === item.id ? styles.v3ModeActive : undefined}
                      key={item.id}
                      onClick={() => {
                        setMode(item.id)
                        if (item.id === 'image_to_video') {
                          setLocalStatus('Choose a ready Gallery image, then continue in Video Lab.')
                        }
                      }}
                      role="tab"
                      type="button"
                    >
                      <StudioV3Icon name={item.id === 'generate' ? 'spark' : item.id === 'image_to_video' ? 'video' : item.id === 'edit' ? 'operations' : 'image'} />
                      <span><strong>{item.label}</strong><small>{item.short}</small></span>
                    </button>
                  ))}
                </div>
                <div className={styles.v3ModeExplanation}>
                  <span>{requirements.short}</span>
                  <p>
                    {requirements.needsProduct ? 'Product reference' : 'No product required'}
                    {' · '}
                    {requirements.needsModel ? 'model identity required' : 'model optional'}
                    {requirements.needsSource ? ' · source image required' : ''}
                  </p>
                </div>
              </>
            )}

            {sourceCards}

            {sourceTray && (
              <section className={`${styles.v4SourceTray} ${architecture === 'advanced' ? styles.v6AdvancedSourceTray : ''}`}>
                <header>
                  <div>
                    <span className={styles.eyebrow}>{sourceTray === 'product' ? 'PRODUCT GALLERY' : 'MODEL & AVATAR LIBRARY'}</span>
                    <strong>{sourceTray === 'product' ? 'Choose an approved project product' : 'Choose a scoped identity'}</strong>
                  </div>
                  <button aria-label="Close source picker" onClick={() => setSourceTray(null)} type="button">
                    <StudioV3Icon name="close" />
                  </button>
                </header>
                <div>
                  {sourceTray === 'product'
                    ? data.products.map((product) => (
                        <button
                          aria-pressed={selectedProductCode === product.code && !uploadedProductPath}
                          key={product.code}
                          onClick={() => {
                            setSelectedProductCode(product.code)
                            setUploadedProductPath('')
                            setUploadedProductReferenceId('')
                            setUploadedProductPreview('')
                            setUploadedProductName('')
                            setSourceTray(null)
                          }}
                          type="button"
                        >
                          <span
                            className={styles.v3ProductSwatch}
                            style={previewBackground(product.previewImage ?? product.sourceImage)}
                          />
                          <span><strong>{product.name}</strong><small>{product.code}</small></span>
                        </button>
                      ))
                    : data.models.map((model) => (
                        <button
                          aria-pressed={selectedModelId === model.id && !uploadedModelPath}
                          key={model.id}
                          onClick={() => {
                            setSelectedModelId(model.id)
                            setUploadedModelPath('')
                            setUploadedModelReferenceId('')
                            setUploadedModelPreview('')
                            setUploadedModelName('')
                            setSourceTray(null)
                          }}
                          type="button"
                        >
                          <span
                            className={styles.v3AvatarPortrait}
                            style={previewBackground(model.imageUrl ?? model.imagePath)}
                          />
                          <span><strong>{model.name}</strong><small>{model.role ?? 'Identity'} · {model.avatar?.built ? `${model.avatar.count} angles` : 'single image'}</small></span>
                        </button>
                      ))}
                </div>
              </section>
            )}

            <label className={styles.v3PromptField}>
              <span>
                Creative direction
                <em>{needsPrompt ? 'required' : 'optional'}</em>
              </span>
              <textarea
                aria-label="Creative direction"
                maxLength={1_200}
                onChange={(event) => setPrompt(event.target.value)}
                placeholder={mode === 'generate' ? 'Describe the campaign visual…' : 'Describe styling, light, setting or the exact edit…'}
                value={prompt}
              />
            </label>

            {architecture === 'auto' ? (
              <>
                <footer className={styles.v4ComposerFooter}>
                  <div className={styles.v4ComposerControls} aria-label="Auto image settings">
                    <button type="button"><StudioV3Icon name="image" />{data.config?.singleVtonDefault ?? 'Server default'}</button>
                    <button type="button">4:5</button>
                    <button type="button">Server resolution</button>
                    <label>
                      <input checked={includeFamily} onChange={(event) => setIncludeFamily(event.target.checked)} type="checkbox" />
                      Family
                    </label>
                    <label>
                      <input checked={includeReel} onChange={(event) => setIncludeReel(event.target.checked)} type="checkbox" />
                      + 6s reel
                    </label>
                  </div>
                  <span className={styles.v4ComposerEstimate}>
                    <strong>Server estimate</strong>
                    <small>signed review first</small>
                  </span>
                  <button
                    aria-label="Review exact production estimate"
                    className={styles.v4ComposerSubmit}
                    disabled={!creationAvailable || !autoReady || estimating}
                    onClick={() => void openReview()}
                    type="button"
                  >
                    <StudioV3Icon name="arrow" />
                  </button>
                </footer>
                <p className={styles.v4ComposerStatus}>
                  <StudioV3Icon name={autoReady ? 'check' : 'warning'} />
                  {autoReady
                    ? localStatus
                    : uploadedModelPath
                      ? 'Auto stayed open. Save this upload as an identity from Avatar before requesting a paid run.'
                      : 'Choose a product source and saved identity to request an exact estimate.'}
                </p>
              </>
            ) : (
              <>
                <section
                  aria-labelledby="advanced-production-controls-title"
                  className={styles.v8InlineProductionControls}
                >
                  <header>
                    <span>
                      <i><StudioV3Icon name="operations" /></i>
                      <span>
                        <strong id="advanced-production-controls-title">Production controls</strong>
                        <small>Always visible inside the composer</small>
                      </span>
                    </span>
                    <em>Live contract</em>
                  </header>
                  <div className={styles.v6ProductionControlDeck}>
                    <div className={styles.v3ControlGrid}>
                      <label>
                        <span>Provider / model</span>
                        <select onChange={(event) => setEngine(event.target.value as StudioEngineId)} value={engine}>
                          {engines.map((item) => {
                            const availability = engineAvailability(data.config, item.id)
                            const selectable = engineIsSelectable(data.config, item.id)
                            return (
                              <option disabled={!selectable} key={item.id} value={item.id}>
                                {item.label} · {selectable ? 'Live' : availability?.killed ? 'Killed' : 'Unavailable'}
                              </option>
                            )
                          })}
                        </select>
                      </label>
                      <label>
                        <span>Background</span>
                        <select onChange={(event) => setBackgroundId(event.target.value)} value={backgroundId}>
                          {BACKGROUND_PRESETS.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
                        </select>
                      </label>
                    </div>

                    {(mode === 'product_to_model' || mode === 'try_on') && (
                      <div className={styles.v3OptionGroup}>
                        <div className={styles.v3FieldLabel}><span>Composition</span><em>family roles</em></div>
                        <div className={styles.v3OptionRow}>
                          {FAMILY_PRESETS.map((item) => (
                            <button
                              aria-pressed={familyPreset === item.id}
                              className={familyPreset === item.id ? styles.v3SegmentActive : undefined}
                              key={item.id}
                              onClick={() => setFamilyPreset(item.id)}
                              type="button"
                            >
                              {item.label}
                            </button>
                          ))}
                        </div>
                      </div>
                    )}

                    {resolutionState.kind === 'tiered' && (
                      <>
                        <div className={styles.v3OptionGroup}>
                          <div className={styles.v3FieldLabel}><span>Aspect</span><em>request</em></div>
                          <div className={styles.v3OptionRow}>
                            {ASPECT_RATIOS.map((value) => (
                              <button
                                aria-pressed={aspectRatio === value}
                                className={aspectRatio === value ? styles.v3SegmentActive : undefined}
                                disabled={!resolutionState.supportedAspects.includes(value)}
                                key={value}
                                onClick={() => setAspectRatio(value)}
                                type="button"
                              >
                                {value}
                              </button>
                            ))}
                          </div>
                        </div>
                        <div className={styles.v3OptionGroup}>
                          <div className={styles.v3FieldLabel}><span>Resolution</span><em>verified after delivery</em></div>
                          <div className={styles.v3OptionRow}>
                            {(['1k', '2k', '4k'] as FashnResolution[]).map((value) => {
                              const option = resolutionState.resolutionOptions.find((item) => item.value === value)
                              return (
                                <button
                                  aria-pressed={resolution === value}
                                  className={resolution === value ? styles.v3SegmentActive : undefined}
                                  disabled={!option}
                                  key={value}
                                  onClick={() => setResolution(value)}
                                  type="button"
                                >
                                  {value.toUpperCase()}
                                </button>
                              )
                            })}
                          </div>
                        </div>
                      </>
                    )}

                    <div className={styles.v3ControlGrid}>
                      <div className={styles.v3OptionGroup}>
                        <div className={styles.v3FieldLabel}><span>Quality</span><em>safety checks on</em></div>
                        <div className={styles.v3OptionRow}>
                          {GEN_MODES.map((value) => (
                            <button
                              aria-pressed={generationMode === value}
                              className={generationMode === value ? styles.v3SegmentActive : undefined}
                              key={value}
                              onClick={() => setGenerationMode(value)}
                              type="button"
                            >
                              {value}
                            </button>
                          ))}
                        </div>
                      </div>
                      <div className={styles.v3OptionGroup}>
                        <div className={styles.v3FieldLabel}><span>Outputs</span><em>1–4</em></div>
                        <div className={styles.v3OptionRow}>
                          {[1, 2, 3, 4].map((value) => (
                            <button
                              aria-pressed={numImages === value}
                              className={numImages === value ? styles.v3SegmentActive : undefined}
                              key={value}
                              onClick={() => setNumImages(value)}
                              type="button"
                            >
                              {value}
                            </button>
                          ))}
                        </div>
                      </div>
                    </div>
                  </div>
                </section>

                <div className={styles.v3ComposerReadiness}>
                  <div>
                    <span className={ready ? styles.v3ReadinessReady : styles.v3ReadinessBlocked}>
                      <StudioV3Icon name={ready ? 'check' : 'lock'} />
                    </span>
                    <span>
                      <strong>{ready ? 'Configuration ready for owner cost review' : 'Required production context is incomplete'}</strong>
                      <small>
                        {ready
                          ? `${selectedEngineDefinition?.label ?? engine} · ${resolutionState.labelBn} · ${generationMode}`
                          : 'Check required product, model, source, prompt, engine and resolution.'}
                      </small>
                    </span>
                  </div>
                  <div>
                    <span>ESTIMATE</span>
                    <strong>Server-signed</strong>
                    <small>Requested before any paid provider call</small>
                  </div>
                </div>

                <footer className={styles.v3ComposerFooter}>
                  <div>
                    <StudioV3Icon name="lock" />
                    <span>
                      <strong>{capability ? fidelityLabel[capability.fidelity] : 'Unsupported combination'}</strong>
                      <small>{capability?.limitationBn ?? localStatus}</small>
                    </span>
                  </div>
                  {mode === 'image_to_video' ? (
                    <button
                      className={styles.primaryButton}
                      disabled={!selectedSource}
                      onClick={() => onNavigate({ id: 'video-lab', sourceAssetId: selectedSource?.id })}
                      type="button"
                    >
                      Continue in Video Lab <StudioV3Icon name="arrow" />
                    </button>
                  ) : engine === 'fal_flux_fill' ? (
                    <button className={styles.secondaryButton} onClick={() => onNavigate({ id: 'finishing', assetId: selectedSource?.id })} type="button">
                      Open Mask Repair <StudioV3Icon name="arrow" />
                    </button>
                  ) : (
                    <button
                      className={styles.primaryButton}
                      disabled={!creationAvailable || !ready || estimating}
                      onClick={() => void openReview()}
                      type="button"
                    >
                      {estimating ? 'Getting exact estimate…' : 'Review exact estimate'} <StudioV3Icon name="arrow" />
                    </button>
                  )}
                </footer>
              </>
            )}
          </section>
        </>
      )}

      <StudioConfirmationDialog
        ariaLabel="Review image generation queue request"
        confirmDisabled={!creationAvailable || !reviewEstimate || queueing || (architecture === 'auto' ? !autoReady : !ready)}
        confirmLabel={queueing ? 'Revalidating…' : `Confirm up to ৳${reviewEstimate?.maxCostBdt.toLocaleString('en-BD') ?? '—'}`}
        onCancel={() => { setReviewOpen(false); setReviewEstimate(null); setReviewRequest(null) }}
        onConfirm={() => void queue()}
        open={reviewOpen}
        summary="This is the exact signed whole-taka server estimate for the current brand, project, product, sources and resolved provider/model. Confirmation is separate; the server and worker revalidate the same whole-taka hard cap before any provider call."
        title="Confirm signed production estimate?"
      >
        <dl className={styles.confirmationFacts}>
          <div><dt>Architecture</dt><dd>{architecture}</dd></div>
          <div><dt>Mode</dt><dd>{architecture === 'auto' ? 'server-selected Auto path' : mode}</dd></div>
          <div><dt>Engine</dt><dd>{reviewEstimate?.selection.provider ?? 'Waiting for server'}</dd></div>
          <div><dt>Exact model</dt><dd>{reviewEstimate?.selection.model ?? 'Waiting for server'}</dd></div>
          <div><dt>Resolution</dt><dd>{architecture === 'auto' ? 'server-selected' : resolutionState.kind === 'tiered' ? `${resolutionState.resolution?.toUpperCase()} requested; delivered pixels verified later` : resolutionState.labelBn}</dd></div>
          <div><dt>Exact authorized ceiling</dt><dd>{reviewEstimate ? `৳${reviewEstimate.estimateBdt.toLocaleString('en-BD')} of hard cap ৳${reviewEstimate.maxCostBdt.toLocaleString('en-BD')}` : 'No receipt issued'}</dd></div>
          <div><dt>Receipt expires</dt><dd>{reviewEstimate ? new Date(reviewEstimate.confirmBy).toLocaleTimeString('en-BD') : '—'}</dd></div>
          <div><dt>Success truth</dt><dd>Queued is not complete; Gallery shows verified result state.</dd></div>
        </dl>
      </StudioConfirmationDialog>
    </div>
  )
}
