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

export function CreativeStudioProjectSetup({
  kind,
  onCancel,
  onCreate,
}: CreativeStudioProjectSetupProps) {
  const [projectName, setProjectName] = useState('')
  const editorDefault: CanvasPreset = kind === 'longform' ? '16:9' : '9:16'

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
            <p>Name the project first. Canvas and media setup now happen inside the editor.</p>
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

        <section aria-label="Project creation flow" className={styles.v6ProjectStartFlow}>
          <div>
            <span>01</span>
            <strong>Open project</strong>
            <small>Name and enter a clean workspace.</small>
          </div>
          <div>
            <span>02</span>
            <strong>Set canvas inside</strong>
            <small>Choose a preset, custom size, or media dimensions.</small>
          </div>
          <div>
            <span>03</span>
            <strong>Add media</strong>
            <small>Your files stay local in this owner demo.</small>
          </div>
        </section>

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
            onClick={() => onCreate(projectName.trim(), editorDefault)}
            type="button"
          >
            Open empty project
            <StudioV2Icon name="chevron-right" size={17} />
          </button>
        </footer>
      </section>
    </div>
  )
}
