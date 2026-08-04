'use client'

import { useMemo, useState, type PointerEvent } from 'react'
import styles from './CreativeStudioEnterpriseDemo.module.css'
import { CreativeStudioWorkspaceShell } from './CreativeStudioWorkspaceShell'
import { StudioV2Icon } from './StudioV2Icon'
import type { StudioV3Navigate } from './studio-v3-navigation'
import {
  FINISH_LAYOUTS,
  FINISH_THEMES,
  GALLERY_ASSETS,
  MASK_REPAIR_PRESETS,
  VIDEO_FINISH_TEMPLATES,
} from './studio-v3-fixtures'

type CreativeStudioFinishingProps = {
  assetId?: string
  onNavigate: StudioV3Navigate
}

type FinishTool = 'brand' | 'repair' | 'timeline' | 'motion'

type MaskMark = {
  id: number
  x: number
  y: number
  size: number
}

const finishTools = [
  {
    id: 'brand',
    label: 'Brand layout',
    detail: 'Logo · code · hook',
    icon: 'palette',
    accepts: 'image',
  },
  {
    id: 'repair',
    label: 'Mask repair',
    detail: 'FLUX Fill presets',
    icon: 'inspector',
    accepts: 'image',
  },
  {
    id: 'timeline',
    label: 'Timeline Lite',
    detail: 'Trim · captions · audio',
    icon: 'scissors',
    accepts: 'video',
  },
  {
    id: 'motion',
    label: 'Motion templates',
    detail: 'Remotion overlays',
    icon: 'template',
    accepts: 'video',
  },
] as const

