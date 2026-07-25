'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { Toaster } from 'react-hot-toast'
import { StudioV3CapabilityDesk } from '@/agent/components/creative-studio-v3/StudioV3CapabilityDesk'
import { StudioV3Finishing } from '@/agent/components/creative-studio-v3/StudioV3Finishing'
import { StudioV3Gallery } from '@/agent/components/creative-studio-v3/StudioV3Gallery'
import { StudioV3Home } from '@/agent/components/creative-studio-v3/StudioV3Home'
import { StudioV3ImageLab } from '@/agent/components/creative-studio-v3/StudioV3ImageLab'
import { StudioV3Shell } from '@/agent/components/creative-studio-v3/StudioV3Shell'
import { StudioV3VideoLab } from '@/agent/components/creative-studio-v3/StudioV3VideoLab'
import { creativeStudioV3ProductionPort } from '@/agent/components/creative-studio-v3/production-adapter'
import type {
  CreativeStudioV3InitialContext,
  CreativeStudioV3View,
} from '@/agent/components/creative-studio-v3/types'
import { selectAccessibleStudioBrand } from '@/agent/components/creative-studio-v3/ui-contract'

const ACTIVE_BRAND_KEY = 'alma-creative-studio-v3-brand'

export function CreativeStudioV3({
  initialContext,
}: {
  initialContext: CreativeStudioV3InitialContext
}) {
  const [view, setView] = useState<CreativeStudioV3View>({ id: 'home' })
  const [brands, setBrands] = useState<Awaited<ReturnType<typeof creativeStudioV3ProductionPort.listBrands>>>([])
  const [activeBrandId, setActiveBrandId] = useState<string | null>(initialContext.brandId)

  useEffect(() => {
    const root = document.documentElement
    root.classList.add('cs-fullscreen')
    return () => root.classList.remove('cs-fullscreen')
  }, [])

  useEffect(() => {
    let live = true
    void creativeStudioV3ProductionPort.listBrands()
      .then((rows) => {
        if (!live) return
        setBrands(rows)
        const stored = window.localStorage.getItem(ACTIVE_BRAND_KEY)
        const selected = selectAccessibleStudioBrand(
          rows,
          initialContext.brandId,
          stored,
        )
        setActiveBrandId(selected?.brandProfileId ?? null)
      })
      .catch(() => {
        if (live) setBrands([])
      })
    return () => { live = false }
  }, [initialContext.brandId])

  const activeBrand = useMemo(
    () => brands.find((brand) => brand.brandProfileId === activeBrandId) ?? null,
    [activeBrandId, brands],
  )

  const changeBrand = useCallback((brandId: string) => {
    const brand = brands.find((item) => item.brandProfileId === brandId)
    if (!brand) return
    setActiveBrandId(brandId)
    window.localStorage.setItem(ACTIVE_BRAND_KEY, brandId)
    window.dispatchEvent(new CustomEvent('alma-studio-brand-context', { detail: brand }))
  }, [brands])

  let content
  if (view.id === 'image-lab') {
    content = (
      <StudioV3ImageLab
        key={`image-${activeBrandId ?? 'unscoped'}`}
        activeBrand={activeBrand}
        initialAvatarId={view.avatarId}
        initialSourceAssetId={view.sourceAssetId}
        onNavigate={setView}
        port={creativeStudioV3ProductionPort}
      />
    )
  } else if (view.id === 'video-lab') {
    content = (
      <StudioV3VideoLab
        key={`video-${activeBrandId ?? 'unscoped'}`}
        activeBrand={activeBrand}
        initialAvatarId={view.avatarId}
        initialSourceAssetId={view.sourceAssetId}
        onNavigate={setView}
        port={creativeStudioV3ProductionPort}
      />
    )
  } else if (view.id === 'gallery') {
    content = (
      <StudioV3Gallery
        key={`gallery-${activeBrandId ?? 'unscoped'}`}
        activeBrand={activeBrand}
        initialType={view.initialType}
        onNavigate={setView}
        port={creativeStudioV3ProductionPort}
      />
    )
  } else if (view.id === 'finishing') {
    content = (
      <StudioV3Finishing
        activeBrand={activeBrand}
        assetId={view.assetId}
        key={`finishing-${activeBrandId ?? 'unscoped'}`}
        onNavigate={setView}
        port={creativeStudioV3ProductionPort}
      />
    )
  } else if (view.id === 'desk') {
    content = (
      <StudioV3CapabilityDesk
        activeBrand={activeBrand}
        desk={view.desk}
        key={`${view.desk}-${activeBrandId ?? 'unscoped'}`}
        initialProjectId={initialContext.projectId}
        onNavigate={setView}
        port={creativeStudioV3ProductionPort}
      />
    )
  } else {
    content = (
      <StudioV3Home
        activeBrand={activeBrand}
        key={`home-${activeBrandId ?? 'unscoped'}`}
        onNavigate={setView}
        port={creativeStudioV3ProductionPort}
      />
    )
  }

  return (
    <StudioV3Shell
      activeBrandId={activeBrandId}
      accountLabel={initialContext.accountLabel}
      brands={brands}
      currentView={view}
      onBrandChange={changeBrand}
      onNavigate={setView}
      legacyAllowed={initialContext.legacyAllowed}
      studioRoleLabel={initialContext.studioRoleLabel}
    >
      <Toaster position="top-center" toastOptions={{ duration: 3500 }} />
      {content}
    </StudioV3Shell>
  )
}
