'use client'

import { useMemo, useState } from 'react'
import styles from './CreativeStudioEnterpriseDemo.module.css'
import { CreativeStudioWorkspaceShell } from './CreativeStudioWorkspaceShell'
import { StudioV2Icon } from './StudioV2Icon'
import type { StudioV3Navigate } from './studio-v3-navigation'
import {
  AVATARS,
  BACKGROUNDS,
  FAMILY_PRESETS,
  GALLERY_ASSETS,
  IMAGE_MODES,
  IMAGE_PROVIDERS,
  IMAGE_RECIPES,
  IMAGE_TEMPLATES,
  PRODUCTS,
  VIDEO_MODELS,
  VIDEO_TEMPLATES,
  compatibleImageProviders,
  imageProviderSupports,
  videoModelSupports,
  type AvatarFixture,
  type GalleryAssetFixture,
  type ImageModeId,
} from './studio-v3-fixtures'

type CreativeStudioCreateLabProps = {
  kind: 'image' | 'video'
  initialSourceAssetId?: string
  initialAvatarId?: string
  onNavigate: StudioV3Navigate
}

type LabTab = 'explore' | 'history'
type ImageArchitecture = 'auto' | 'advanced'
type ImageSourceTray = 'product-gallery' | 'model-library' | 'avatar-library' | null

function AssetArtwork({
  asset,
  compact = false,
}: {
  asset: GalleryAssetFixture
  compact?: boolean
}) {
  return (
    <span
      aria-hidden="true"
      className={`${styles.v3AssetArtwork} ${styles[`v3Tone_${asset.tone}`]} ${
        compact ? styles.v3AssetArtworkCompact : ''
      }`}
    >
      <span className={styles.v3AssetMark}>ALMA</span>
      <span className={styles.v3AssetFigure}>
        <i />
        <b />
      </span>
      {asset.type === 'video' && (
        <span className={styles.v3AssetPlay}>
          <StudioV2Icon name="play" size={13} />
        </span>
      )}
    </span>
  )
}

function AvatarRail({
  selectedId,
  onSelect,
  onNavigate,
}: {
  selectedId: string
  onSelect: (avatar: AvatarFixture) => void
  onNavigate: StudioV3Navigate
}) {
  return (
    <section aria-labelledby="avatar-rail-title" className={styles.v3AvatarRail}>
      <div className={styles.v3RailHeading}>
        <div>
          <span className={styles.eyebrow}>IDENTITY LIBRARY</span>
          <h2 id="avatar-rail-title">Avatars & saved models</h2>
          <p>Brand-scoped identity references—not generic assets.</p>
        </div>
        <button
          className={styles.textButton}
          onClick={() => onNavigate({ id: 'gallery', initialType: 'avatar' })}
          type="button"
        >
          View all
          <StudioV2Icon name="chevron-right" size={15} />
        </button>
      </div>

      <div className={styles.v3AvatarScroller}>
        <button
          className={styles.v3NewAvatar}
          onClick={() => onNavigate({ id: 'desk', desk: 'systems' })}
          type="button"
        >
          <span>
            <StudioV2Icon name="plus" size={20} />
          </span>
          <strong>New</strong>
          <small>Owner-gated</small>
        </button>
        {AVATARS.map((avatar) => (
          <button
            aria-pressed={selectedId === avatar.id}
            className={`${styles.v3AvatarCard} ${
              selectedId === avatar.id ? styles.v3AvatarCardSelected : ''
            }`}
            key={avatar.id}
            onClick={() => onSelect(avatar)}
            type="button"
          >
            <span
              className={`${styles.v3AvatarPortrait} ${styles[`v3Tone_${avatar.tone}`]}`}
            >
              <i />
              <b />
              <em>{avatar.imageCount}</em>
            </span>
            <span>
              <strong>{avatar.name}</strong>
              <small>{avatar.role} · {avatar.version}</small>
            </span>
            <span
              className={`${styles.v3AvatarStatus} ${
                avatar.status === 'active'
                  ? styles.v3AvatarStatusActive
                  : avatar.status === 'building'
                    ? styles.v3AvatarStatusBuilding
                    : ''
              }`}
            >
              {avatar.status}
            </span>
          </button>
        ))}
      </div>
      <p className={styles.v3IdentityBoundary}>
        <StudioV2Icon name="lock" size={13} />
        ALMA Lifestyle only · identity source owner and version stay pinned in every request.
      </p>
    </section>
  )
}

function HistoryLedger({ kind }: { kind: 'image' | 'video' }) {
  const rows =
    kind === 'image'
      ? [
          ['Coral hero refinement', 'Verified artifact', 'FASHN direct · 1K', '৳10.50'],
          ['Family composite draft', 'Needs review', 'FASHN + Gemini chain', '৳24.20'],
          ['Embroidery mask repair', 'QC failed', 'FLUX Fill · diagnostic kept', '৳14.75'],
          ['Catalog exploration', 'Draft', 'Grok Imagine · 2K', '৳8.75'],
        ]
      : [
          ['Fabric turn · clip 01', 'Verified artifact', 'Veo · 6 sec · 720p delivered', '৳112.50'],
          ['24 sec reel chain', '2 / 3 clips verified', 'Veo · deterministic chain', '৳300 cap'],
          ['Family Shoot · Cut 03', 'Caption review', 'ALMA local · 1080p preserved', '৳0'],
          ['Offer Promo retry', 'Failed · safe retry', 'No artifact claimed', '৳0 retry'],
        ]

  return (
    <section aria-label={`${kind} history`} className={styles.v3HistoryLedger}>
      <header>
        <div>
          <span className={styles.eyebrow}>TRUTHFUL JOB HISTORY</span>
          <h2>Requests, artifacts and failures stay distinct</h2>
        </div>
        <span>Safe fixtures · read-only</span>
      </header>
      <div>
        {rows.map(([name, state, detail, cost], index) => (
          <article key={name}>
            <span className={styles.v3HistoryIndex}>{String(index + 1).padStart(2, '0')}</span>
            <div>
              <strong>{name}</strong>
              <small>{detail}</small>
            </div>
            <span className={styles.v3HistoryState}>{state}</span>
            <code>{cost}</code>
            <button aria-label={`Inspect ${name}`} type="button">
              <StudioV2Icon name="chevron-right" size={16} />
            </button>
          </article>
        ))}
      </div>
    </section>
  )
}

