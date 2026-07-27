'use client'

import { useMemo, useState } from 'react'
import styles from './CreativeStudioEnterpriseDemo.module.css'
import { StudioV2Icon, type StudioIconName } from './StudioV2Icon'

type CanvasPreset = '9:16' | '1:1' | '4:5' | '16:9'
type CanvasSelection = CanvasPreset | 'custom'
type EmptyEditorPanel = 'media' | 'text' | 'voice' | 'music' | 'agent'
type LocalMediaItem = {
  id: string
  name: string
  kind: 'image' | 'video' | 'audio'
  width?: number
  height?: number
}

type CreativeStudioEmptyProjectEditorProps = {
  projectName: string
  initialCanvasPreset: CanvasPreset
  kind: 'video' | 'longform'
  onHome: () => void
}

const PANEL_TOOLS: ReadonlyArray<{
  id: EmptyEditorPanel
  label: string
  icon: StudioIconName
}> = [
  { id: 'media', label: 'Media', icon: 'assets' },
  { id: 'text', label: 'Text', icon: 'caption' },
  { id: 'voice', label: 'Voice', icon: 'voice' },
  { id: 'music', label: 'Music', icon: 'audio' },
  { id: 'agent', label: 'Agent', icon: 'agent' },
]

const CANVAS_PRESETS: readonly CanvasPreset[] = ['9:16', '1:1', '4:5', '16:9']

const CANVAS_SIZES: Record<CanvasPreset, { width: number; height: number }> = {
  '9:16': { width: 1080, height: 1920 },
  '1:1': { width: 1080, height: 1080 },
  '4:5': { width: 1080, height: 1350 },
  '16:9': { width: 1920, height: 1080 },
}

function readMediaDimensions(file: File): Promise<Pick<LocalMediaItem, 'width' | 'height'>> {
  if (!file.type.startsWith('image/') && !file.type.startsWith('video/')) {
    return Promise.resolve({})
  }

  return new Promise((resolve) => {
    const objectUrl = URL.createObjectURL(file)
    const finish = (width?: number, height?: number) => {
      URL.revokeObjectURL(objectUrl)
      resolve(width && height ? { width, height } : {})
    }

    if (file.type.startsWith('image/')) {
      const image = new window.Image()
      image.onload = () => finish(image.naturalWidth, image.naturalHeight)
      image.onerror = () => finish()
      image.src = objectUrl
      return
    }

    const video = document.createElement('video')
    video.preload = 'metadata'
    video.onloadedmetadata = () => finish(video.videoWidth, video.videoHeight)
    video.onerror = () => finish()
    video.src = objectUrl
  })
}

