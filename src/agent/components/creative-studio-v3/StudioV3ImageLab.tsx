'use client'

/* eslint-disable @next/next/no-img-element */

import { useEffect, useMemo, useRef, useState } from 'react'
import toast from 'react-hot-toast'
import type {
  GalleryItem,
  SavedStudioModel,
  StudioBrandProfile,
  StudioConfig,
  StudioSettings,
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
  settings: StudioSettings | null
  issues: string[]
}

const EMPTY_DATA: LabData = {
  products: [],
  models: [],
  recipes: [],
  sources: [],
  config: null,
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

function ImageTile({
  active,
  image,
  label,
  meta,
  onClick,
}: {
  active: boolean
  image: string | null | undefined
  label: string
  meta: string
  onClick: () => void
}) {
  return (
    <button
      aria-pressed={active}
      className={active ? styles.mediaChoiceActive : styles.mediaChoice}
      onClick={onClick}
      type="button"
    >
      <span>{image ? <img alt="" src={image} /> : <StudioV3Icon name="image" />}</span>
      <strong>{label}</strong>
      <small>{meta}</small>
    </button>
  )
}

export function StudioV3ImageLab({
  activeBrand,
  initialAvatarId,
  initialSourceAssetId,
  onNavigate,
  port,
}: {
  activeBrand: StudioBrandProfile | null
  initialAvatarId?: string
  initialSourceAssetId?: string
  onNavigate: CreativeStudioV3Navigate
  port: CreativeStudioV3ProductionPort
}) {
  const [data, setData] = useState<LabData>(EMPTY_DATA)
  const [loading, setLoading] = useState(true)
  const [workspaceTab, setWorkspaceTab] = useState<'explore' | 'history'>('explore')
  const [architecture, setArchitecture] = useState<'auto' | 'advanced'>('auto')
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
  const [uploading, setUploading] = useState<string | null>(null)
  const [uploaded, setUploaded] = useState<{
    product?: { path: string; preview: string }
    person?: { path: string; preview: string }
    source?: { path: string; preview: string }
  }>({})
  const [reviewOpen, setReviewOpen] = useState(false)
  const [queueing, setQueueing] = useState(false)
  const uploadInput = useRef<HTMLInputElement>(null)
  const uploadKind = useRef<'product' | 'person' | 'source'>('source')
  const uploadedRef = useRef(uploaded)

  useEffect(() => {
    uploadedRef.current = uploaded
  }, [uploaded])

  useEffect(() => () => {
    Object.values(uploadedRef.current).forEach((item) => {
      if (item?.preview.startsWith('blob:')) URL.revokeObjectURL(item.preview)
    })
  }, [])

  useEffect(() => {
    let live = true
    setLoading(true)
    void Promise.allSettled([
      port.listProducts(),
      port.listModels(activeBrand?.brandProfileId),
      port.listRecipes(activeBrand?.brandProfileId),
      port.listGallery(
        { media: 'image', state: 'ready', limit: 24 },
        activeBrand?.brandProfileId,
      ),
      port.getConfig(),
      port.getSettings(),
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
  }, [activeBrand?.brandProfileId, port])

  const selectedProduct = data.products.find((product) => product.code === selectedProductCode) ?? null
  const selectedModel = data.models.find((model) => model.id === selectedModelId) ?? null
  const selectedSource = data.sources.find((asset) => asset.id === selectedSourceId) ?? null
  const selectedRecipe = data.recipes.find((recipe) => recipe.id === recipeId) ?? null
  const requirements = fieldRequirement(mode)
  const capability = getAdvancedModeCapability(engine, mode)

  const engines = useMemo(
    () => STUDIO_ENGINES.filter((item) => getAdvancedModeCapability(item.id, mode)),
    [mode],
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

  const productPath = uploaded.product?.path ?? selectedProduct?.sourceImage ?? null
  const personPath = uploaded.person?.path ?? null
  const sourcePath = uploaded.source?.path ?? sourceImage(selectedSource)
  const needsPrompt = mode === 'generate' || mode === 'edit'
  const hasPerson = Boolean(selectedModelId || personPath)
  const ownerActionAvailable = activeBrand?.role === 'owner'
  const ready =
    (!requirements.needsProduct || Boolean(productPath))
    && (!requirements.needsModel || hasPerson)
    && (!requirements.needsSource || Boolean(sourcePath))
    && (!needsPrompt || Boolean(prompt.trim()))
    && Boolean(capability)
    && engineIsSelectable(data.config, engine)
    && resolutionState.kind !== 'unsupported'
    && engine !== 'fal_flux_fill'

  const openUpload = (kind: 'product' | 'person' | 'source') => {
    if (!ownerActionAvailable) return
    uploadKind.current = kind
    uploadInput.current?.click()
  }

  const uploadFile = async (file: File | undefined) => {
    if (!file) return
    if (!ownerActionAvailable) {
      toast.error('Upload is disabled until the collaborator-safe production adapter is connected.')
      return
    }
    const kind = uploadKind.current
    setUploading(kind)
    try {
      const path = await port.uploadImage(file, `studio-v3-${kind}`)
      const preview = URL.createObjectURL(file)
      setUploaded((current) => {
        const previous = current[kind]
        if (previous?.preview.startsWith('blob:')) URL.revokeObjectURL(previous.preview)
        return { ...current, [kind]: { path, preview } }
      })
      toast.success('Source uploaded. It is not queued for generation.')
    } catch (reason) {
      toast.error(reason instanceof Error ? reason.message : 'Upload failed')
    } finally {
      setUploading(null)
      if (uploadInput.current) uploadInput.current.value = ''
    }
  }

  const queue = async () => {
    if (!ownerActionAvailable) {
      toast.error('Generation is disabled until the collaborator-safe production adapter is connected.')
      return
    }
    setQueueing(true)
    try {
      if (architecture === 'auto') {
        if (!productPath) throw new Error('Choose an ERP product or upload a product source.')
        const result = await port.queueAutoImage({
          productImagePath: productPath,
          includeFamily,
          includeReel,
        })
        toast.success(result.message)
      } else {
        const provider: StudioProvider = engine === 'gemini' ? 'gemini' : 'fashn'
        const isVton = mode === 'product_to_model' || mode === 'try_on'
        const result = await port.queueAdvancedImage({
          mode,
          provider,
          vtonEngine: engine === 'xai_imagine' || isVton ? engine : undefined,
          productImagePath: productPath ?? undefined,
          modelImagePath: personPath ?? undefined,
          modelId: selectedModelId || undefined,
          sourceImagePath: sourcePath ?? undefined,
          sourcePendingActionId: selectedSource?.id,
          familyPreset: isVton ? familyPreset : undefined,
          prompt: prompt.trim() || undefined,
          backgroundPrompt: BACKGROUND_PRESETS.find((item) => item.id === backgroundId)?.prompt || prompt.trim() || undefined,
          ...resolutionFieldsForRun(resolutionState),
          generationMode,
          numImages,
        })
        toast.success(result.message)
      }
      setReviewOpen(false)
      onNavigate({ id: 'gallery' })
    } catch (reason) {
      toast.error(reason instanceof Error ? reason.message : 'The server rejected the queue request.')
    } finally {
      setQueueing(false)
    }
  }

  const selectedAvailability = engineAvailability(data.config, engine)
  const selectedEngineDefinition = STUDIO_ENGINES.find((item) => item.id === engine)
  const autoReady = Boolean(productPath && selectedModel)

  return (
    <div className={styles.page}>
      <input
        accept="image/heic,image/heif,image/jpeg,image/png,image/webp,.heic,.heif,.jpg,.jpeg,.png,.webp"
        className="sr-only"
        disabled={!ownerActionAvailable}
        onChange={(event) => void uploadFile(event.target.files?.[0])}
        ref={uploadInput}
        type="file"
      />

      <header className={styles.workspaceHeader}>
        <div className={styles.workspaceTitle}>
          <span><StudioV3Icon name="image" /></span>
          <div>
            <span className={styles.eyebrow}>Create / Explore</span>
            <h1>Image Lab</h1>
            <p>Start with real catalog, identity and source context; capability truth follows the selected engine.</p>
          </div>
        </div>
        <div className={styles.segmented}>
          <button aria-pressed={workspaceTab === 'explore'} onClick={() => setWorkspaceTab('explore')} type="button">Explore</button>
          <button aria-pressed={workspaceTab === 'history'} onClick={() => setWorkspaceTab('history')} type="button">History</button>
        </div>
      </header>

      {data.issues.length > 0 && (
        <div className={styles.inlineWarning} role="status">
          <StudioV3Icon name="warning" />
          <span>{data.issues.join(' · ')}</span>
        </div>
      )}
      <p className={styles.scopeNotice}>
        <StudioV3Icon name="lock" />
        Brand switch reloaded this Lab. Gallery and saved identities remain explicitly owner-only:
        {' '}{STUDIO_V3_SCOPE_BOUNDARY.gallery}; {STUDIO_V3_SCOPE_BOUNDARY.models}.
      </p>
      {!ownerActionAvailable && (
        <div className={styles.truthBoundary}>
          <StudioV3Icon name="lock" />
          <div>
            <strong>{activeBrand?.role ?? 'Collaborator'} creation is not connected yet</strong>
            <p>The V3 journey is available, but the current upload and generation routes remain owner-only. Controls stay disabled until an access-safe adapter is wired.</p>
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
                <button key={asset.id} onClick={() => { setSelectedSourceId(asset.id); setWorkspaceTab('explore'); setArchitecture('advanced') }} type="button">
                  <span>{asset.thumbUrl || asset.previewUrl ? <img alt="" src={asset.thumbUrl ?? asset.previewUrl ?? ''} /> : <StudioV3Icon name="image" />}</span>
                  <strong>{asset.summary ?? asset.mode}</strong>
                  <small>{asset.provider} · {asset.assetState}</small>
                </button>
              ))}
            </div>
          )}
        </section>
      ) : (
        <div className={styles.labLayout}>
          <section aria-label="Image source explorer" className={styles.labExplore}>
            <div className={styles.architectureSwitch}>
              <button aria-pressed={architecture === 'auto'} onClick={() => setArchitecture('auto')} type="button">
                <StudioV3Icon name="spark" /><span><strong>Auto</strong><small>Product + default identity</small></span>
              </button>
              <button aria-pressed={architecture === 'advanced'} onClick={() => setArchitecture('advanced')} type="button">
                <StudioV3Icon name="operations" /><span><strong>Advanced</strong><small>Seven exact production modes</small></span>
              </button>
            </div>

            <section className={styles.sourceSection}>
              <header><div><span className={styles.eyebrow}>ERP catalog</span><h2>Product source</h2></div><button disabled={!ownerActionAvailable || Boolean(uploading)} onClick={() => openUpload('product')} type="button">{uploading === 'product' ? 'Uploading…' : 'Upload source'}</button></header>
              {loading ? <div className={styles.laneSkeleton} /> : data.products.length === 0 ? (
                <p className={styles.emptyState}>The ERP product API returned no catalog options. Upload remains server validated.</p>
              ) : (
                <div className={styles.mediaLane}>
                  {data.products.slice(0, 14).map((product) => (
                    <ImageTile
                      active={!uploaded.product && selectedProductCode === product.code}
                      image={product.previewImage ?? product.sourceImage}
                      key={product.code}
                      label={product.name}
                      meta={`${product.code} · ৳${product.priceBdt.toLocaleString('en-BD')}`}
                      onClick={() => { setSelectedProductCode(product.code); setUploaded((current) => ({ ...current, product: undefined })) }}
                    />
                  ))}
                </div>
              )}
              {uploaded.product && <p className={styles.uploadReceipt}><StudioV3Icon name="check" /> Uploaded product source · server storage path received</p>}
            </section>

            <section className={styles.sourceSection}>
              <header><div><span className={styles.eyebrow}>Brand-isolated identity</span><h2>Avatar / saved model</h2></div><button disabled={!ownerActionAvailable || Boolean(uploading)} onClick={() => openUpload('person')} type="button">{uploading === 'person' ? 'Uploading…' : 'Upload reference'}</button></header>
              {data.models.length === 0 ? (
                <p className={styles.emptyState}>No saved model is available. Add one in Recipes & Models or upload a reference.</p>
              ) : (
                <div className={styles.identityLane}>
                  {data.models.map((model) => (
                    <button
                      aria-pressed={!uploaded.person && selectedModelId === model.id}
                      key={model.id}
                      onClick={() => { setSelectedModelId(model.id); setUploaded((current) => ({ ...current, person: undefined })) }}
                      type="button"
                    >
                      <span>{model.imageUrl ? <img alt="" src={model.imageUrl} /> : <StudioV3Icon name="voice" />}</span>
                      <strong>{model.name}</strong>
                      <small>{model.role ?? 'No role'} · {model.avatar?.built ? `${model.avatar.count} angles` : 'single image'}</small>
                      {model.isDefault && <em>Default</em>}
                    </button>
                  ))}
                </div>
              )}
              {uploaded.person && <p className={styles.uploadReceipt}><StudioV3Icon name="check" /> Uploaded person reference · no saved identity claim</p>}
            </section>

            {architecture === 'advanced' && requirements.needsSource && (
              <section className={styles.sourceSection}>
                <header><div><span className={styles.eyebrow}>Gallery source</span><h2>Source image</h2></div><button disabled={!ownerActionAvailable || Boolean(uploading)} onClick={() => openUpload('source')} type="button">{uploading === 'source' ? 'Uploading…' : 'Upload source'}</button></header>
                {data.sources.length === 0 ? (
                  <p className={styles.emptyState}>No ready Gallery image is available for this mode.</p>
                ) : (
                  <div className={styles.mediaLane}>
                    {data.sources.map((asset) => (
                      <ImageTile
                        active={!uploaded.source && selectedSourceId === asset.id}
                        image={asset.thumbUrl ?? asset.previewUrl}
                        key={asset.id}
                        label={asset.summary ?? asset.mode}
                        meta={`${asset.provider} · ${asset.originalVariant ? `${asset.originalVariant.width}×${asset.originalVariant.height}` : asset.assetState}`}
                        onClick={() => { setSelectedSourceId(asset.id); setUploaded((current) => ({ ...current, source: undefined })) }}
                      />
                    ))}
                  </div>
                )}
              </section>
            )}

            <section className={styles.sourceSection}>
              <header><div><span className={styles.eyebrow}>Approved starting systems</span><h2>Recipes</h2></div><button onClick={() => onNavigate({ id: 'desk', desk: 'systems' })} type="button">Manage</button></header>
              {data.recipes.length === 0 ? (
                <p className={styles.emptyState}>No recipe is available. Recipe selection will not be claimed in the request.</p>
              ) : (
                <div className={styles.recipeLane}>
                  {data.recipes.map((recipe) => (
                    <button aria-pressed={recipeId === recipe.id} key={recipe.id} onClick={() => setRecipeId(recipe.id)} type="button">
                      <strong>{recipe.name}</strong>
                      <small>v{recipe.version} · {recipe.locked ? 'locked' : 'editable'} · ৳{recipe.spendCeilingBdt} cap</small>
                    </button>
                  ))}
                </div>
              )}
              {selectedRecipe && <p className={styles.truthNote}>Recipe is visible context only. Existing Advanced generation APIs do not yet consume every recipe field.</p>}
            </section>
          </section>

          <aside aria-label="Image generation composer" className={styles.composer}>
            <header className={styles.composerHeader}>
              <div><span className={styles.eyebrow}>{architecture === 'auto' ? 'Guided workflow' : 'Capability-aware composer'}</span><h2>{architecture === 'auto' ? 'Auto image' : 'Advanced image'}</h2></div>
              <span className={styles.serverBadge}><StudioV3Icon name="lock" /> Server authority</span>
            </header>

            {architecture === 'auto' ? (
              <div className={styles.composerBody}>
                <div className={styles.selectionSummary}>
                  <div><span>Product</span><strong>{selectedProduct?.name ?? (uploaded.product ? 'Uploaded source' : 'Required')}</strong></div>
                  <div><span>Identity</span><strong>{selectedModel?.name ?? 'Default saved model required'}</strong></div>
                  <div><span>Engine path</span><strong>{data.config?.singleVtonDefault ?? 'Server default unavailable'}</strong></div>
                </div>
                <label className={styles.toggleRow}>
                  <span><strong>Family variant</strong><small>Uses saved role identities; server validates required roles.</small></span>
                  <input checked={includeFamily} onChange={(event) => setIncludeFamily(event.target.checked)} type="checkbox" />
                </label>
                <label className={styles.toggleRow}>
                  <span><strong>Six-second Reel</strong><small>Queues a separate Veo action only after confirmation.</small></span>
                  <input checked={includeReel} onChange={(event) => setIncludeReel(event.target.checked)} type="checkbox" />
                </label>
                <div className={styles.readiness} data-ready={autoReady}>
                  <StudioV3Icon name={autoReady ? 'check' : 'warning'} />
                  <div>
                    <strong>{autoReady ? 'Ready for authorized review' : 'Missing production context'}</strong>
                    <span>{autoReady ? 'The server will recompute engine, readiness and cost policy.' : 'Choose a product with a source image and a saved default identity.'}</span>
                  </div>
                </div>
                <button className={styles.primaryButton} disabled={!ownerActionAvailable || !autoReady} onClick={() => setReviewOpen(true)} type="button">
                  Review queue request <StudioV3Icon name="arrow" />
                </button>
              </div>
            ) : (
              <div className={styles.composerBody}>
                <fieldset className={styles.optionGroup}>
                  <legend>Mode</legend>
                  <div className={styles.modeGrid}>
                    {STUDIO_MODES.map((item) => (
                      <button aria-pressed={mode === item.id} key={item.id} onClick={() => setMode(item.id)} type="button">{item.short}</button>
                    ))}
                  </div>
                </fieldset>

                {(mode === 'product_to_model' || mode === 'try_on') && (
                  <fieldset className={styles.optionGroup}>
                    <legend>Family</legend>
                    <div className={styles.chipRow}>
                      {FAMILY_PRESETS.map((item) => (
                        <button aria-pressed={familyPreset === item.id} key={item.id} onClick={() => setFamilyPreset(item.id)} type="button">{item.labelBn}</button>
                      ))}
                    </div>
                  </fieldset>
                )}

                <fieldset className={styles.optionGroup}>
                  <legend>Engine</legend>
                  <div className={styles.engineList}>
                    {engines.map((item) => {
                      const availability = engineAvailability(data.config, item.id)
                      const selectable = engineIsSelectable(data.config, item.id)
                      return (
                        <button
                          aria-pressed={engine === item.id}
                          disabled={!selectable}
                          key={item.id}
                          onClick={() => setEngine(item.id)}
                          type="button"
                        >
                          <span><strong>{item.label}</strong><small>{item.status.replace('_', ' ')} · {item.approxCost ?? 'server-priced'}</small></span>
                          <em>{selectable ? 'Available' : availability?.killed ? 'Killed' : availability?.configured ? 'Disabled' : 'Not configured'}</em>
                        </button>
                      )
                    })}
                  </div>
                </fieldset>

                <div className={styles.fidelityCard}>
                  <span>{capability ? fidelityLabel[capability.fidelity] : 'Unsupported combination'}</span>
                  <strong>{selectedEngineDefinition?.label ?? engine}</strong>
                  <p>{capability?.limitationBn ?? 'The server blocks this engine/mode combination before queueing.'}</p>
                  {capability && <small>Required references: {capability.required.join(', ') || 'none'} · max {capability.maxReferences}</small>}
                </div>

                <label className={styles.field}>
                  <span>Creative direction {needsPrompt && <em>Required</em>}</span>
                  <textarea
                    maxLength={1_200}
                    onChange={(event) => setPrompt(event.target.value)}
                    placeholder={mode === 'generate' ? 'Describe the campaign visual…' : 'Optional style and exact change instructions…'}
                    rows={4}
                    value={prompt}
                  />
                </label>

                <fieldset className={styles.optionGroup}>
                  <legend>Background</legend>
                  <div className={styles.chipRow}>
                    {BACKGROUND_PRESETS.map((item) => <button aria-pressed={backgroundId === item.id} key={item.id} onClick={() => setBackgroundId(item.id)} type="button">{item.label}</button>)}
                  </div>
                </fieldset>

                {resolutionState.kind === 'tiered' && (
                  <>
                    <fieldset className={styles.optionGroup}>
                      <legend>Aspect</legend>
                      <div className={styles.chipRow}>
                        {ASPECT_RATIOS.map((value) => (
                          <button
                            aria-pressed={aspectRatio === value}
                            disabled={!resolutionState.supportedAspects.includes(value)}
                            key={value}
                            onClick={() => setAspectRatio(value)}
                            type="button"
                          >
                            {value}
                          </button>
                        ))}
                      </div>
                    </fieldset>
                    <fieldset className={styles.optionGroup}>
                      <legend>Requested resolution</legend>
                      <div className={styles.resolutionGrid}>
                        {(['1k', '2k', '4k'] as FashnResolution[]).map((value) => {
                          const option = resolutionState.resolutionOptions.find((item) => item.value === value)
                          return (
                            <button aria-pressed={resolution === value} disabled={!option} key={value} onClick={() => setResolution(value)} type="button">
                              <strong>{value.toUpperCase()}</strong><small>{option?.label.replace(`${value.toUpperCase()} · `, '') ?? 'Unsupported'}</small>
                            </button>
                          )
                        })}
                      </div>
                    </fieldset>
                  </>
                )}

                <div className={styles.resolutionTruth} data-kind={resolutionState.kind}>
                  <StudioV3Icon name={resolutionState.kind === 'unsupported' ? 'warning' : 'check'} />
                  <div><strong>{resolutionState.labelBn}</strong><span>{resolutionState.detailBn}</span></div>
                </div>

                <div className={styles.inlineFields}>
                  <label><span>Quality</span><select onChange={(event) => setGenerationMode(event.target.value as FashnGenerationMode)} value={generationMode}>{GEN_MODES.map((value) => <option key={value} value={value}>{value}</option>)}</select></label>
                  <label><span>Outputs</span><select onChange={(event) => setNumImages(Number(event.target.value))} value={numImages}>{[1, 2, 3, 4].map((value) => <option key={value} value={value}>{value}</option>)}</select></label>
                </div>

                {engine === 'fal_flux_fill' ? (
                  <button className={styles.secondaryButton} onClick={() => onNavigate({ id: 'finishing', assetId: selectedSource?.id })} type="button">
                    Open Mask Repair <StudioV3Icon name="arrow" />
                  </button>
                ) : (
                  <button className={styles.primaryButton} disabled={!ownerActionAvailable || !ready} onClick={() => setReviewOpen(true)} type="button">
                    Review queue request <StudioV3Icon name="arrow" />
                  </button>
                )}
                {!ready && engine !== 'fal_flux_fill' && (
                  <p className={styles.blockReason}>
                    Missing a required product/person/source/prompt, unavailable engine, or unsupported resolution combination.
                  </p>
                )}
              </div>
            )}
          </aside>
        </div>
      )}

      <StudioConfirmationDialog
        ariaLabel="Review image generation queue request"
        confirmDisabled={!ownerActionAvailable || queueing || (architecture === 'auto' ? !autoReady : !ready)}
        confirmLabel={queueing ? 'Server checking…' : 'Confirm and send to server gate'}
        onCancel={() => setReviewOpen(false)}
        onConfirm={() => void queue()}
        open={reviewOpen}
        summary="This action may create paid provider jobs. The authenticated server re-validates actor and brand access, engine/mode references, capability, cost caps and kill switches before any provider call."
        title="Queue production generation?"
      >
        <dl className={styles.confirmationFacts}>
          <div><dt>Architecture</dt><dd>{architecture}</dd></div>
          <div><dt>Mode</dt><dd>{architecture === 'auto' ? 'server-selected Auto path' : mode}</dd></div>
          <div><dt>Engine</dt><dd>{architecture === 'auto' ? data.config?.singleVtonDefault ?? 'server default' : selectedEngineDefinition?.label ?? engine}</dd></div>
          <div><dt>Resolution</dt><dd>{architecture === 'auto' ? 'server-selected' : resolutionState.kind === 'tiered' ? `${resolutionState.resolution?.toUpperCase()} requested; delivered pixels verified later` : resolutionState.labelBn}</dd></div>
          <div><dt>Cost</dt><dd>{architecture === 'auto' ? 'server policy estimate' : selectedAvailability?.approxCost ?? 'server-calculated'}</dd></div>
          <div><dt>Success truth</dt><dd>Queued is not complete; Gallery shows verified result state.</dd></div>
        </dl>
      </StudioConfirmationDialog>
    </div>
  )
}