function ReferencePicker({
  label,
  requirement,
  selectedId,
  assets,
  onSelect,
  onClear,
}: {
  label: string
  requirement: 'optional' | 'required'
  selectedId: string
  assets: readonly GalleryAssetFixture[]
  onSelect: (id: string) => void
  onClear: () => void
}) {
  const selected = assets.find((asset) => asset.id === selectedId)
  return (
    <div className={styles.v3ComposerField}>
      <div className={styles.v3FieldLabel}>
        <span>{label}</span>
        <em>{requirement}</em>
      </div>
      <div className={styles.v3ReferencePicker}>
        {selected ? (
          <button
            aria-label={`Clear ${label}`}
            className={styles.v3SelectedReference}
            onClick={onClear}
            type="button"
          >
            <AssetArtwork asset={selected} compact />
            <span>
              <strong>{selected.title}</strong>
              <small>{selected.resolution} · {selected.source}</small>
            </span>
            <StudioV2Icon name="close" size={15} />
          </button>
        ) : (
          <div className={styles.v3ReferenceChoices}>
            {assets.slice(0, 3).map((asset) => (
              <button
                aria-label={`Select ${asset.title} as ${label}`}
                key={asset.id}
                onClick={() => onSelect(asset.id)}
                type="button"
              >
                <AssetArtwork asset={asset} compact />
                <span>{asset.title}</span>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

function ImageComposer({
  initialTemplateId,
  initialSourceAssetId,
  selectedAvatarId,
  onSelectAvatar,
  onNavigate,
}: {
  initialTemplateId: string
  initialSourceAssetId?: string
  selectedAvatarId: string
  onSelectAvatar: (id: string) => void
  onNavigate: StudioV3Navigate
}) {
  const [architecture, setArchitecture] = useState<ImageArchitecture>('auto')
  const [mode, setMode] = useState<ImageModeId>('product_to_model')
  const [productId, setProductId] = useState(PRODUCTS[0].id)
  const [sourceId, setSourceId] = useState(initialSourceAssetId ?? '')
  const [extraReferenceId, setExtraReferenceId] = useState('')
  const [prompt, setPrompt] = useState(
    'Warm editorial portrait, accurate coral embroidery, quiet Eid evening light.',
  )
  const initialRecipe =
    initialTemplateId === 'family-story'
      ? 'Combined listing'
      : initialTemplateId === 'catalog-clean'
        ? 'Product display image'
        : initialTemplateId === 'offer-social'
          ? 'Social media content'
          : 'Product launch visual'
  const [recipe, setRecipe] = useState<string>(initialRecipe)
  const [providerId, setProviderId] = useState('fashn-direct')
  const [background, setBackground] = useState<(typeof BACKGROUNDS)[number]>('Studio')
  const [aspect, setAspect] = useState<'4:5' | '1:1' | '9:16' | '16:9'>('4:5')
  const [resolution, setResolution] = useState<'1K' | '2K' | '4K'>('1K')
  const [quality, setQuality] = useState<'Fast' | 'Balanced' | 'Quality'>('Balanced')
  const [count, setCount] = useState(1)
  const [family, setFamily] = useState<(typeof FAMILY_PRESETS)[number]>('Single')
  const [placement, setPlacement] = useState('Auto')
  const [autoFamily, setAutoFamily] = useState(false)
  const [autoReel, setAutoReel] = useState(false)
  const [sourceTray, setSourceTray] = useState<ImageSourceTray>(null)
  const [localProductName, setLocalProductName] = useState('')
  const [localModelName, setLocalModelName] = useState('')
  const [isExpanded, setIsExpanded] = useState(false)
  const [localStatus, setLocalStatus] = useState(
    'Configuration is local to this prototype. Nothing has been queued.',
  )

  const activeMode = IMAGE_MODES.find((item) => item.id === mode) ?? IMAGE_MODES[0]
  const providers = compatibleImageProviders(mode)
  const provider =
    IMAGE_PROVIDERS.find((item) => item.id === providerId) ?? providers[0] ?? IMAGE_PROVIDERS[0]
  const imageAssets = GALLERY_ASSETS.filter((asset) => asset.type === 'image')
  const selectedAvatar = AVATARS.find((avatar) => avatar.id === selectedAvatarId)
  const selectedProduct = PRODUCTS.find((product) => product.id === productId)

  const missingRequirements = useMemo(() => {
    const missing: string[] = []
    if (activeMode.product === 'required' && !productId && !localProductName) {
      missing.push('product reference')
    }
    if (activeMode.avatar === 'required' && !selectedAvatarId && !localModelName) {
      missing.push('model / avatar')
    }
    if (activeMode.source === 'required' && !sourceId) missing.push('source image')
    if (mode === 'generate' && !prompt.trim()) missing.push('prompt')
    if (mode !== 'reel' && !imageProviderSupports(provider.id, mode, resolution)) {
      missing.push(`${provider.label} does not support ${mode} at ${resolution}`)
    }
    if (mode !== 'reel' && provider.researchOnly) missing.push('commercial policy approval')
    return missing
  }, [
    activeMode,
    localModelName,
    localProductName,
    mode,
    productId,
    prompt,
    provider,
    resolution,
    selectedAvatarId,
    sourceId,
  ])

  const estimatedBdt =
    mode === 'reel' || resolution === '4K'
      ? null
      : provider.estimate[resolution] === null
        ? null
        : (provider.estimate[resolution] ?? 0) * count

  function chooseMode(nextMode: ImageModeId) {
    const nextProvider = compatibleImageProviders(nextMode)[0]
    setMode(nextMode)
    if (nextProvider) {
      setProviderId(nextProvider.id)
      setResolution(nextProvider.resolutions[0])
    }
    setLocalStatus('Mode changed. Reference requirements and engine capabilities were recalculated.')
  }

  function chooseProvider(nextProviderId: string) {
    const nextProvider = IMAGE_PROVIDERS.find((item) => item.id === nextProviderId)
    setProviderId(nextProviderId)
    if (
      nextProvider &&
      resolution !== '4K' &&
      !nextProvider.resolutions.includes(resolution)
    ) {
      setResolution(nextProvider.resolutions[0])
    }
  }

  if (architecture === 'auto') {
    return (
      <section
        aria-labelledby="image-composer-title"
        className={`${styles.v3Composer} ${styles.v4FloatingComposer} ${styles.v4ComposerAuto} ${
          isExpanded ? styles.v6ComposerExpanded : ''
        }`}
        data-workspace={isExpanded ? 'expanded' : 'compact'}
      >
        <div className={styles.v4ComposerRecipes} aria-label="Quick recipes">
          {IMAGE_RECIPES.slice(0, 3).map((item) => (
            <button
              aria-pressed={recipe === item}
              key={item}
              onClick={() => setRecipe(item)}
              type="button"
            >
              <StudioV2Icon name="template" size={13} />
              {item}
            </button>
          ))}
        </div>

        <header className={styles.v4ComposerHeader}>
          <div>
            <span className={styles.eyebrow}>IMAGE LAB</span>
            <h2 id="image-composer-title">Create a product image</h2>
          </div>
          <div className={styles.v4ComposerTabs} role="tablist" aria-label="Image workflow">
            <button
              aria-selected
              className={styles.v4ComposerTabActive}
              onClick={() => setArchitecture('auto')}
              role="tab"
              type="button"
            >
              Auto
            </button>
            <button
              aria-selected={false}
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
              <span aria-hidden="true" className={styles.v6ExpandGlyph}>
                <i />
                <i />
              </span>
            </button>
            <span className={styles.v4LocalOnlyBadge}>
              <StudioV2Icon name="lock" size={12} />
              $0 demo
            </span>
          </div>
        </header>

        <div className={styles.v4AutoSourceGrid}>
          <section className={styles.v4SourceCard}>
            <div className={`${styles.v4SourceArtwork} ${styles.v3Tone_coral}`}>
              <span>PRODUCT</span>
              <i />
              <b />
            </div>
            <div className={styles.v4SourceContent}>
              <span>PRODUCT</span>
              <strong>{localProductName || selectedProduct?.name || 'Choose product'}</strong>
              <small>{localProductName ? 'Local demo source' : selectedProduct?.code}</small>
              <div className={styles.v4SourceActions}>
                <button
                  onClick={() => {
                    setLocalStatus('Clipboard paste is represented locally in this demo.')
                    setLocalProductName('Pasted product image')
                  }}
                  type="button"
                >
                  <StudioV2Icon name="projects" size={13} />
                  Paste
                </button>
                <label>
                  <input
                    accept="image/*"
                    onChange={(event) => {
                      const file = event.target.files?.[0]
                      if (!file) return
                      setLocalProductName(file.name)
                      setLocalStatus(`${file.name} staged locally as the product source.`)
                    }}
                    type="file"
                  />
                  <StudioV2Icon name="plus" size={13} />
                  Upload
                </label>
                <button
                  aria-expanded={sourceTray === 'product-gallery'}
                  onClick={() =>
                    setSourceTray((current) => current === 'product-gallery' ? null : 'product-gallery')
                  }
                  type="button"
                >
                  <StudioV2Icon name="grid" size={13} />
                  Gallery
                </button>
              </div>
            </div>
          </section>

          <section className={styles.v4SourceCard}>
            <div className={`${styles.v4SourceArtwork} ${styles.v4ModelArtwork} ${styles.v3Tone_ink}`}>
              <span>MODEL</span>
              <i />
              <b />
            </div>
            <div className={styles.v4SourceContent}>
              <span>MODEL</span>
              <strong>{localModelName || selectedAvatar?.name || 'Choose model'}</strong>
              <small>{localModelName ? 'New local model' : selectedAvatar?.version}</small>
              <div className={styles.v4SourceActions}>
                <button
                  aria-expanded={sourceTray === 'model-library'}
                  onClick={() =>
                    setSourceTray((current) => current === 'model-library' ? null : 'model-library')
                  }
                  type="button"
                >
                  <StudioV2Icon name="library" size={13} />
                  Library
                </button>
                <label>
                  <input
                    accept="image/*"
                    onChange={(event) => {
                      const file = event.target.files?.[0]
                      if (!file) return
                      setLocalModelName(file.name)
                      setLocalStatus(`${file.name} staged locally as a new model reference.`)
                    }}
                    type="file"
                  />
                  <StudioV2Icon name="plus" size={13} />
                  Upload
                </label>
                <button
                  aria-expanded={sourceTray === 'avatar-library'}
                  onClick={() =>
                    setSourceTray((current) => current === 'avatar-library' ? null : 'avatar-library')
                  }
                  type="button"
                >
                  <StudioV2Icon name="agent" size={13} />
                  Avatar
                </button>
              </div>
            </div>
          </section>
        </div>

        {sourceTray && (
          <section className={styles.v4SourceTray}>
            <header>
              <div>
                <span className={styles.eyebrow}>
                  {sourceTray === 'product-gallery' ? 'PRODUCT GALLERY' : 'MODEL & AVATAR LIBRARY'}
                </span>
                <strong>
                  {sourceTray === 'product-gallery'
                    ? 'Choose an approved product'
                    : 'Choose a saved model or avatar'}
                </strong>
              </div>
              <button aria-label="Close source picker" onClick={() => setSourceTray(null)} type="button">
                <StudioV2Icon name="close" size={16} />
              </button>
            </header>
            <div>
              {sourceTray === 'product-gallery'
                ? PRODUCTS.map((product) => (
                    <button
                      aria-pressed={productId === product.id && !localProductName}
                      key={product.id}
                      onClick={() => {
                        setProductId(product.id)
                        setLocalProductName('')
                        setSourceTray(null)
                      }}
                      type="button"
                    >
                      <span className={`${styles.v3ProductSwatch} ${styles[`v3Tone_${product.tone}`]}`} />
                      <span>
                        <strong>{product.name}</strong>
                        <small>{product.code} · {product.resolution}</small>
                      </span>
                    </button>
                  ))
                : AVATARS.map((avatar) => (
                    <button
                      aria-pressed={selectedAvatarId === avatar.id && !localModelName}
                      key={avatar.id}
                      onClick={() => {
                        onSelectAvatar(avatar.id)
                        setLocalModelName('')
                        setSourceTray(null)
                      }}
                      type="button"
                    >
                      <span
                        className={`${styles.v3AvatarPortrait} ${styles[`v3Tone_${avatar.tone}`]}`}
                      >
                        <i />
                        <b />
                      </span>
                      <span>
                        <strong>{avatar.name}</strong>
                        <small>{avatar.role} · {avatar.version}</small>
                      </span>
                    </button>
                  ))}
            </div>
          </section>
        )}

        <label className={styles.v3PromptField}>
          <span className={styles.srOnly}>Creative direction</span>
          <textarea
            aria-label="Creative direction"
            onChange={(event) => setPrompt(event.target.value)}
            placeholder="Describe the image you want to create…"
            value={prompt}
          />
        </label>

        <footer className={styles.v4ComposerFooter}>
          <div className={styles.v4ComposerControls} aria-label="Auto image settings">
            <button type="button">
              <StudioV2Icon name="image" size={13} />
              FASHN v1.6
            </button>
            <button type="button">4:5</button>
            <button type="button">1K</button>
            <label>
              <input
                checked={autoFamily}
                onChange={(event) => setAutoFamily(event.target.checked)}
                type="checkbox"
              />
              Family
            </label>
            <label>
              <input
                checked={autoReel}
                onChange={(event) => setAutoReel(event.target.checked)}
                type="checkbox"
              />
              + 6s reel
            </label>
          </div>
          <span className={styles.v4ComposerEstimate}>
            <strong>৳9.38</strong>
            <small>review first</small>
          </span>
          <button
            aria-label="Save local image brief"
            className={styles.v4ComposerSave}
            onClick={() => setLocalStatus('Auto brief saved in local component state only.')}
            type="button"
          >
            <StudioV2Icon name="check" size={15} />
          </button>
          <button
            aria-label="Generation disconnected in demo"
            className={styles.v4ComposerSubmit}
            disabled
            type="button"
          >
            <StudioV2Icon name="publish" size={17} />
          </button>
        </footer>
        <p className={styles.v4ComposerStatus} role="status">{localStatus}</p>
      </section>
    )
  }

  return (
    <section
      aria-labelledby="image-composer-title"
      className={`${styles.v3Composer} ${styles.v4FloatingComposer} ${styles.v4ComposerAdvanced} ${
        isExpanded ? styles.v6ComposerExpanded : ''
      }`}
      data-workspace={isExpanded ? 'expanded' : 'compact'}
    >
      <header className={styles.v3ComposerHeader}>
        <div>
          <span className={styles.eyebrow}>IMAGE COMPOSER</span>
          <h2 id="image-composer-title">Advanced control desk</h2>
          <p>Mode-aware references, provider truth and owner-reviewed cost.</p>
        </div>
        <div className={styles.v6ComposerHeaderActions}>
          <button
            aria-label={isExpanded ? 'Collapse image workspace' : 'Expand image workspace'}
            className={styles.v6ComposerExpand}
            onClick={() => setIsExpanded((current) => !current)}
            title={isExpanded ? 'Return to compact composer' : 'Open full workspace'}
            type="button"
          >
            <span aria-hidden="true" className={styles.v6ExpandGlyph}>
              <i />
              <i />
            </span>
          </button>
          <span className={styles.v3NoRunBadge}>No API connected</span>
        </div>
      </header>

      <div className={styles.v3ArchitectureSwitch} role="tablist" aria-label="Image workflow">
        <button
          aria-selected={false}
          onClick={() => setArchitecture('auto')}
          role="tab"
          type="button"
        >
          Auto
          <small>Fast product flow</small>
        </button>
        <button
          aria-selected
          className={styles.v3ArchitectureActive}
          onClick={() => setArchitecture('advanced')}
          role="tab"
          type="button"
        >
          Advanced
          <small>7 production modes</small>
        </button>
      </div>

      <div className={styles.v3ModeScroller} role="tablist" aria-label="Advanced image modes">
        {IMAGE_MODES.map((item) => (
          <button
            aria-selected={mode === item.id}
            className={mode === item.id ? styles.v3ModeActive : undefined}
            data-mode={item.id}
            key={item.id}
            onClick={() => chooseMode(item.id)}
            role="tab"
            type="button"
          >
            <StudioV2Icon name={item.icon} size={16} />
            <span>
              <strong>{item.label}</strong>
              <small>{item.shortLabel}</small>
            </span>
          </button>
        ))}
      </div>

      <div className={styles.v3ModeExplanation}>
        <span>{activeMode.shortLabel}</span>
        <p>{activeMode.description}</p>
      </div>

      <div className={styles.v6AdvancedSourceGrid} aria-label="Advanced image sources">
        <section
          className={styles.v4SourceCard}
          data-required={activeMode.product === 'required'}
        >
          <div className={`${styles.v4SourceArtwork} ${styles.v3Tone_coral}`}>
            <span>PRODUCT</span>
            <i />
            <b />
          </div>
          <div className={styles.v4SourceContent}>
            <span>
              PRODUCT
              <em>{activeMode.product === 'hidden' ? 'OPTIONAL' : activeMode.product}</em>
            </span>
            <strong>{localProductName || selectedProduct?.name || 'Choose product'}</strong>
            <small>{localProductName ? 'Local demo source' : selectedProduct?.code}</small>
            <div className={styles.v4SourceActions}>
              <button
                onClick={() => {
                  setLocalStatus('Clipboard paste is represented locally in this demo.')
                  setLocalProductName('Pasted product image')
                }}
                type="button"
              >
                <StudioV2Icon name="projects" size={13} />
                Paste
              </button>
              <label>
                <input
                  accept="image/*"
                  onChange={(event) => {
                    const file = event.target.files?.[0]
                    if (!file) return
                    setLocalProductName(file.name)
                    setLocalStatus(`${file.name} staged locally as the product source.`)
                  }}
                  type="file"
                />
                <StudioV2Icon name="plus" size={13} />
                Upload
              </label>
              <button
                aria-expanded={sourceTray === 'product-gallery'}
                onClick={() =>
                  setSourceTray((current) =>
                    current === 'product-gallery' ? null : 'product-gallery',
                  )
                }
                type="button"
              >
                <StudioV2Icon name="grid" size={13} />
                Gallery
              </button>
            </div>
          </div>
        </section>

        <section
          className={styles.v4SourceCard}
          data-required={activeMode.avatar === 'required'}
        >
          <div className={`${styles.v4SourceArtwork} ${styles.v4ModelArtwork} ${styles.v3Tone_ink}`}>
            <span>MODEL</span>
            <i />
            <b />
          </div>
          <div className={styles.v4SourceContent}>
            <span>
              MODEL
              <em>{activeMode.avatar === 'hidden' ? 'OPTIONAL' : activeMode.avatar}</em>
            </span>
            <strong>{localModelName || selectedAvatar?.name || 'Choose model'}</strong>
            <small>{localModelName ? 'New local model' : selectedAvatar?.version}</small>
            <div className={styles.v4SourceActions}>
              <button
                aria-expanded={sourceTray === 'model-library'}
                onClick={() =>
                  setSourceTray((current) => current === 'model-library' ? null : 'model-library')
                }
                type="button"
              >
                <StudioV2Icon name="library" size={13} />
                Library
              </button>
              <label>
                <input
                  accept="image/*"
                  onChange={(event) => {
                    const file = event.target.files?.[0]
                    if (!file) return
                    setLocalModelName(file.name)
                    setLocalStatus(`${file.name} staged locally as a new model reference.`)
                  }}
                  type="file"
                />
                <StudioV2Icon name="plus" size={13} />
                Upload
              </label>
              <button
                aria-expanded={sourceTray === 'avatar-library'}
                onClick={() =>
                  setSourceTray((current) => current === 'avatar-library' ? null : 'avatar-library')
                }
                type="button"
              >
                <StudioV2Icon name="agent" size={13} />
                Avatar
              </button>
            </div>
          </div>
        </section>
      </div>

      {sourceTray && (
        <section className={`${styles.v4SourceTray} ${styles.v6AdvancedSourceTray}`}>
          <header>
            <div>
              <span className={styles.eyebrow}>
                {sourceTray === 'product-gallery' ? 'PRODUCT GALLERY' : 'MODEL & AVATAR LIBRARY'}
              </span>
              <strong>
                {sourceTray === 'product-gallery'
                  ? 'Choose an approved product'
                  : 'Choose a saved model or avatar'}
              </strong>
            </div>
            <button aria-label="Close source picker" onClick={() => setSourceTray(null)} type="button">
              <StudioV2Icon name="close" size={16} />
            </button>
          </header>
          <div>
            {sourceTray === 'product-gallery'
              ? PRODUCTS.map((product) => (
                  <button
                    aria-pressed={productId === product.id && !localProductName}
                    key={product.id}
                    onClick={() => {
                      setProductId(product.id)
                      setLocalProductName('')
                      setSourceTray(null)
                    }}
                    type="button"
                  >
                    <span className={`${styles.v3ProductSwatch} ${styles[`v3Tone_${product.tone}`]}`} />
                    <span>
                      <strong>{product.name}</strong>
                      <small>{product.code} · {product.resolution}</small>
                    </span>
                  </button>
                ))
              : AVATARS.map((avatar) => (
                  <button
                    aria-pressed={selectedAvatarId === avatar.id && !localModelName}
                    key={avatar.id}
                    onClick={() => {
                      onSelectAvatar(avatar.id)
                      setLocalModelName('')
                      setSourceTray(null)
                    }}
                    type="button"
                  >
                    <span
                      className={`${styles.v3AvatarPortrait} ${styles[`v3Tone_${avatar.tone}`]}`}
                    >
                      <i />
                      <b />
                    </span>
                    <span>
                      <strong>{avatar.name}</strong>
                      <small>{avatar.role} · {avatar.version}</small>
                    </span>
                  </button>
                ))}
          </div>
        </section>
      )}

      <div className={styles.v3RecipeScroller} aria-label="Saved recipe templates">
        {IMAGE_RECIPES.map((item) => (
          <button
            aria-pressed={recipe === item}
            className={recipe === item ? styles.v3RecipeSelected : undefined}
            key={item}
            onClick={() => setRecipe(item)}
            type="button"
          >
            <StudioV2Icon name="template" size={14} />
            {item}
          </button>
        ))}
      </div>

      <div className={styles.v3ComposerBody}>
        <details className={styles.v5ComposerDisclosure}>
          <summary aria-label="Sources" role="button">
            <span>
              <StudioV2Icon name="assets" size={15} />
              Sources
            </span>
            <small>
              {activeMode.product !== 'hidden' ? 'Product' : ''}
              {activeMode.avatar !== 'hidden' ? ' · Identity' : ''}
              {activeMode.source !== 'hidden' ? ' · Source image' : ''}
              {activeMode.extraReference !== 'hidden' ? ' · Extra reference' : ''}
              {activeMode.product === 'hidden' &&
              activeMode.avatar === 'hidden' &&
              activeMode.source === 'hidden'
                ? 'No source required'
                : ''}
            </small>
          </summary>
          <div className={`${styles.v5DisclosureBody} ${styles.v6SourcesControlDeck}`}>
            {activeMode.product !== 'hidden' && (
              <div className={styles.v3ComposerField}>
                <div className={styles.v3FieldLabel}>
                  <span>Product / mannequin</span>
                  <em>{activeMode.product}</em>
                </div>
                <div className={styles.v3ProductSelect}>
                  {PRODUCTS.map((product) => (
                    <button
                      aria-pressed={productId === product.id}
                      className={productId === product.id ? styles.v3ReferenceSelected : undefined}
                      key={product.id}
                      onClick={() => setProductId(productId === product.id ? '' : product.id)}
                      type="button"
                    >
                      <span className={`${styles.v3ProductSwatch} ${styles[`v3Tone_${product.tone}`]}`} />
                      <span>
                        <strong>{product.name}</strong>
                        <small>{product.code} · {product.resolution}</small>
                      </span>
                      {product.status === 'needs_reference' && <em>Low source</em>}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {activeMode.avatar !== 'hidden' && (
              <div className={styles.v3ComposerField}>
                <div className={styles.v3FieldLabel}>
                  <span>Saved model / identity avatar</span>
                  <em>{activeMode.avatar}</em>
                </div>
                <div className={styles.v3AvatarReference}>
                  {selectedAvatar ? (
                    <button
                      aria-label="Clear selected identity avatar"
                      className={styles.v3SelectedAvatarReference}
                      onClick={() => onSelectAvatar('')}
                      type="button"
                    >
                      <span
                        className={`${styles.v3AvatarPortrait} ${styles[`v3Tone_${selectedAvatar.tone}`]}`}
                      >
                        <i />
                        <b />
                      </span>
                      <span>
                        <strong>{selectedAvatar.name}</strong>
                        <small>{selectedAvatar.version} · {selectedAvatar.imageCount} angles</small>
                      </span>
                      <span className={styles.v3PinnedIdentity}>
                        <StudioV2Icon name="lock" size={12} />
                        Brand pinned
                      </span>
                      <StudioV2Icon name="close" size={15} />
                    </button>
                  ) : (
                    AVATARS.slice(0, 3).map((avatar) => (
                      <button
                        aria-label={`Select identity avatar ${avatar.name}`}
                        key={avatar.id}
                        onClick={() => onSelectAvatar(avatar.id)}
                        type="button"
                      >
                        <span
                          className={`${styles.v3AvatarPortrait} ${styles[`v3Tone_${avatar.tone}`]}`}
                        >
                          <i />
                          <b />
                        </span>
                        <span>{avatar.name}</span>
                      </button>
                    ))
                  )}
                </div>
              </div>
            )}

            {activeMode.source !== 'hidden' && (
              <ReferencePicker
                assets={imageAssets}
                label="Source image"
                onClear={() => setSourceId('')}
                onSelect={setSourceId}
                requirement={activeMode.source}
                selectedId={sourceId}
              />
            )}

            {activeMode.extraReference !== 'hidden' && (
              <ReferencePicker
                assets={imageAssets.filter((asset) => asset.id !== sourceId)}
                label="Extra image reference"
                onClear={() => setExtraReferenceId('')}
                onSelect={setExtraReferenceId}
                requirement="optional"
                selectedId={extraReferenceId}
              />
            )}

            {activeMode.family && (
              <div className={styles.v3ComposerField}>
                <div className={styles.v3FieldLabel}>
                  <span>Composition preset</span>
                  <em>hard family roles</em>
                </div>
                <div className={styles.v3SegmentedWrap}>
                  {FAMILY_PRESETS.map((item) => (
                    <button
                      aria-pressed={family === item}
                      className={family === item ? styles.v3SegmentActive : undefined}
                      key={item}
                      onClick={() => setFamily(item)}
                      type="button"
                    >
                      {item}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {mode === 'try_on' && (
              <div className={styles.v3ComposerField}>
                <div className={styles.v3FieldLabel}>
                  <span>Garment placement</span>
                  <em>provider contract</em>
                </div>
                <div className={styles.v3SegmentedWrap}>
                  {['Auto', 'Overall', 'Upper', 'Lower', 'Outer'].map((item) => (
                    <button
                      aria-pressed={placement === item}
                      className={placement === item ? styles.v3SegmentActive : undefined}
                      key={item}
                      onClick={() => setPlacement(item)}
                      type="button"
                    >
                      {item}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
        </details>

        <label className={styles.v3PromptField}>
          <span>
            Prompt
            <em>{mode === 'generate' ? 'required' : 'creative direction'}</em>
          </span>
          <textarea
            aria-label={`${activeMode.label} creative direction`}
            onChange={(event) => setPrompt(event.target.value)}
            value={prompt}
          />
        </label>

        {mode !== 'reel' && (
          <details className={styles.v5ComposerDisclosure}>
            <summary aria-label="Production controls" role="button">
              <span>
                <StudioV2Icon name="inspector" size={15} />
                Production controls
              </span>
              <small>{provider.label} · {aspect} · {resolution} · {quality} · {count} output</small>
            </summary>
            <div className={`${styles.v5DisclosureBody} ${styles.v6ProductionControlDeck}`}>
              <div className={styles.v3ControlGrid}>
                <label>
                  <span>Provider / model</span>
                  <select
                    onChange={(event) => chooseProvider(event.target.value)}
                    value={provider.id}
                  >
                    {providers.map((item) => (
                      <option key={item.id} value={item.id}>
                        {item.label} · {item.badge}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  <span>Background</span>
                  <select
                    onChange={(event) =>
                      setBackground(event.target.value as (typeof BACKGROUNDS)[number])
                    }
                    value={background}
                  >
                    {BACKGROUNDS.map((item) => <option key={item}>{item}</option>)}
                  </select>
                </label>
              </div>

              <div className={styles.v3OptionGroup}>
                <div className={styles.v3FieldLabel}>
                  <span>Aspect</span>
                  <em>request</em>
                </div>
                <div className={styles.v3OptionRow}>
                  {(['4:5', '1:1', '9:16', '16:9'] as const).map((item) => (
                    <button
                      aria-pressed={aspect === item}
                      className={aspect === item ? styles.v3SegmentActive : undefined}
                      key={item}
                      onClick={() => setAspect(item)}
                      type="button"
                    >
                      {item}
                    </button>
                  ))}
                </div>
              </div>

              <div className={styles.v3OptionGroup}>
                <div className={styles.v3FieldLabel}>
                  <span>Resolution</span>
                  <em>requested ≠ delivered until verified</em>
                </div>
                <div className={styles.v3OptionRow}>
                  {(['1K', '2K', '4K'] as const).map((item) => {
                    const supported = imageProviderSupports(provider.id, mode, item)
                    return (
                      <button
                        aria-pressed={resolution === item}
                        className={resolution === item ? styles.v3SegmentActive : undefined}
                        disabled={!supported}
                        key={item}
                        onClick={() => setResolution(item)}
                        title={
                          supported
                            ? `${provider.label} advertises native ${item}`
                            : item === '4K'
                              ? 'No integrated provider advertises native 4K; upscale is prohibited.'
                              : `${provider.label} does not support ${item} for this mode.`
                        }
                        type="button"
                      >
                        {item}
                        {!supported && <small>Unavailable</small>}
                      </button>
                    )
                  })}
                </div>
                <p className={styles.v3CapabilityNote}>
                  <StudioV2Icon
                    name={provider.researchOnly ? 'lock' : 'check'}
                    size={13}
                  />
                  {provider.note}
                </p>
              </div>

              <div className={styles.v3ControlGrid}>
                <div className={styles.v3OptionGroup}>
                  <div className={styles.v3FieldLabel}>
                    <span>Quality</span>
                    <em>safety checks stay on</em>
                  </div>
                  <div className={styles.v3OptionRow}>
                    {(['Fast', 'Balanced', 'Quality'] as const).map((item) => (
                      <button
                        aria-pressed={quality === item}
                        className={quality === item ? styles.v3SegmentActive : undefined}
                        key={item}
                        onClick={() => setQuality(item)}
                        type="button"
                      >
                        {item}
                      </button>
                    ))}
                  </div>
                </div>
                <div className={styles.v3OptionGroup}>
                  <div className={styles.v3FieldLabel}>
                    <span>Outputs</span>
                    <em>1–4</em>
                  </div>
                  <div className={styles.v3OptionRow}>
                    {[1, 2, 3, 4].map((item) => (
                      <button
                        aria-pressed={count === item}
                        className={count === item ? styles.v3SegmentActive : undefined}
                        key={item}
                        onClick={() => setCount(item)}
                        type="button"
                      >
                        {item}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          </details>
        )}
      </div>

      <div className={styles.v3ComposerReadiness}>
        <div>
          <span className={missingRequirements.length ? styles.v3ReadinessBlocked : styles.v3ReadinessReady}>
            <StudioV2Icon name={missingRequirements.length ? 'lock' : 'check'} size={15} />
          </span>
          <span>
            <strong>
              {missingRequirements.length
                ? `${missingRequirements.length} gate${missingRequirements.length > 1 ? 's' : ''} unresolved`
                : 'Configuration ready for owner cost review'}
            </strong>
            <small>
              {missingRequirements.length
                ? missingRequirements.join(' · ')
                : mode === 'reel'
                  ? 'Source ready · continue in Video Lab'
                  : `${provider.label} · ${aspect} · ${resolution} · ${quality}`}
            </small>
          </span>
        </div>
        <div>
          <span>ESTIMATE</span>
          <strong>{estimatedBdt === null ? 'Unavailable' : `৳${estimatedBdt.toFixed(2)}`}</strong>
          <small>Actual cost belongs to verified result</small>
        </div>
      </div>

      <footer className={styles.v3ComposerFooter}>
        <div>
          <StudioV2Icon name="lock" size={15} />
          <span>
            <strong>Plan and configuration only</strong>
            <small>{localStatus}</small>
          </span>
        </div>
        {mode === 'reel' ? (
          <button
            className={styles.primaryButton}
            disabled={!sourceId}
            onClick={() => onNavigate({ id: 'video-lab', sourceAssetId: sourceId })}
            type="button"
          >
            Continue in Video Lab
            <StudioV2Icon name="chevron-right" size={17} />
          </button>
        ) : (
          <>
            <button
              className={styles.secondaryButton}
              onClick={() => setLocalStatus('Configuration saved in local demo state. No request was created.')}
              type="button"
            >
              Save local configuration
            </button>
            <button className={styles.v3DisconnectedButton} disabled type="button">
              Generation disconnected
            </button>
          </>
        )}
      </footer>
    </section>
  )
}

function VideoComposer({
  initialTemplateId,
  initialSourceAssetId,
  selectedAvatarId,
  onNavigate,
}: {
  initialTemplateId: string
  initialSourceAssetId?: string
  selectedAvatarId: string
  onNavigate: StudioV3Navigate
}) {
  const imageSources = GALLERY_ASSETS.filter((asset) => asset.type === 'image')
  const videoSources = GALLERY_ASSETS.filter((asset) => asset.type === 'video')
  const initialOwnedRecipe = initialTemplateId !== 'premium-turn'
  const initialModel = initialOwnedRecipe ? VIDEO_MODELS[1] : VIDEO_MODELS[0]
  const [modelId, setModelId] = useState(initialModel.id)
  const [sourceId, setSourceId] = useState(
    initialSourceAssetId && GALLERY_ASSETS.some((asset) => asset.id === initialSourceAssetId)
      ? initialSourceAssetId
      : initialOwnedRecipe
        ? videoSources[0].id
        : imageSources[0].id,
  )
  const templateId = initialTemplateId
  const [duration, setDuration] = useState(initialModel.durations[0])
  const [resolution, setResolution] = useState<'720p' | '1080p' | '4K'>(
    initialModel.resolutions[0],
  )
  const [aspect, setAspect] = useState<'9:16' | '1:1' | '16:9'>(
    initialModel.aspects[0],
  )
  const [startFrameId, setStartFrameId] = useState(sourceId)
  const [endFrameId, setEndFrameId] = useState('')
  const [imageReferenceId, setImageReferenceId] = useState('')
  const [prompt, setPrompt] = useState(
    'A restrained fabric turn with a slow camera push, accurate embroidery and natural evening light.',
  )
  const [audioMode, setAudioMode] = useState<'generate' | 'mute'>('mute')
  const [count, setCount] = useState(1)
  const [localStatus, setLocalStatus] = useState(
    'No video job exists. Capability review is local and reversible.',
  )

  const model = VIDEO_MODELS.find((item) => item.id === modelId) ?? VIDEO_MODELS[0]
  const selectedSource = GALLERY_ASSETS.find((asset) => asset.id === sourceId)
  const sourceOptions = model.id === 'owned-local' ? videoSources : imageSources
  const estimatedBdt = duration * model.estimatePerSecondBdt * count
  const valid =
    videoModelSupports(model.id, duration, resolution, aspect) ||
    (model.id === 'veo-preview' &&
      (duration === 16 || duration === 24) &&
      resolution === '720p' &&
      (aspect === '9:16' || aspect === '16:9'))

  function chooseModel(nextModelId: string) {
    const next = VIDEO_MODELS.find((item) => item.id === nextModelId)
    if (!next) return
    setModelId(next.id)
    setDuration(next.durations[0])
    setResolution(next.resolutions[0])
    setAspect(next.aspects[0])
    const nextSource = next.id === 'owned-local' ? videoSources[0] : imageSources[0]
    setSourceId(nextSource.id)
    setStartFrameId(next.id === 'owned-local' ? '' : nextSource.id)
    setEndFrameId('')
    setLocalStatus('Model changed. Source, duration, aspect and resolution were constrained to its manifest.')
  }

  return (
    <section
      aria-labelledby="video-composer-title"
      className={`${styles.v3Composer} ${styles.v4FloatingComposer} ${styles.v5VideoComposer}`}
    >
      <header className={styles.v3ComposerHeader}>
        <div>
          <span className={styles.eyebrow}>VIDEO COMPOSER</span>
          <h2 id="video-composer-title">Source-first motion brief</h2>
          <p>
            {VIDEO_TEMPLATES.find((item) => item.id === templateId)?.title} · choose
            owned/gallery media before delivery capability.
          </p>
        </div>
        <span className={styles.v3NoRunBadge}>No API connected</span>
      </header>

      <div className={styles.v6VideoStage}>
        <div className={styles.v6VideoStageArtwork}>
          <AssetArtwork asset={selectedSource ?? sourceOptions[0]} compact />
          <span aria-hidden="true">
            <StudioV2Icon name="video" size={18} />
          </span>
        </div>
        <div className={styles.v6VideoStageCopy}>
          <span>SELECTED SOURCE</span>
          <strong>{selectedSource?.title ?? 'Choose a source'}</strong>
          <small>
            {selectedSource?.subtype ?? 'Gallery media'} · source remains pinned through review
          </small>
        </div>
        <div className={styles.v6VideoStageSpecs}>
          <span>
            <small>MODEL</small>
            <strong>{model.label}</strong>
          </span>
          <span>
            <small>DELIVERY</small>
            <strong>{duration}s · {aspect} · {resolution}</strong>
          </span>
        </div>
      </div>

      <details className={styles.v5ComposerDisclosure}>
        <summary>
          <span>
            <StudioV2Icon name="assets" size={15} />
            Change source
          </span>
          <small>{selectedSource?.subtype ?? 'Gallery media'} · owner-approved fixtures</small>
        </summary>
        <div className={`${styles.v3SourceStage} ${styles.v5DisclosureBody}`}>
          <div className={styles.v3FieldLabel}>
            <span>01 · Gallery source</span>
            <em>required</em>
          </div>
          <div className={styles.v3SourceStrip}>
            {sourceOptions.slice(0, 5).map((asset) => (
              <button
                aria-label={`Use ${asset.title} as the video source`}
                aria-pressed={sourceId === asset.id}
                className={sourceId === asset.id ? styles.v3SourceSelected : undefined}
                key={asset.id}
                onClick={() => {
                  setSourceId(asset.id)
                  if (model.id !== 'owned-local') setStartFrameId(asset.id)
                }}
                type="button"
              >
                <AssetArtwork asset={asset} compact />
                <span>
                  <strong>{asset.title}</strong>
                  <small>{asset.subtype} · {asset.resolution}</small>
                </span>
              </button>
            ))}
          </div>
          <button
            className={styles.textButton}
            onClick={() =>
              onNavigate({
                id: 'gallery',
                initialType: model.id === 'owned-local' ? 'video' : 'image',
              })
            }
            type="button"
          >
            Open full Gallery
            <StudioV2Icon name="chevron-right" size={15} />
          </button>
        </div>
      </details>

      <label className={styles.v3PromptField}>
        <span>
          {model.id === 'owned-local' ? 'Edit direction' : 'Motion prompt'}
          <em>{model.id === 'owned-local' ? 'hard recipe stays authoritative' : 'required'}</em>
        </span>
        <textarea
          aria-label={model.id === 'owned-local' ? 'Video edit direction' : 'Video motion prompt'}
          onChange={(event) => setPrompt(event.target.value)}
          value={prompt}
        />
      </label>

      <details className={styles.v5ComposerDisclosure}>
        <summary>
          <span>
            <StudioV2Icon name="inspector" size={15} />
            Motion settings
          </span>
          <small>{model.label} · {duration}s · {aspect} · {resolution} · {audioMode}</small>
        </summary>
        <div className={`${styles.v3ComposerBody} ${styles.v5DisclosureBody}`}>
        <div className={styles.v3ComposerField}>
          <div className={styles.v3FieldLabel}>
            <span>02 · Model / recipe</span>
            <em>explicit</em>
          </div>
          <div className={styles.v3ModelCards}>
            {VIDEO_MODELS.map((item) => (
              <button
                aria-pressed={model.id === item.id}
                className={model.id === item.id ? styles.v3ModelSelected : undefined}
                key={item.id}
                onClick={() => chooseModel(item.id)}
                type="button"
              >
                <span className={styles.v3ModelIcon}>
                  <StudioV2Icon name={item.id === 'owned-local' ? 'scissors' : 'agent'} size={18} />
                </span>
                <span>
                  <strong>{item.label}</strong>
                  <small>{item.provider}</small>
                </span>
                <em>{item.id === 'owned-local' ? '৳0 edit' : 'Paid gate'}</em>
              </button>
            ))}
          </div>
          <p className={styles.v3CapabilityNote}>
            <StudioV2Icon name="check" size={13} />
            {model.note}
          </p>
        </div>

        <div className={styles.v3ControlGrid}>
          <div className={styles.v3OptionGroup}>
            <div className={styles.v3FieldLabel}>
              <span>Duration</span>
              <em>model capability</em>
            </div>
            <div className={styles.v3OptionRow}>
              {[4, 5, 6, 7, 8, 15, 16, 24, 30, 60].map((item) => {
                const direct = model.durations.includes(item)
                const chain = model.id === 'veo-preview' && (item === 16 || item === 24)
                return (
                  <button
                    aria-pressed={duration === item}
                    className={duration === item ? styles.v3SegmentActive : undefined}
                    disabled={!direct && !chain}
                    key={item}
                    onClick={() => setDuration(item)}
                    title={
                      chain
                        ? `${item / 8} verified 8-second clips, then local concat`
                        : direct
                          ? `${item} seconds supported`
                          : `${model.label} does not support ${item} seconds`
                    }
                    type="button"
                  >
                    {item}s
                    {chain && <small>chain</small>}
                  </button>
                )
              })}
            </div>
          </div>
          <div className={styles.v3OptionGroup}>
            <div className={styles.v3FieldLabel}>
              <span>Output count</span>
              <em>1–2 candidates</em>
            </div>
            <div className={styles.v3OptionRow}>
              {[1, 2].map((item) => (
                <button
                  aria-pressed={count === item}
                  className={count === item ? styles.v3SegmentActive : undefined}
                  key={item}
                  onClick={() => setCount(item)}
                  type="button"
                >
                  {item}
                </button>
              ))}
            </div>
          </div>
        </div>

        <div className={styles.v3ControlGrid}>
          <div className={styles.v3OptionGroup}>
            <div className={styles.v3FieldLabel}>
              <span>Aspect</span>
              <em>delivery</em>
            </div>
            <div className={styles.v3OptionRow}>
              {(['9:16', '1:1', '16:9'] as const).map((item) => {
                const supported = model.aspects.includes(item)
                return (
                  <button
                    aria-pressed={aspect === item}
                    className={aspect === item ? styles.v3SegmentActive : undefined}
                    disabled={!supported}
                    key={item}
                    onClick={() => setAspect(item)}
                    title={supported ? `${item} supported` : `${model.label} does not advertise ${item}`}
                    type="button"
                  >
                    {item}
                  </button>
                )
              })}
            </div>
          </div>
          <div className={styles.v3OptionGroup}>
            <div className={styles.v3FieldLabel}>
              <span>Resolution</span>
              <em>delivered truth</em>
            </div>
            <div className={styles.v3OptionRow}>
              {(['720p', '1080p', '4K'] as const).map((item) => {
                const supported =
                  item !== '4K' &&
                  model.resolutions.includes(item) &&
                  model.aspects.includes(aspect)
                return (
                  <button
                    aria-pressed={resolution === item}
                    className={resolution === item ? styles.v3SegmentActive : undefined}
                    disabled={!supported}
                    key={item}
                    onClick={() => setResolution(item)}
                    title={
                      supported
                        ? `${item} is declared by this capability`
                        : item === '4K'
                          ? 'Native 4K is not in the integrated capability manifest.'
                          : `${item} is not truthful for this model/source path.`
                    }
                    type="button"
                  >
                    {item}
                    {!supported && <small>Unavailable</small>}
                  </button>
                )
              })}
            </div>
          </div>
        </div>

        {model.id !== 'owned-local' && (
          <>
            <ReferencePicker
              assets={imageSources}
              label="Start frame"
              onClear={() => setStartFrameId('')}
              onSelect={setStartFrameId}
              requirement="required"
              selectedId={startFrameId}
            />
            <ReferencePicker
              assets={imageSources.filter((asset) => asset.id !== startFrameId)}
              label="End frame"
              onClear={() => setEndFrameId('')}
              onSelect={setEndFrameId}
              requirement="optional"
              selectedId={endFrameId}
            />
            <ReferencePicker
              assets={imageSources.filter(
                (asset) => asset.id !== startFrameId && asset.id !== endFrameId,
              )}
              label="Image reference"
              onClear={() => setImageReferenceId('')}
              onSelect={setImageReferenceId}
              requirement="optional"
              selectedId={imageReferenceId}
            />
          </>
        )}

        <div className={styles.v3ControlGrid}>
          <div className={styles.v3OptionGroup}>
            <div className={styles.v3FieldLabel}>
              <span>Audio</span>
              <em>{model.supportsAudio ? 'supported' : 'unavailable'}</em>
            </div>
            <div className={styles.v3OptionRow}>
              <button
                aria-pressed={audioMode === 'generate'}
                className={audioMode === 'generate' ? styles.v3SegmentActive : undefined}
                disabled={!model.supportsAudio}
                onClick={() => setAudioMode('generate')}
                type="button"
              >
                {model.id === 'owned-local' ? 'Keep source' : 'Generate audio'}
              </button>
              <button
                aria-pressed={audioMode === 'mute'}
                className={audioMode === 'mute' ? styles.v3SegmentActive : undefined}
                onClick={() => setAudioMode('mute')}
                type="button"
              >
                Mute
              </button>
            </div>
          </div>
          <div className={styles.v3AvatarVideoContext}>
            <span>IDENTITY CONTEXT</span>
            <strong>
              {AVATARS.find((avatar) => avatar.id === selectedAvatarId)?.name ?? 'No avatar'}
            </strong>
            <small>Optional guidance · never replaces selected source silently</small>
          </div>
        </div>
        </div>
      </details>

      <div className={styles.v3ComposerReadiness}>
        <div>
          <span className={valid && sourceId && prompt.trim() ? styles.v3ReadinessReady : styles.v3ReadinessBlocked}>
            <StudioV2Icon
              name={valid && sourceId && prompt.trim() ? 'check' : 'lock'}
              size={15}
            />
          </span>
          <span>
            <strong>
              {valid && sourceId && prompt.trim()
                ? 'Capability configuration is internally consistent'
                : 'Source or capability combination needs attention'}
            </strong>
            <small>
              {selectedSource?.title ?? 'No source'} · {duration}s · {aspect} · {resolution}
            </small>
          </span>
        </div>
        <div>
          <span>ESTIMATE</span>
          <strong>{estimatedBdt === 0 ? '৳0 local edit' : `৳${estimatedBdt.toFixed(2)}`}</strong>
          <small>{duration === 16 || duration === 24 ? 'Chain cap shown before queue' : 'No spend in demo'}</small>
        </div>
      </div>

      <footer className={styles.v3ComposerFooter}>
        <div>
          <StudioV2Icon name="lock" size={15} />
          <span>
            <strong>{model.id === 'owned-local' ? 'Local edit plan only' : 'Paid provider review required'}</strong>
            <small>{localStatus}</small>
          </span>
        </div>
        <button
          className={styles.secondaryButton}
          onClick={() =>
            setLocalStatus('Capability and cost review captured locally. No request was created.')
          }
          type="button"
        >
          Review capability
        </button>
        <button
          className={styles.primaryButton}
          onClick={() => onNavigate({ id: 'editor', kind: 'video' })}
          type="button"
        >
          Take source to Editor
          <StudioV2Icon name="chevron-right" size={17} />
        </button>
        <button className={styles.v3DisconnectedButton} disabled type="button">
          Generation disconnected
        </button>
      </footer>
    </section>
  )
}

export function CreativeStudioCreateLab({
  kind,
  initialSourceAssetId,
  initialAvatarId,
  onNavigate,
}: CreativeStudioCreateLabProps) {
  const [tab, setTab] = useState<LabTab>('explore')
  const [selectedAvatarId, setSelectedAvatarId] = useState(
    initialAvatarId ?? AVATARS[0].id,
  )
  const [selectedTemplate, setSelectedTemplate] = useState<string>(
    kind === 'image' ? IMAGE_TEMPLATES[0].id : VIDEO_TEMPLATES[0].id,
  )

  const templates = kind === 'image' ? IMAGE_TEMPLATES : VIDEO_TEMPLATES

  return (
    <CreativeStudioWorkspaceShell
      active={kind}
      description={
        kind === 'image'
          ? 'Explore approved products, identities, recipes and gallery sources before configuring an image request.'
          : 'Begin with a gallery source or avatar, then constrain motion by model, duration and truthful delivery capability.'
      }
      eyebrow={kind === 'image' ? 'CREATE / EXPLORE' : 'CREATE / MOTION'}
      icon={kind}
      onNavigate={onNavigate}
      title={kind === 'image' ? 'Image Lab' : 'Video Lab'}
      actions={
        <div className={styles.v3LabTabs} role="tablist" aria-label={`${kind} lab views`}>
          <button
            aria-selected={tab === 'explore'}
            className={tab === 'explore' ? styles.v3LabTabActive : undefined}
            onClick={() => setTab('explore')}
            role="tab"
            type="button"
          >
            <StudioV2Icon name="assets" size={16} />
            Explore
          </button>
          <button
            aria-selected={tab === 'history'}
            className={tab === 'history' ? styles.v3LabTabActive : undefined}
            onClick={() => setTab('history')}
            role="tab"
            type="button"
          >
            <StudioV2Icon name="history" size={16} />
            History
          </button>
        </div>
      }
    >
      <AvatarRail
        onNavigate={onNavigate}
        onSelect={(avatar) => setSelectedAvatarId(avatar.id)}
        selectedId={selectedAvatarId}
      />

      {tab === 'history' ? (
        <HistoryLedger kind={kind} />
      ) : (
        <div
          className={`${styles.v3LabLayout} ${styles.v4LabWithFloatingComposer}`}
        >
          <section aria-labelledby="lab-template-title" className={styles.v3ExploreBoard}>
            <header className={styles.v3ExploreHeader}>
              <div>
                <span className={styles.eyebrow}>
                  {kind === 'image' ? 'APPROVED STARTING SYSTEMS' : 'SOURCE + TEMPLATE GALLERY'}
                </span>
                <h2 id="lab-template-title">
                  {kind === 'image' ? 'Recipes with production context' : 'Motion patterns around your assets'}
                </h2>
                <p>
                  Selecting a template configures the local composer; it does not queue work.
                </p>
              </div>
              <label className={styles.v3ExploreSearch}>
                <StudioV2Icon name="search" size={16} />
                <span className={styles.srOnly}>Search templates</span>
                <input placeholder="Search templates and assets" />
              </label>
            </header>

            <div className={styles.v3TemplateGrid}>
              {templates.map((template) => (
                <button
                  aria-pressed={selectedTemplate === template.id}
                  className={`${styles.v3TemplateCard} ${
                    selectedTemplate === template.id ? styles.v3TemplateSelected : ''
                  }`}
                  key={template.id}
                  onClick={() => setSelectedTemplate(template.id)}
                  type="button"
                >
                  <span
                    className={`${styles.v3TemplateArtwork} ${styles[`v3Tone_${template.tone}`]}`}
                  >
                    <span>ALMA</span>
                    <i />
                    <b />
                    {kind === 'video' && (
                      <em>
                        <StudioV2Icon name="play" size={15} />
                      </em>
                    )}
                  </span>
                  <span>
                    <small>{'recipe' in template ? 'RECIPE' : template.source}</small>
                    <strong>{template.title}</strong>
                    <em>{template.meta}</em>
                    <span>{'recipe' in template ? template.recipe : 'Brand-safe template'}</span>
                  </span>
                  <StudioV2Icon name="check" size={15} />
                </button>
              ))}
            </div>

            <div className={styles.v3ExploreGallery}>
              <header>
                <div>
                  <h3>{kind === 'image' ? 'Recent approved imagery' : 'Eligible gallery sources'}</h3>
                  <p>Provider, status and delivered resolution remain visible.</p>
                </div>
                <button
                  className={styles.textButton}
                  onClick={() =>
                    onNavigate({ id: 'gallery', initialType: kind === 'image' ? 'image' : 'all' })
                  }
                  type="button"
                >
                  Open Gallery
                  <StudioV2Icon name="chevron-right" size={15} />
                </button>
              </header>
              <div>
                {GALLERY_ASSETS.filter((asset) =>
                  kind === 'image'
                    ? asset.type === 'image'
                    : asset.type === 'image' || asset.type === 'video',
                )
                  .slice(0, 6)
                  .map((asset) => (
                    <button
                      key={asset.id}
                      onClick={() =>
                        onNavigate(
                          kind === 'image'
                            ? { id: 'image-lab', sourceAssetId: asset.id }
                            : { id: 'video-lab', sourceAssetId: asset.id },
                        )
                      }
                      type="button"
                    >
                      <AssetArtwork asset={asset} />
                      <span>
                        <strong>{asset.title}</strong>
                        <small>{asset.provider} · {asset.resolution}</small>
                      </span>
                    </button>
                  ))}
              </div>
            </div>
          </section>

          {kind === 'image' ? (
            <ImageComposer
              initialTemplateId={selectedTemplate}
              initialSourceAssetId={initialSourceAssetId}
              key={selectedTemplate}
              onNavigate={onNavigate}
              onSelectAvatar={setSelectedAvatarId}
              selectedAvatarId={selectedAvatarId}
            />
          ) : (
            <VideoComposer
              initialTemplateId={selectedTemplate}
              initialSourceAssetId={initialSourceAssetId}
              key={selectedTemplate}
              onNavigate={onNavigate}
              selectedAvatarId={selectedAvatarId}
            />
          )}
        </div>
      )}
    </CreativeStudioWorkspaceShell>
  )
}