export function CreativeStudioEmptyProjectEditor({
  projectName,
  initialCanvasPreset,
  kind,
  onHome,
}: CreativeStudioEmptyProjectEditorProps) {
  const [canvasPreset, setCanvasPreset] = useState<CanvasSelection>(initialCanvasPreset)
  const [canvasSize, setCanvasSize] = useState(CANVAS_SIZES[initialCanvasPreset])
  const [customDraft, setCustomDraft] = useState(CANVAS_SIZES[initialCanvasPreset])
  const [isCustomCanvasOpen, setIsCustomCanvasOpen] = useState(false)
  const [activePanel, setActivePanel] = useState<EmptyEditorPanel>('media')
  const [mediaItems, setMediaItems] = useState<LocalMediaItem[]>([])
  const [selectedMediaId, setSelectedMediaId] = useState('')
  const [agentBrief, setAgentBrief] = useState(
    'Build a clean edit plan from the media I add. Do not generate, export or publish.',
  )
  const [notice, setNotice] = useState(
    'Empty project created locally · no provider, upload or publishing request was made',
  )

  const canvasStyle = useMemo(
    () => ({ aspectRatio: `${canvasSize.width} / ${canvasSize.height}` }),
    [canvasSize],
  )
  const canvasResolution = `${canvasSize.width} × ${canvasSize.height}`

  function chooseCanvasPreset(preset: CanvasPreset) {
    const size = CANVAS_SIZES[preset]
    setCanvasPreset(preset)
    setCanvasSize(size)
    setCustomDraft(size)
    setIsCustomCanvasOpen(false)
    setNotice(`${preset} canvas selected inside the project.`)
  }

  function applyCustomCanvas() {
    const width = Math.max(240, Math.min(7680, Math.round(customDraft.width)))
    const height = Math.max(240, Math.min(7680, Math.round(customDraft.height)))
    const size = { width, height }
    setCanvasPreset('custom')
    setCanvasSize(size)
    setCustomDraft(size)
    setIsCustomCanvasOpen(false)
    setNotice(`Custom ${width} × ${height} canvas applied locally.`)
  }

  function applyMediaCanvas(item: LocalMediaItem) {
    if (!item.width || !item.height) return
    const size = { width: item.width, height: item.height }
    setSelectedMediaId(item.id)
    setCanvasPreset('custom')
    setCanvasSize(size)
    setCustomDraft(size)
    setIsCustomCanvasOpen(false)
    setNotice(`${item.name} dimensions are now the current canvas.`)
  }

  async function handleMediaSelection(files: FileList | null) {
    if (!files?.length) return
    const selectedFiles = Array.from(files)
    const selectionBatchId = Date.now()
    const items = await Promise.all(
      selectedFiles.map(async (file, index): Promise<LocalMediaItem> => {
        const dimensions = await readMediaDimensions(file)
        return {
          id: `${selectionBatchId}-${file.lastModified}-${index}`,
          name: file.name,
          kind: file.type.startsWith('image/')
            ? 'image'
            : file.type.startsWith('video/')
              ? 'video'
              : 'audio',
          ...dimensions,
        }
      }),
    )
    setMediaItems((current) => [...current, ...items])
    setSelectedMediaId(items[0]?.id ?? '')
    setNotice(
      `${items.length} local file${items.length > 1 ? 's' : ''} staged. Image/video dimensions are ready for canvas use.`,
    )
  }

  return (
    <section
      aria-label={`Empty ALMA project editor for ${projectName}`}
      className={styles.v4EditorShell}
    >
      <a className={styles.skipLink} href="#empty-editor-canvas">
        Skip to project canvas
      </a>

      <header className={styles.v4EditorTopbar}>
        <div className={styles.v4EditorIdentity}>
          <button aria-label="Return to Creative Studio Home" onClick={onHome} type="button">
            <StudioV2Icon name="arrow-left" size={19} />
          </button>
          <span className={styles.editorAlmaMark}>A</span>
          <div>
            <small>ALMA LIFESTYLE / NEW PROJECT</small>
            <strong>{projectName}</strong>
          </div>
        </div>

        <div className={styles.v4EditorSaveState}>
          <span>
            <StudioV2Icon name="check" size={14} />
            Local draft
          </span>
          <button aria-label="Undo unavailable in an empty project" disabled type="button">
            <StudioV2Icon name="undo" size={17} />
          </button>
          <button aria-label="Redo unavailable in an empty project" disabled type="button">
            <StudioV2Icon name="redo" size={17} />
          </button>
        </div>

        <div className={styles.v4EditorTopActions}>
          <button
            onClick={() => setNotice('Share is disconnected in the owner-approved demo.')}
            type="button"
          >
            <StudioV2Icon name="share" size={16} />
            Share
          </button>
          <button
            className={styles.v4EditorExport}
            onClick={() => setNotice('Export is disconnected. No render job was created.')}
            type="button"
          >
            Export
            <StudioV2Icon name="download" size={16} />
          </button>
        </div>
      </header>

      <div className={styles.v4EditorTrustbar}>
        <span>
          <StudioV2Icon name="lock" size={13} />
          Owner workspace · brand isolated
        </span>
        <span>{kind === 'longform' ? 'Long-form project' : 'Video project'}</span>
        <span>{canvasResolution} · 30 fps</span>
        <strong>PROTOTYPE · ৳0</strong>
      </div>

      <div className={styles.v4EditorBody} data-panel={activePanel}>
        <nav aria-label="Project editing tools" className={styles.v4EditorToolrail}>
          {PANEL_TOOLS.map((tool) => (
            <button
              aria-pressed={activePanel === tool.id}
              className={activePanel === tool.id ? styles.v4EditorToolActive : undefined}
              key={tool.id}
              onClick={() => setActivePanel(tool.id)}
              type="button"
            >
              <StudioV2Icon name={tool.icon} size={18} />
              <span>{tool.label}</span>
            </button>
          ))}
        </nav>

        <aside className={styles.v4EditorMediaPanel}>
          {activePanel === 'media' || activePanel === 'agent' ? (
            <>
              <header>
                <div>
                  <span className={styles.eyebrow}>THIS PROJECT</span>
                  <h2>Media</h2>
                </div>
                <button
                  aria-label="Open project media options"
                  onClick={() => setNotice('Media options are local to this demo.')}
                  type="button"
                >
                  <StudioV2Icon name="more" size={17} />
                </button>
              </header>
              <label className={styles.v4MediaUpload}>
                <input
                  accept="image/*,video/*,audio/*"
                  multiple
                  onChange={(event) => void handleMediaSelection(event.target.files)}
                  type="file"
                />
                <span>
                  <StudioV2Icon name="plus" size={20} />
                </span>
                <strong>Add image, video or audio</strong>
                <small>Browse files · local demo only</small>
              </label>
              {mediaItems.length ? (
                <div className={styles.v4MediaList}>
                  {mediaItems.map((item) => (
                    <article
                      className={selectedMediaId === item.id ? styles.v6MediaItemSelected : undefined}
                      key={item.id}
                    >
                      <button
                        aria-pressed={selectedMediaId === item.id}
                        onClick={() => {
                          setSelectedMediaId(item.id)
                          setNotice(`${item.name} selected. Drag it to Video 1 to begin.`)
                        }}
                        type="button"
                      >
                        <span>
                          <StudioV2Icon
                            name={
                              item.kind === 'image'
                                ? 'image'
                                : item.kind === 'video'
                                  ? 'video'
                                  : 'audio'
                            }
                            size={16}
                          />
                        </span>
                        <span>
                          <strong>{item.name}</strong>
                          <small>
                            {item.width && item.height
                              ? `${item.width} × ${item.height} · local source`
                              : 'Local source · ready to place'}
                          </small>
                        </span>
                      </button>
                      {item.width && item.height ? (
                        <button
                          className={styles.v6UseMediaCanvas}
                          onClick={() => applyMediaCanvas(item)}
                          type="button"
                        >
                          Use as canvas
                        </button>
                      ) : null}
                    </article>
                  ))}
                </div>
              ) : (
                <div className={styles.v4MediaEmpty}>
                  <StudioV2Icon name="folder" size={24} />
                  <strong>No media yet</strong>
                  <small>Your project starts clean—nothing is prefilled.</small>
                </div>
              )}
            </>
          ) : (
            <div className={styles.v4PanelPlaceholder}>
              <span>
                <StudioV2Icon
                  name={PANEL_TOOLS.find((tool) => tool.id === activePanel)?.icon ?? 'layers'}
                  size={23}
                />
              </span>
              <h2>{PANEL_TOOLS.find((tool) => tool.id === activePanel)?.label}</h2>
              <p>Add project media first, then place this layer on the timeline.</p>
              <button onClick={() => setActivePanel('media')} type="button">
                Go to Media
              </button>
            </div>
          )}
        </aside>

        <main className={styles.v4EditorStage} id="empty-editor-canvas">
          <header>
            <div>
              <span>CANVAS</span>
              <strong>{canvasPreset === 'custom' ? 'CUSTOM' : canvasPreset}</strong>
              <small>{canvasResolution}</small>
            </div>
            <div className={styles.v6CanvasToolbar}>
              <div className={styles.v4CanvasPresets} role="group" aria-label="Canvas size presets">
                {CANVAS_PRESETS.map((preset) => (
                  <button
                    aria-pressed={canvasPreset === preset}
                    className={canvasPreset === preset ? styles.v4CanvasPresetActive : undefined}
                    key={preset}
                    onClick={() => chooseCanvasPreset(preset)}
                    type="button"
                  >
                    {preset}
                  </button>
                ))}
                <button
                  aria-expanded={isCustomCanvasOpen}
                  aria-pressed={canvasPreset === 'custom'}
                  className={
                    canvasPreset === 'custom' || isCustomCanvasOpen
                      ? styles.v4CanvasPresetActive
                      : undefined
                  }
                  onClick={() => setIsCustomCanvasOpen((current) => !current)}
                  type="button"
                >
                  Custom
                </button>
              </div>
              {isCustomCanvasOpen ? (
                <div className={styles.v6CustomCanvasFields}>
                  <label>
                    <span>Width</span>
                    <input
                      aria-label="Custom canvas width"
                      max={7680}
                      min={240}
                      onChange={(event) =>
                        setCustomDraft((current) => ({
                          ...current,
                          width: Number(event.target.value),
                        }))
                      }
                      type="number"
                      value={customDraft.width}
                    />
                  </label>
                  <span>×</span>
                  <label>
                    <span>Height</span>
                    <input
                      aria-label="Custom canvas height"
                      max={7680}
                      min={240}
                      onChange={(event) =>
                        setCustomDraft((current) => ({
                          ...current,
                          height: Number(event.target.value),
                        }))
                      }
                      type="number"
                      value={customDraft.height}
                    />
                  </label>
                  <button onClick={applyCustomCanvas} type="button">Apply</button>
                </div>
              ) : null}
            </div>
          </header>

          <div className={styles.v4StageSurface}>
            <div className={styles.v4EmptyCanvas} style={canvasStyle}>
              <span>
                <StudioV2Icon name="plus" size={22} />
              </span>
              <strong>Add your first clip</strong>
              <small>Upload media, then place it on Video 1</small>
              <label>
                <input
                  accept="image/*,video/*"
                  multiple
                  onChange={(event) => void handleMediaSelection(event.target.files)}
                  type="file"
                />
                Choose media
              </label>
            </div>
          </div>

          <footer className={styles.v4Transport}>
            <button aria-label="Previous frame unavailable in an empty project" disabled type="button">
              <StudioV2Icon name="skip-back" size={16} />
            </button>
            <button
              aria-label="Play unavailable in an empty project"
              className={styles.v4PlayButton}
              disabled
              type="button"
            >
              <StudioV2Icon name="play" size={17} />
            </button>
            <button aria-label="Next frame unavailable in an empty project" disabled type="button">
              <StudioV2Icon name="skip-back" size={16} />
            </button>
            <time>00:00.0</time>
            <span>/ 00:00.0</span>
            <em>Fit</em>
            <button
              onClick={() => setNotice('Canvas guides are visible only after media is placed.')}
              type="button"
            >
              <StudioV2Icon name="grid" size={16} />
              Guides
            </button>
          </footer>
        </main>

        <aside
          aria-label={activePanel === 'agent' ? 'Creative Agent' : 'Project properties'}
          className={styles.v4EditorInspector}
        >
          {activePanel === 'agent' ? (
            <div className={styles.v4EditorAgentPanel}>
              <span className={styles.eyebrow}>CREATIVE AGENT</span>
              <h2>Plan this edit with me</h2>
              <p>The Agent may propose timeline changes. Apply remains a separate owner action.</p>
              <textarea
                aria-label="Creative Agent project brief"
                onChange={(event) => setAgentBrief(event.target.value)}
                value={agentBrief}
              />
              <div>
                <span>Plan only</span>
                <span>Current project</span>
                <span>৳0</span>
              </div>
              <button
                disabled={!agentBrief.trim()}
                onClick={() => setNotice('A reviewable fixture plan was drafted. No edit was applied.')}
                type="button"
              >
                Draft plan
                <StudioV2Icon name="chevron-right" size={16} />
              </button>
            </div>
          ) : (
            <>
              <header>
                <span className={styles.eyebrow}>PROJECT</span>
                <h2>Properties</h2>
              </header>
              <dl>
                <div>
                  <dt>Canvas</dt>
                  <dd>{canvasPreset === 'custom' ? 'Custom / media' : canvasPreset}</dd>
                </div>
                <div>
                  <dt>Resolution</dt>
                  <dd>{canvasResolution}</dd>
                </div>
                <div>
                  <dt>Frame rate</dt>
                  <dd>30 fps</dd>
                </div>
                <div>
                  <dt>Duration</dt>
                  <dd>00:00</dd>
                </div>
              </dl>
              <label>
                <span>Background</span>
                <select defaultValue="black">
                  <option value="black">Black</option>
                  <option value="ivory">ALMA ivory</option>
                  <option value="transparent">Transparent</option>
                </select>
              </label>
              <section>
                <StudioV2Icon name="lock" size={15} />
                <span>
                  <strong>Safe empty state</strong>
                  <small>No default clip, provider call or external action.</small>
                </span>
              </section>
            </>
          )}
        </aside>
      </div>

      <section aria-label="Empty project timeline" className={styles.v4Timeline}>
        <header>
          <div>
            <span className={styles.eyebrow}>TIMELINE</span>
            <strong>0 clips · 3 empty tracks</strong>
          </div>
          <button
            onClick={() => setNotice('An empty local track was prepared in the demo.')}
            type="button"
          >
            <StudioV2Icon name="plus" size={15} />
            Add track
          </button>
        </header>
        <div className={styles.v4TimelineRuler}>
          <span />
          <div>
            <time>00:00</time>
            <time>00:10</time>
            <time>00:20</time>
            <time>00:30</time>
            <time>00:40</time>
          </div>
        </div>
        {[
          ['Video 1', 'video'],
          ['Text 1', 'caption'],
          ['Audio 1', 'audio'],
        ].map(([label, icon]) => (
          <div className={styles.v4EmptyTrack} key={label}>
            <span>
              <StudioV2Icon name={icon as StudioIconName} size={14} />
              <strong>{label}</strong>
            </span>
            <div>
              {mediaItems.length && label === 'Video 1' ? (
                <button
                  onClick={() => setNotice('Fixture clip placed locally. Render remains disconnected.')}
                  type="button"
                >
                  <StudioV2Icon name="plus" size={14} />
                  Place selected media
                </button>
              ) : (
                <small>Empty</small>
              )}
            </div>
          </div>
        ))}
      </section>

      <div aria-live="polite" className={styles.v4EditorNotice}>
        <StudioV2Icon name="check" size={14} />
        {notice}
      </div>
    </section>
  )
}