export function CreativeStudioFinishing({
  assetId,
  onNavigate,
}: CreativeStudioFinishingProps) {
  const finishableAssets = GALLERY_ASSETS.filter(
    (asset) => asset.type === 'image' || asset.type === 'video',
  )
  const initialAsset =
    finishableAssets.find((asset) => asset.id === assetId) ?? finishableAssets[0]
  const [selectedAssetId, setSelectedAssetId] = useState(initialAsset.id)
  const selectedAsset =
    finishableAssets.find((asset) => asset.id === selectedAssetId) ?? finishableAssets[0]
  const [tool, setTool] = useState<FinishTool>(
    selectedAsset.type === 'video' ? 'timeline' : 'brand',
  )
  const [previewState, setPreviewState] = useState(
    'Original source is preserved. No derived asset has been written.',
  )

  const visibleTools = finishTools.filter((item) => item.accepts === selectedAsset.type)

  function chooseAsset(nextId: string) {
    const next = finishableAssets.find((asset) => asset.id === nextId)
    if (!next) return
    setSelectedAssetId(nextId)
    setTool(next.type === 'video' ? 'timeline' : 'brand')
    setPreviewState('Asset changed. All controls are local fixture state.')
  }

  return (
    <CreativeStudioWorkspaceShell
      active="finishing"
      description="Finish a verified asset without overwriting its source: brand layouts, mask repair, Timeline Lite and motion templates."
      eyebrow="POST-PRODUCTION"
      icon="palette"
      onNavigate={onNavigate}
      title="Finishing"
      actions={
        <button
          className={styles.secondaryButton}
          onClick={() => onNavigate({ id: 'gallery' })}
          type="button"
        >
          <StudioV2Icon name="assets" size={16} />
          Choose from Gallery
        </button>
      }
    >
      <div className={styles.v3FinishShell}>
        <aside className={styles.v3FinishSources} aria-label="Finishing source assets">
          <header>
            <span className={styles.eyebrow}>SOURCE VERSION</span>
            <h2>Select a verified asset</h2>
            <p>QC-failed sources remain inspectable but cannot create a finished version.</p>
          </header>
          <div>
            {finishableAssets.slice(0, 9).map((asset) => (
              <button
                aria-pressed={selectedAsset.id === asset.id}
                className={selectedAsset.id === asset.id ? styles.v3FinishSourceSelected : undefined}
                key={asset.id}
                onClick={() => chooseAsset(asset.id)}
                type="button"
              >
                <span
                  className={`${styles.v3FinishThumb} ${styles[`v3Tone_${asset.tone}`]}`}
                >
                  {asset.type === 'video' && <StudioV2Icon name="play" size={13} />}
                </span>
                <span>
                  <strong>{asset.title}</strong>
                  <small>{asset.statusLabel} · {asset.resolution}</small>
                </span>
                {asset.status === 'qc_failed' && <em>Blocked</em>}
              </button>
            ))}
          </div>
          <button
            className={styles.textButton}
            onClick={() => onNavigate({ id: 'gallery' })}
            type="button"
          >
            View complete Gallery
            <StudioV2Icon name="chevron-right" size={15} />
          </button>
        </aside>

        <section aria-labelledby="finishing-preview-title" className={styles.v3FinishStage}>
          <header>
            <div>
              <span className={styles.eyebrow}>NON-DESTRUCTIVE PREVIEW</span>
              <h2 id="finishing-preview-title">{selectedAsset.title}</h2>
              <p>{selectedAsset.source} · {selectedAsset.provider}</p>
            </div>
            <span className={styles.v3OriginalBadge}>
              <StudioV2Icon name="lock" size={13} />
              Original preserved
            </span>
          </header>

          <div
            className={`${styles.v3FinishCanvas} ${styles[`v3Tone_${selectedAsset.tone}`]} ${
              selectedAsset.aspect === '9:16'
                ? styles.v3FinishCanvasPortrait
                : selectedAsset.aspect === '16:9'
                  ? styles.v3FinishCanvasWide
                  : ''
            }`}
          >
            <span className={styles.v3FinishWordmark}>ALMA</span>
            <span className={styles.v3FinishFigure}>
              <i />
              <b />
            </span>
            {tool === 'brand' && (
              <span className={styles.v3FinishCopy}>
                <small>EID 2026 · AL-EID-042</small>
                <strong>Quiet confidence, finished with intention.</strong>
                <em>Limited collection</em>
              </span>
            )}
            {selectedAsset.type === 'video' && (
              <>
                <span className={styles.v3FinishPlay}>
                  <StudioV2Icon name="play" size={19} />
                </span>
                <span className={styles.v3FinishTime}>00:06 / 00:24</span>
              </>
            )}
          </div>

          {selectedAsset.type === 'video' && (
            <div className={styles.v3FinishMiniTimeline}>
              <span>00:00</span>
              <div>
                {Array.from({ length: 9 }).map((_, index) => <i key={index} />)}
                <b style={{ left: '26%' }} />
              </div>
              <span>00:24</span>
            </div>
          )}

          <div className={styles.v3FinishStageStatus} role="status">
            <StudioV2Icon name="check" size={15} />
            <span>{previewState}</span>
          </div>
        </section>

        <aside className={styles.v3FinishWorkbench} aria-label="Finishing controls">
          <div className={styles.v3FinishToolTabs} role="tablist" aria-label="Finishing tools">
            {visibleTools.map((item) => (
              <button
                aria-selected={tool === item.id}
                className={tool === item.id ? styles.v3FinishToolActive : undefined}
                key={item.id}
                onClick={() => setTool(item.id)}
                role="tab"
                type="button"
              >
                <StudioV2Icon name={item.icon} size={16} />
                <span>
                  <strong>{item.label}</strong>
                  <small>{item.detail}</small>
                </span>
              </button>
            ))}
          </div>

          {tool === 'brand' && (
            <BrandFinishingControls
              blocked={selectedAsset.status === 'qc_failed'}
              onPreview={setPreviewState}
            />
          )}
          {tool === 'repair' && <MaskRepairControls onPreview={setPreviewState} />}
          {tool === 'timeline' && <TimelineFinishingControls onPreview={setPreviewState} />}
          {tool === 'motion' && <MotionTemplateControls onPreview={setPreviewState} />}
        </aside>
      </div>
    </CreativeStudioWorkspaceShell>
  )
}

