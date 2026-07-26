'use client'

import { useMemo, useState } from 'react'
import styles from './CreativeStudioEnterpriseDemo.module.css'
import { StudioV2Icon, type StudioIconName } from './StudioV2Icon'

type CanvasPreset = '9:16' | '1:1' | '4:5' | '16:9'
type EmptyEditorPanel = 'media' | 'text' | 'voice' | 'music' | 'agent'

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

function canvasResolution(preset: CanvasPreset): string {
  if (preset === '9:16') return '1080 × 1920'
  if (preset === '1:1') return '1080 × 1080'
  if (preset === '4:5') return '1080 × 1350'
  return '1920 × 1080'
}

export function CreativeStudioEmptyProjectEditor({
  projectName,
  initialCanvasPreset,
  kind,
  onHome,
}: CreativeStudioEmptyProjectEditorProps) {
  const [canvasPreset, setCanvasPreset] = useState(initialCanvasPreset)
  const [activePanel, setActivePanel] = useState<EmptyEditorPanel>('media')
  const [mediaNames, setMediaNames] = useState<string[]>([])
  const [agentBrief, setAgentBrief] = useState(
    'Build a clean edit plan from the media I add. Do not generate, export or publish.',
  )
  const [notice, setNotice] = useState(
    'Empty project created locally · no provider, upload or publishing request was made',
  )

  const canvasStyle = useMemo(
    () => ({ aspectRatio: canvasPreset.replace(':', ' / ') }),
    [canvasPreset],
  )

  function handleMediaSelection(files: FileList | null) {
    if (!files?.length) return
    const names = Array.from(files, (file) => file.name)
    setMediaNames((current) => [...current, ...names])
    setNotice(`${names.length} local file${names.length > 1 ? 's' : ''} staged in this browser demo only.`)
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
        <span>{canvasResolution(canvasPreset)} · 30 fps</span>
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
                  onChange={(event) => handleMediaSelection(event.target.files)}
                  type="file"
                />
                <span>
                  <StudioV2Icon name="plus" size={20} />
                </span>
                <strong>Add image, video or audio</strong>
                <small>Browse files · local demo only</small>
              </label>
              {mediaNames.length ? (
                <div className={styles.v4MediaList}>
                  {mediaNames.map((name, index) => (
                    <button
                      key={`${name}-${index}`}
                      onClick={() => setNotice(`${name} selected. Drag it to Video 1 to begin.`)}
                      type="button"
                    >
                      <span>
                        <StudioV2Icon name="video" size={16} />
                      </span>
                      <span>
                        <strong>{name}</strong>
                        <small>Local source · ready to place</small>
                      </span>
                    </button>
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
              <strong>{canvasPreset}</strong>
              <small>{canvasResolution(canvasPreset)}</small>
            </div>
            <div className={styles.v4CanvasPresets} role="group" aria-label="Canvas size presets">
              {CANVAS_PRESETS.map((preset) => (
                <button
                  aria-pressed={canvasPreset === preset}
                  className={canvasPreset === preset ? styles.v4CanvasPresetActive : undefined}
                  key={preset}
                  onClick={() => setCanvasPreset(preset)}
                  type="button"
                >
                  {preset}
                </button>
              ))}
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
                  onChange={(event) => handleMediaSelection(event.target.files)}
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
                  <dd>{canvasPreset}</dd>
                </div>
                <div>
                  <dt>Resolution</dt>
                  <dd>{canvasResolution(canvasPreset)}</dd>
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
              {mediaNames.length && label === 'Video 1' ? (
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
