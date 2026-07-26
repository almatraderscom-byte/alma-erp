import { memo } from 'react'
import {
  STUDIO_V3_LIFECYCLE_CAPABILITIES,
  type StudioV3LifecycleRole,
  type StudioV3LifecycleWorkspace,
} from '@/agent/components/creative-studio-v3/lifecycle-client'
import {
  lifecyclePresentation,
  STUDIO_V3_LIFECYCLE_MODE_COPY,
} from '@/agent/components/creative-studio-v3/lifecycle-policy'
import styles from '@/agent/components/creative-studio-v3/creative-studio-v3.module.css'

export const StudioV3LifecycleModeGrid = memo(function StudioV3LifecycleModeGrid({
  role,
  workspace,
}: {
  role: StudioV3LifecycleRole
  workspace: StudioV3LifecycleWorkspace | null
}) {
  return (
    <section aria-label="Lifecycle modes" className={styles.lifecycleModeGrid}>
      {STUDIO_V3_LIFECYCLE_CAPABILITIES.map((capability) => {
        const presentation = lifecyclePresentation({
          capability,
          role,
          workspace,
        })
        return (
          <article data-enabled={presentation.enabled} key={capability}>
            <header>
              <strong>{STUDIO_V3_LIFECYCLE_MODE_COPY[capability].label}</strong>
              <em>{presentation.status}</em>
            </header>
            <p>{STUDIO_V3_LIFECYCLE_MODE_COPY[capability].description}</p>
            <small>
              {!workspace
                ? 'Fallback decision not loaded.'
                : workspace.rollouts[capability].legacyFallbackAvailable
                  ? 'Legacy handoff available; never auto-executed.'
                  : 'No fallback is admitted for this exact scope.'}
            </small>
          </article>
        )
      })}
    </section>
  )
})