function BrandFinishingControls({
  blocked,
  onPreview,
}: {
  blocked: boolean
  onPreview: (message: string) => void
}) {
  const [layout, setLayout] = useState<(typeof FINISH_LAYOUTS)[number]['id']>(
    FINISH_LAYOUTS[0].id,
  )
  const [theme, setTheme] = useState<(typeof FINISH_THEMES)[number]>('Eid')
  const [fit, setFit] = useState<'cover' | 'contain'>('cover')
  const [variant, setVariant] = useState<'original' | 'branded'>('branded')
  const [footer, setFooter] = useState(true)
  const [headline, setHeadline] = useState('Quiet confidence.')
  const [hook, setHook] = useState('Finished with intention.')
  const [offer, setOffer] = useState('Limited Eid collection')
  const [code, setCode] = useState('AL-EID-042')

  return (
    <div className={styles.v3FinishControls}>
      <header>
        <span className={styles.eyebrow}>IMAGE FINISH PANEL</span>
        <h3>Brand layout</h3>
        <p>Exact production fields create a derived copy; the source stays unchanged.</p>
      </header>

      <div className={styles.v3VariantSwitch} role="group" aria-label="Preview version">
        <button
          aria-pressed={variant === 'original'}
          className={variant === 'original' ? styles.v3SegmentActive : undefined}
          onClick={() => setVariant('original')}
          type="button"
        >
          Original
        </button>
        <button
          aria-pressed={variant === 'branded'}
          className={variant === 'branded' ? styles.v3SegmentActive : undefined}
          onClick={() => setVariant('branded')}
          type="button"
        >
          Branded preview
        </button>
      </div>

      <div className={styles.v3FinishFieldStack}>
        <label>
          <span>Small eyebrow line</span>
          <input defaultValue="EID 2026" />
        </label>
        <label>
          <span>Main headline</span>
          <input onChange={(event) => setHeadline(event.target.value)} value={headline} />
        </label>
        <label>
          <span>Hook</span>
          <input onChange={(event) => setHook(event.target.value)} value={hook} />
        </label>
        <div>
          <label>
            <span>Offer line</span>
            <input onChange={(event) => setOffer(event.target.value)} value={offer} />
          </label>
          <label>
            <span>Product code</span>
            <input onChange={(event) => setCode(event.target.value)} value={code} />
          </label>
        </div>
      </div>

      <fieldset className={styles.v3FinishChoiceList}>
        <legend>Layout</legend>
        {FINISH_LAYOUTS.map((item) => (
          <label
            className={layout === item.id ? styles.v3FinishChoiceSelected : undefined}
            key={item.id}
          >
            <input
              checked={layout === item.id}
              name="finish-layout"
              onChange={() => setLayout(item.id)}
              type="radio"
            />
            <span>
              <strong>{item.label}</strong>
              <small>{item.detail}</small>
            </span>
          </label>
        ))}
      </fieldset>

      <div className={styles.v3FinishOption}>
        <span>Brand theme</span>
        <div>
          {FINISH_THEMES.map((item) => (
            <button
              aria-pressed={theme === item}
              className={theme === item ? styles.v3SegmentActive : undefined}
              key={item}
              onClick={() => setTheme(item)}
              type="button"
            >
              {item}
            </button>
          ))}
        </div>
      </div>

      <div className={styles.v3FinishOption}>
        <span>1080 × 1080 fit</span>
        <div>
          <button
            aria-pressed={fit === 'cover'}
            className={fit === 'cover' ? styles.v3SegmentActive : undefined}
            onClick={() => setFit('cover')}
            type="button"
          >
            Cover crop
          </button>
          <button
            aria-pressed={fit === 'contain'}
            className={fit === 'contain' ? styles.v3SegmentActive : undefined}
            onClick={() => setFit('contain')}
            type="button"
          >
            Contain whole image
          </button>
        </div>
      </div>

      {layout === 'model_overlay' && (
        <label className={styles.v3FinishToggle}>
          <input
            checked={footer}
            onChange={(event) => setFooter(event.target.checked)}
            type="checkbox"
          />
          <span>
            <strong>Model overlay footer</strong>
            <small>Existing production toggle</small>
          </span>
        </label>
      )}

      <div className={styles.v3FinishBoundary}>
        <StudioV2Icon name="lock" size={15} />
        <span>
          <strong>{blocked ? 'QC blocks Finishing' : 'Preview only · output disconnected'}</strong>
          <small>Fixture preview exposes the layout decisions; no image is rendered or stored.</small>
        </span>
      </div>

      <button
        className={styles.primaryButton}
        disabled={blocked || variant === 'original'}
        onClick={() =>
          onPreview(
            `${FINISH_LAYOUTS.find((item) => item.id === layout)?.label} · ${theme} · ${fit} staged locally. No derived asset was created.`,
          )
        }
        type="button"
      >
        Preview finishing configuration
      </button>
      <button className={styles.v3DisconnectedButton} disabled type="button">
        Create branded copy disconnected
      </button>
    </div>
  )
}

