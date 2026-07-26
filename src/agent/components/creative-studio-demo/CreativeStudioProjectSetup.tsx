'use client'

import { useState } from 'react'
import styles from './CreativeStudioEnterpriseDemo.module.css'
import { StudioV2Icon } from './StudioV2Icon'

type ProjectKind = 'video' | 'longform'
type CanvasPreset = '9:16' | '1:1' | '4:5' | '16:9'

type CreativeStudioProjectSetupProps = {
  kind: ProjectKind
  onCancel: () => void
  onCreate: (projectName: string, canvasPreset: CanvasPreset) => void
}

const CANVAS_PRESETS: ReadonlyArray<{
  id: CanvasPreset
  label: string
  detail: string
}> = [
  { id: '9:16', label: 'Vertical', detail: 'Reels · Stories' },
  { id: '1:1', label: 'Square', detail: 'Social post' },
  { id: '4:5', label: 'Portrait', detail: 'Feed campaign' },
  { id: '16:9', label: 'Landscape', detail: 'Film · YouTube' },
]

export function CreativeStudioProjectSetup({
  kind,
  onCancel,
  onCreate,
}: CreativeStudioProjectSetupProps) {
  const [projectName, setProjectName] = useState(
    kind === 'longform' ? 'Untitled long-form project' : 'Untitled video project',
  )
  const [canvasPreset, setCanvasPreset] = useState<CanvasPreset>(
    kind === 'longform' ? '16:9' : '9:16',
  )

  return (
    <div className={styles.v4ProjectSetupBackdrop}>
      <section
        aria-labelledby="new-project-title"
        aria-modal="true"
        className={styles.v4ProjectSetupDialog}
        role="dialog"
      >
        <header>
          <span className={styles.v4ProjectSetupIcon}>
            <StudioV2Icon name="projects" size={22} />
          </span>
          <div>
            <span className={styles.eyebrow}>NEW PROJECT</span>
            <h1 id="new-project-title">
              {kind === 'longform' ? 'Create a long-form project' : 'Create a video project'}
            </h1>
            <p>Name the project and choose an initial canvas. The editor opens completely empty.</p>
          </div>
          <button aria-label="Close new project setup" onClick={onCancel} type="button">
            <StudioV2Icon name="close" size={18} />
          </button>
        </header>

        <label className={styles.v4ProjectNameField}>
          <span>Project name</span>
          <input
            autoFocus
            onChange={(event) => setProjectName(event.target.value)}
            placeholder="e.g. Eid craftsmanship film"
            value={projectName}
          />
          <small>You can rename it later. Nothing is generated or uploaded at this step.</small>
        </label>

        <fieldset className={styles.v4CanvasPresetField}>
          <legend>Starting canvas</legend>
          <div>
            {CANVAS_PRESETS.map((preset) => (
              <button
                aria-pressed={canvasPreset === preset.id}
                className={canvasPreset === preset.id ? styles.v4CanvasPresetSelected : undefined}
                key={preset.id}
                onClick={() => setCanvasPreset(preset.id)}
                type="button"
              >
                <span data-ratio={preset.id} />
                <strong>{preset.label}</strong>
                <small>{preset.id} · {preset.detail}</small>
              </button>
            ))}
          </div>
        </fieldset>

        <div className={styles.v4ProjectSetupFacts}>
          <span>
            <StudioV2Icon name="check" size={15} />
            Empty media bin
          </span>
          <span>
            <StudioV2Icon name="check" size={15} />
            Empty timeline
          </span>
          <span>
            <StudioV2Icon name="lock" size={15} />
            Prototype · ৳0
          </span>
        </div>

        <footer>
          <button className={styles.secondaryButton} onClick={onCancel} type="button">
            Cancel
          </button>
          <button
            className={styles.primaryButton}
            disabled={!projectName.trim()}
            onClick={() => onCreate(projectName.trim(), canvasPreset)}
            type="button"
          >
            Create empty project
            <StudioV2Icon name="chevron-right" size={17} />
          </button>
        </footer>
      </section>
    </div>
  )
}
