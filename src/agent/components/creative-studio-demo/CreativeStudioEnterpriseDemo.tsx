'use client'

import { useCallback, useEffect, useState } from 'react'
import {
  fetchStudioConfig,
  fetchStudioHealth,
} from '../creative-studio/studio-api'
import { CreativeStudioCapabilityDesk } from './CreativeStudioCapabilityDesk'
import { CreativeStudioCreateLab } from './CreativeStudioCreateLab'
import { CreativeStudioEmptyProjectEditor } from './CreativeStudioEmptyProjectEditor'
import { CreativeStudioEditor } from './CreativeStudioEditor'
import { CreativeStudioFinishing } from './CreativeStudioFinishing'
import { CreativeStudioGallery } from './CreativeStudioGallery'
import { CreativeStudioHome } from './CreativeStudioHome'
import { CreativeStudioProjectSetup } from './CreativeStudioProjectSetup'
import {
  INITIAL_STUDIO_DEMO_API_STATE,
  type StudioDemoApiState,
  type StudioV3View,
} from './studio-v3-navigation'

export function CreativeStudioEnterpriseDemo() {
  const [view, setView] = useState<StudioV3View>({ id: 'home' })
  const [apiState, setApiState] = useState<StudioDemoApiState>(
    INITIAL_STUDIO_DEMO_API_STATE,
  )

  const refreshApiState = useCallback(async () => {
    setApiState((current) => ({
      ...current,
      phase: 'checking',
      error: null,
    }))

    const [configResult, healthResult] = await Promise.allSettled([
      fetchStudioConfig(),
      fetchStudioHealth(),
    ])
    const checkedAt = new Date().toISOString()
    const config =
      configResult.status === 'fulfilled' ? configResult.value : null
    const health =
      healthResult.status === 'fulfilled' ? healthResult.value : null

    setApiState({
      phase: config ? 'connected' : 'degraded',
      config,
      health,
      error: config
        ? health
          ? null
          : 'Provider configuration is live; operational telemetry is temporarily unavailable.'
        : 'The authenticated Creative Studio API could not be reached.',
      lastCheckedAt: checkedAt,
    })
  }, [])

  useEffect(() => {
    void refreshApiState()
  }, [refreshApiState])

  if (view.id === 'editor') {
    if (view.emptyProject) {
      return (
        <CreativeStudioEmptyProjectEditor
          initialCanvasPreset={view.canvasPreset ?? '16:9'}
          kind={view.kind === 'video' ? 'video' : 'longform'}
          onHome={() => setView({ id: 'home' })}
          projectName={view.projectName ?? 'Untitled project'}
        />
      )
    }

    return (
      <CreativeStudioEditor
        entryKind={view.kind}
        entryProject={view.project}
        initiallyOpenAgent={view.openAgent}
        onHome={() => setView({ id: 'home' })}
      />
    )
  }

  if (view.id === 'project-setup') {
    return (
      <>
        <CreativeStudioHome
          apiState={apiState}
          onNavigate={setView}
          onRefreshApi={refreshApiState}
        />
        <CreativeStudioProjectSetup
          kind={view.kind}
          onCancel={() => setView({ id: 'home' })}
          onCreate={(projectName, canvasPreset) =>
            setView({
              id: 'editor',
              kind: view.kind,
              projectName,
              emptyProject: true,
              canvasPreset,
            })
          }
        />
      </>
    )
  }

  if (view.id === 'image-lab' || view.id === 'video-lab') {
    return (
      <CreativeStudioCreateLab
        apiState={apiState}
        initialAvatarId={view.avatarId}
        initialSourceAssetId={view.sourceAssetId}
        key={view.id}
        kind={view.id === 'image-lab' ? 'image' : 'video'}
        onNavigate={setView}
        onRefreshApi={refreshApiState}
      />
    )
  }

  if (view.id === 'gallery') {
    return (
      <CreativeStudioGallery
        initialType={view.initialType}
        onNavigate={setView}
      />
    )
  }

  if (view.id === 'finishing') {
    return (
      <CreativeStudioFinishing
        assetId={view.assetId}
        onNavigate={setView}
      />
    )
  }

  if (view.id === 'desk') {
    return (
      <CreativeStudioCapabilityDesk
        desk={view.desk}
        onNavigate={setView}
      />
    )
  }

  return (
    <CreativeStudioHome
      apiState={apiState}
      onNavigate={setView}
      onRefreshApi={refreshApiState}
    />
  )
}