function MaskRepairControls({
  onPreview,
}: {
  onPreview: (message: string) => void
}) {
  const [preset, setPreset] = useState<
    (typeof MASK_REPAIR_PRESETS)[number]['id']
  >(MASK_REPAIR_PRESETS[0].id)
  const [brushSize, setBrushSize] = useState(34)
  const [feather, setFeather] = useState(8)
  const [erase, setErase] = useState(false)
  const [inverted, setInverted] = useState(false)
  const [showMask, setShowMask] = useState(true)
  const [detail, setDetail] = useState('')
  const [marks, setMarks] = useState<MaskMark[]>([])
  const selectedPreset =
    MASK_REPAIR_PRESETS.find((item) => item.id === preset) ?? MASK_REPAIR_PRESETS[0]

  function addMaskMark(event: PointerEvent<HTMLButtonElement>) {
    const rect = event.currentTarget.getBoundingClientRect()
    const next = {
      id: Date.now(),
      x: ((event.clientX - rect.left) / rect.width) * 100,
      y: ((event.clientY - rect.top) / rect.height) * 100,
      size: brushSize,
    }
    if (erase) {
      setMarks((current) => current.slice(0, -1))
      return
    }
    setMarks((current) => [...current, next].slice(-20))
  }

  return (
    <div className={styles.v3FinishControls}>
      <header>
        <span className={styles.eyebrow}>MASK EDITOR</span>
        <h3>FLUX Fill repair</h3>
        <p>Paint only the repair area; outside pixels remain part of the source version.</p>
      </header>

      <button
        aria-label="Demo mask canvas. Click to add a local brush mark."
        className={`${styles.v3MaskCanvas} ${inverted ? styles.v3MaskCanvasInverted : ''}`}
        onPointerDown={addMaskMark}
        type="button"
      >
        <span>Click / tap to paint a local demo mask</span>
        {showMask &&
          marks.map((mark) => (
            <i
              key={mark.id}
              style={{
                height: mark.size,
                left: `${mark.x}%`,
                top: `${mark.y}%`,
                width: mark.size,
              }}
            />
          ))}
      </button>

      <div className={styles.v3MaskTools}>
        <button
          aria-pressed={!erase}
          className={!erase ? styles.v3SegmentActive : undefined}
          onClick={() => setErase(false)}
          type="button"
        >
          Brush
        </button>
        <button
          aria-pressed={erase}
          className={erase ? styles.v3SegmentActive : undefined}
          onClick={() => setErase(true)}
          type="button"
        >
          Erase
        </button>
        <button
          disabled={!marks.length}
          onClick={() => setMarks((current) => current.slice(0, -1))}
          type="button"
        >
          <StudioV2Icon name="undo" size={14} />
          Undo
        </button>
        <button disabled={!marks.length} onClick={() => setMarks([])} type="button">
          Clear
        </button>
        <button
          aria-pressed={inverted}
          onClick={() => setInverted((current) => !current)}
          type="button"
        >
          Invert
        </button>
        <button
          aria-pressed={showMask}
          onClick={() => setShowMask((current) => !current)}
          type="button"
        >
          Preview mask
        </button>
      </div>

      <div className={styles.v3MaskSliders}>
        <label>
          <span>Brush size <code>{brushSize}px</code></span>
          <input
            max="72"
            min="8"
            onChange={(event) => setBrushSize(Number(event.target.value))}
            type="range"
            value={brushSize}
          />
        </label>
        <label>
          <span>Feather <code>{feather}px</code></span>
          <input
            max="32"
            min="0"
            onChange={(event) => setFeather(Number(event.target.value))}
            type="range"
            value={feather}
          />
        </label>
      </div>

      <div className={styles.v3RepairPresets}>
        {MASK_REPAIR_PRESETS.map((item) => (
          <button
            aria-pressed={preset === item.id}
            className={preset === item.id ? styles.v3RepairPresetSelected : undefined}
            key={item.id}
            onClick={() => setPreset(item.id)}
            type="button"
          >
            <strong>{item.label}</strong>
            <small>{item.hint}</small>
          </button>
        ))}
      </div>

      <label className={styles.v3PromptField}>
        <span>
          Repair detail
          <em>{preset === 'custom' ? 'required' : 'optional'}</em>
        </span>
        <textarea
          onChange={(event) => setDetail(event.target.value)}
          placeholder={
            preset === 'custom'
              ? 'Describe the exact local change…'
              : 'Add a precise constraint if needed…'
          }
          value={detail}
        />
      </label>

      <div className={styles.v3FinishBoundary}>
        <StudioV2Icon name="wallet" size={15} />
        <span>
          <strong>FLUX Fill · approximately $0.05 / delivered MP</strong>
          <small>Mask upload and paid queue both require separate confirmation.</small>
        </span>
      </div>

      <button
        className={styles.primaryButton}
        disabled={!marks.length || (preset === 'custom' && !detail.trim())}
        onClick={() =>
          onPreview(
            `${selectedPreset.label} mask previewed with ${marks.length} local mark${marks.length === 1 ? '' : 's'} and ${feather}px feather. Nothing uploaded.`,
          )
        }
        type="button"
      >
        Review mask locally
      </button>
      <button className={styles.v3DisconnectedButton} disabled type="button">
        Repair request disconnected
      </button>
    </div>
  )
}

