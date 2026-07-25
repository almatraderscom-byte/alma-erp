'use client'

import { useState } from 'react'
import { CreativeStudioCapabilityDesk } from './CreativeStudioCapabilityDesk'
import { CreativeStudioCreateLab } from './CreativeStudioCreateLab'
import { CreativeStudioEditor } from './CreativeStudioEditor'
import { CreativeStudioFinishing } from './CreativeStudioFinishing'
import { CreativeStudioGallery } from './CreativeStudioGallery'
import { CreativeStudioHome } from './CreativeStudioHome'
import type { StudioV3View } from './studio-v3-navigation'

export function CreativeStudioEnterpriseDemo() {
  const [view, setView] = useState<StudioV3View>({ id: 'home' })

  if (view.id === 'editor') {
    return (
      <CreativeStudioEditor
        entryKind={view.kind}
        entryProject={view.project}
        initiallyOpenAgent={view.openAgent}
        onHome={() => setView({ id: 'home' })}
      />
    )
  }

  if (view.id === 'image-lab' || view.id === 'video-lab') {
    return (
      <CreativeStudioCreateLab
        initialAvatarId={view.avatarId}
        initialSourceAssetId={view.sourceAssetId}
        key={view.id}
        kind={view.id === 'image-lab' ? 'image' : 'video'}
        onNavigate={setView}
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
      onNavigate={setView}
    />
  )
}
