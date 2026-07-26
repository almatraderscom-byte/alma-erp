'use client'

import { useMemo } from 'react'
import { CreativeProjectEditor } from '@/agent/components/creative-studio/editor'
import { loadCreativeStudioV3EditorSnapshotContext } from '@/agent/components/creative-studio-v3/editor-context'
import {
  createFoundationCompositionCommandPort,
  type EditorActor,
  type EditorCompositionScope,
} from '@/lib/creative-studio/editor-agent'
import type { StudioAccessRole } from '@/lib/creative-studio/studio-access'
import styles from '@/agent/components/creative-studio-v3/creative-studio-v3.module.css'

export function StudioV3EditorJourney({
  accessRole,
  accountLabel,
  actorUserId,
  brandName,
  foundationWritesEnabled,
  onExit,
  scope,
}: {
  accessRole: StudioAccessRole
  accountLabel: string
  actorUserId: string
  brandName: string
  foundationWritesEnabled: boolean
  onExit: () => void
  scope: EditorCompositionScope
}) {
  const actor = useMemo<EditorActor>(() => ({
    userId: actorUserId,
    name: accountLabel,
    role: accessRole,
  }), [accessRole, accountLabel, actorUserId])

  // One command port owns the mounted composition's validated session state.
  // It is replaced only when the exact server-derived scope changes.
  const commandPort = useMemo(
    () => createFoundationCompositionCommandPort({
      loadSnapshotContext: (view) => {
        if (
          view.id !== scope.compositionId
          || view.brandProfileId !== scope.brandProfileId
          || view.projectId !== scope.projectId
        ) {
          throw new Error('Foundation composition response crossed the mounted Studio scope.')
        }
        return loadCreativeStudioV3EditorSnapshotContext(view, {
          brandName,
          brandProfileId: scope.brandProfileId,
          projectId: scope.projectId,
        })
      },
    }),
    [
      brandName,
      scope.brandProfileId,
      scope.compositionId,
      scope.projectId,
    ],
  )

  const readOnly = accessRole === 'reviewer' || !foundationWritesEnabled
  const readOnlyReason = accessRole === 'reviewer'
    ? 'Reviewer preview: composition changes are disabled.'
    : !foundationWritesEnabled
      ? 'Foundation writes are off: this composition is preview-only.'
      : undefined

  return (
    <div className={styles.editorHost}>
      <CreativeProjectEditor
        actor={actor}
        commandPort={commandPort}
        embedded
        generationProvider={null}
        onExit={onExit}
        readOnly={readOnly}
        readOnlyReason={readOnlyReason}
        scope={scope}
        voice={null}
      />
    </div>
  )
}