function TimelineFinishingControls({
  onPreview,
}: {
  onPreview: (message: string) => void
}) {
  const [trimStart, setTrimStart] = useState(0)
  const [trimEnd, setTrimEnd] = useState(24)
  const [crop, setCrop] = useState('9:16 · center')
  const [safeZone, setSafeZone] = useState(true)
  const [volume, setVolume] = useState(72)
  const [captions, setCaptions] = useState(true)
  const [cover, setCover] = useState(6)
  const [rerender, setRerender] = useState<string[]>(['captions', 'cover'])

  function toggleRerender(track: string) {
    setRerender((current) =>
      current.includes(track)
        ? current.filter((item) => item !== track)
        : [...current, track],
    )
  }

  return (
    <div className={styles.v3FinishControls}>
      <header>
        <span className={styles.eyebrow}>VIDEO EDIT CONTRACT</span>
        <h3>Timeline Lite + transcript</h3>
        <p>Trim/crop are local; captions, audio and cover are independent partial-render tracks.</p>
      </header>

      <div className={styles.v3TrimTimeline}>
        <span style={{ left: `${(trimStart / 24) * 100}%` }} />
        <span style={{ left: `${(trimEnd / 24) * 100}%` }} />
        {Array.from({ length: 12 }).map((_, index) => <i key={index} />)}
      </div>

      <div className={styles.v3ControlGrid}>
        <label>
          <span>Trim start · {trimStart.toFixed(1)}s</span>
          <input
            max={Math.max(0, trimEnd - 0.5)}
            min="0"
            onChange={(event) => setTrimStart(Number(event.target.value))}
            step=".5"
            type="range"
            value={trimStart}
          />
        </label>
        <label>
          <span>Trim end · {trimEnd.toFixed(1)}s</span>
          <input
            max="24"
            min={Math.min(24, trimStart + 0.5)}
            onChange={(event) => setTrimEnd(Number(event.target.value))}
            step=".5"
            type="range"
            value={trimEnd}
          />
        </label>
      </div>

      <div className={styles.v3ControlGrid}>
        <label>
          <span>Crop / focus</span>
          <select onChange={(event) => setCrop(event.target.value)} value={crop}>
            <option>9:16 · center</option>
            <option>9:16 · face focus</option>
            <option>1:1 · center</option>
            <option>16:9 · product focus</option>
          </select>
        </label>
        <label>
          <span>Original audio volume · {volume}%</span>
          <input
            max="100"
            min="0"
            onChange={(event) => setVolume(Number(event.target.value))}
            type="range"
            value={volume}
          />
        </label>
      </div>

      <div className={styles.v3AutoToggles}>
        <label>
          <input
            checked={safeZone}
            onChange={(event) => setSafeZone(event.target.checked)}
            type="checkbox"
          />
          <span>
            <strong>Safe-zone guides</strong>
            <small>9:16 brand-safe placement</small>
          </span>
        </label>
        <label>
          <input
            checked={captions}
            onChange={(event) => setCaptions(event.target.checked)}
            type="checkbox"
          />
          <span>
            <strong>Bangla captions</strong>
            <small>Timed transcript track</small>
          </span>
        </label>
      </div>

      <label className={styles.v3CaptionLine}>
        <span>Caption cue · 00:01.2–00:03.8</span>
        <textarea defaultValue="ঈদের নতুন গল্প — শান্ত আত্মবিশ্বাসে।" />
      </label>

      <label className={styles.v3CoverPicker}>
        <span>Cover frame · {cover.toFixed(1)}s</span>
        <input
          max="24"
          min="0"
          onChange={(event) => setCover(Number(event.target.value))}
          step=".5"
          type="range"
          value={cover}
        />
      </label>

      <fieldset className={styles.v3RerenderTracks}>
        <legend>Partial rerender tracks</legend>
        {['video', 'captions', 'audio', 'cover'].map((track) => (
          <label key={track}>
            <input
              checked={rerender.includes(track)}
              onChange={() => toggleRerender(track)}
              type="checkbox"
            />
            <span>{track}</span>
          </label>
        ))}
      </fieldset>

      <div className={styles.v3FinishBoundary}>
        <StudioV2Icon name="check" size={15} />
        <span>
          <strong>Source regenerate: never · selected local tracks: ৳0</strong>
          <small>Original/music/voice volumes and transcript timing remain independent.</small>
        </span>
      </div>

      <button
        className={styles.primaryButton}
        disabled={!rerender.length}
        onClick={() =>
          onPreview(
            `Timeline preview ${trimStart.toFixed(1)}–${trimEnd.toFixed(1)}s · ${crop} · ${rerender.join(', ')} only. No render started.`,
          )
        }
        type="button"
      >
        Preview selected tracks · ৳0
      </button>
      <button className={styles.v3DisconnectedButton} disabled type="button">
        Partial render disconnected
      </button>
    </div>
  )
}

function MotionTemplateControls({
  onPreview,
}: {
  onPreview: (message: string) => void
}) {
  const [enabled, setEnabled] = useState<string[]>([
    'Logo watermark',
    'End card · CTA / code / price',
  ])
  const [price, setPrice] = useState('৳2,490')
  const [code, setCode] = useState('AL-EID-042')
  const [name, setName] = useState('Coral Embroidered Panjabi')
  const [cta, setCta] = useState('Order via inbox')
  const [days, setDays] = useState('7')

  const framePlan = useMemo(
    () => [
      enabled.includes('Logo watermark') ? 'Watermark · 00:00–00:24' : null,
      enabled.includes('Price pop') ? 'Price pop · 00:03–00:05' : null,
      enabled.includes('Lower third · code + name') ? 'Lower third · 00:14–00:18' : null,
      enabled.includes('Countdown · days') ? 'Countdown · 00:18–00:21' : null,
      enabled.includes('End card · CTA / code / price') ? 'End card · final 2.5 sec' : null,
    ].filter(Boolean),
    [enabled],
  )

  function toggle(item: string) {
    setEnabled((current) =>
      current.includes(item)
        ? current.filter((value) => value !== item)
        : [...current, item],
    )
  }

  return (
    <div className={styles.v3FinishControls}>
      <header>
        <span className={styles.eyebrow}>REMOTION PLAN</span>
        <h3>Motion templates</h3>
        <p>Exact production overlays become a deterministic, frame-bounded plan.</p>
      </header>

      <div className={styles.v3MotionTemplates}>
        {VIDEO_FINISH_TEMPLATES.map((item) => (
          <label
            className={enabled.includes(item) ? styles.v3MotionTemplateSelected : undefined}
            key={item}
          >
            <input
              checked={enabled.includes(item)}
              onChange={() => toggle(item)}
              type="checkbox"
            />
            <span>{item}</span>
          </label>
        ))}
      </div>

      <div className={styles.v3FinishFieldStack}>
        <div>
          <label>
            <span>Price</span>
            <input onChange={(event) => setPrice(event.target.value)} value={price} />
          </label>
          <label>
            <span>Product code</span>
            <input onChange={(event) => setCode(event.target.value)} value={code} />
          </label>
        </div>
        <label>
          <span>Product name</span>
          <input onChange={(event) => setName(event.target.value)} value={name} />
        </label>
        <div>
          <label>
            <span>End-card CTA</span>
            <input onChange={(event) => setCta(event.target.value)} value={cta} />
          </label>
          <label>
            <span>Countdown days</span>
            <input
              inputMode="numeric"
              onChange={(event) => setDays(event.target.value.replace(/\D/g, ''))}
              value={days}
            />
          </label>
        </div>
      </div>

      <div className={styles.v3FramePlan}>
        <span>FRAME-EXACT PREVIEW</span>
        {framePlan.length ? (
          framePlan.map((item) => (
            <div key={item}>
              <i />
              <strong>{item}</strong>
            </div>
          ))
        ) : (
          <p>No overlay template selected.</p>
        )}
      </div>

      <div className={styles.v3FinishBoundary}>
        <StudioV2Icon name="lock" size={15} />
        <span>
          <strong>Template render disconnected</strong>
          <small>Plan remains inspectable; no Remotion job or finished version exists.</small>
        </span>
      </div>

      <button
        className={styles.primaryButton}
        disabled={!enabled.length}
        onClick={() =>
          onPreview(
            `${enabled.length} motion template${enabled.length === 1 ? '' : 's'} previewed locally for ${code} · ${price}. No render started.`,
          )
        }
        type="button"
      >
        Preview frame plan
      </button>
      <button className={styles.v3DisconnectedButton} disabled type="button">
        Render templates disconnected
      </button>
    </div>
  )
}
