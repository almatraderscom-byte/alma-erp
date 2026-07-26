'use client'

import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { toast, Toaster } from 'react-hot-toast'
import type { StudioProjectSummary } from '@/lib/creative-studio/project-contract'
import {
  creativeStudioV3CompositionClient,
  creativeStudioV3CompositionErrorMessage,
  resolveStudioProjectComposition,
} from '@/agent/components/creative-studio-v3/composition-client'
import { StudioV3CapabilityDesk } from '@/agent/components/creative-studio-v3/StudioV3CapabilityDesk'
import { StudioV3EditorJourney } from '@/agent/components/creative-studio-v3/StudioV3EditorJourney'
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
import { setActiveStudioContentContext } from '@/agent/components/creative-studio/studio-api'

const ACTIVE_BRAND_KEY = 'alma-creative-studio-v3-brand'

export function CreativeStudioV3({
  initialContext,
}: {
  initialContext: CreativeStudioV3InitialContext
}) {
  const pathname = usePathname()
  const router = useRouter()
  const searchParams = useSearchParams()
  const [view, setView] = useState<CreativeStudioV3View>({ id: 'home' })
  const [brands, setBrands] = useState<Awaited<ReturnType<typeof creativeStudioV3ProductionPort.listBrands>>>([])
  const [activeBrandId, setActiveBrandId] = useState<string | null>(initialContext.brandId)
  const [activeProjectId, setActiveProjectId] = useState<string | null>(initialContext.projectId)
  const [launchingProjectId, setLaunchingProjectId] = useState<string | null>(null)

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
  const availableProjects = useMemo(
    () => initialContext.accessibleProjects.filter((project) =>
      project.brandProfileId === activeBrandId && !project.readonly),
    [activeBrandId, initialContext.accessibleProjects],
  )
  const activeProject = useMemo(
    () => availableProjects.find((project) => project.id === activeProjectId)
      ?? availableProjects[0]
      ?? null,
    [activeProjectId, availableProjects],
  )

  useEffect(() => {
    setActiveProjectId((current) =>
      availableProjects.some((project) => project.id === current)
        ? current
        : availableProjects[0]?.id ?? null)
  }, [availableProjects])

  useEffect(() => {
    if (view.id !== 'gallery' || !view.reviewTarget) return
    const targetProject = availableProjects.find((project) =>
      project.id === view.reviewTarget?.projectId
      && project.brandProfileId === view.reviewTarget?.brandProfileId)
    if (targetProject) setActiveProjectId(targetProject.id)
  }, [availableProjects, view])

  useEffect(() => {
    if (!activeProject || !activeProject.brandProfileId) {
      setActiveStudioContentContext(null)
      return
    }
    setActiveStudioContentContext({
      brandProfileId: activeProject.brandProfileId,
      projectId: activeProject.id,
      productId: activeProject.product?.code ?? null,
      recipeId: activeProject.currentRecipeId,
      folder: activeProject.defaultFolder,
    })
    return () => setActiveStudioContentContext(null)
  }, [activeProject])

  const changeBrand = useCallback((brandId: string) => {
    const brand = brands.find((item) => item.brandProfileId === brandId)
    if (!brand) return
    setActiveBrandId(brandId)
    const firstProject = initialContext.accessibleProjects.find((project) =>
      project.brandProfileId === brandId && !project.readonly)
    setActiveProjectId(firstProject?.id ?? null)
    setView({ id: 'home' })
    window.localStorage.setItem(ACTIVE_BRAND_KEY, brandId)
    window.dispatchEvent(new CustomEvent('alma-studio-brand-context', { detail: brand }))
    const query = new URLSearchParams(searchParams.toString())
    query.set('brand', brandId)
    query.delete('project')
    router.replace(`${pathname}?${query.toString()}`, { scroll: false })
  }, [brands, initialContext.accessibleProjects, pathname, router, searchParams])

  const changeProject = useCallback((projectId: string) => {
    const project = availableProjects.find((item) => item.id === projectId)
    if (!project) return
    setActiveProjectId(project.id)
    const query = new URLSearchParams(searchParams.toString())
    query.set('brand', project.brandProfileId!)
    query.set('project', project.id)
    router.replace(`${pathname}?${query.toString()}`, { scroll: false })
  }, [availableProjects, pathname, router, searchParams])

  const openComposition = useCallback(async (
    requestedProject: StudioProjectSummary,
    returnTo: 'home' | 'projects',
  ) => {
    if (!activeBrand || !initialContext.foundation.readEnabled) {
      toast.error(
        'The Foundation read rollout is off. No composition request was sent.',
      )
      return
    }
    const project = initialContext.accessibleProjects.find((candidate) =>
      candidate.id === requestedProject.id
      && candidate.brandProfileId === activeBrand.brandProfileId)
    if (!project || project.readonly || !project.brandProfileId) {
      toast.error(
        'That project is not in the current server-derived accessible scope.',
      )
      return
    }
    setLaunchingProjectId(project.id)
    try {
      const resolved = await resolveStudioProjectComposition({
        actorUserId: initialContext.actorUserId,
        allowCreate:
          initialContext.foundation.writesEnabled
          && activeBrand.role !== 'reviewer',
        brandProfileId: activeBrand.brandProfileId,
        client: creativeStudioV3CompositionClient,
        projectId: project.id,
        projectName: project.name,
      })
      setView({
        id: 'editor',
        accessRole: resolved.composition.accessRole,
        brandProfileId: resolved.composition.brandProfileId,
        brandName: activeBrand.name,
        compositionId: resolved.composition.id,
        projectId: resolved.composition.projectId,
        returnTo,
      })
      toast.success(
        resolved.source === 'created'
          ? `Created ${resolved.composition.title} v${resolved.composition.currentVersion}.`
          : `Opened ${resolved.composition.title} v${resolved.composition.currentVersion}.`,
      )
    } catch (error) {
      toast.error(creativeStudioV3CompositionErrorMessage(error), {
        duration: 6000,
      })
    } finally {
      setLaunchingProjectId(null)
    }
  }, [
    activeBrand,
    initialContext.accessibleProjects,
    initialContext.actorUserId,
    initialContext.foundation.readEnabled,
    initialContext.foundation.writesEnabled,
  ])

  let content
  if (view.id === 'editor') {
    const editorView = view
    content = (
      <StudioV3EditorJourney
        accessRole={editorView.accessRole}
        accountLabel={initialContext.accountLabel}
        actorUserId={initialContext.actorUserId}
        brandName={editorView.brandName}
        foundationWritesEnabled={initialContext.foundation.writesEnabled}
        key={[
          editorView.brandProfileId,
          editorView.projectId,
          editorView.compositionId,
        ].join(':')}
        onExit={() => setView(
          editorView.returnTo === 'home'
            ? { id: 'home' }
            : {
                id: 'desk',
                desk: 'projects',
                projectId: editorView.projectId,
              },
        )}
        scope={{
          brandProfileId: editorView.brandProfileId,
          projectId: editorView.projectId,
          compositionId: editorView.compositionId,
        }}
      />
    )
  } else if (view.id === 'image-lab') {
    content = (
      <StudioV3ImageLab
        key={`image-${activeBrandId ?? 'unscoped'}`}
        activeBrand={activeBrand}
        activeProject={activeProject}
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
        activeProject={activeProject}
        initialAvatarId={view.avatarId}
        initialSourceAssetId={view.sourceAssetId}
        onNavigate={setView}
        port={creativeStudioV3ProductionPort}
      />
    )
  } else if (view.id === 'gallery') {
    content = (
      <StudioV3Gallery
        key={[
          'gallery',
          activeBrandId ?? 'unscoped',
          view.reviewTarget?.projectAssetId ?? 'browse',
          view.reviewTarget?.currentVersionId ?? 'current',
          view.reviewTarget?.expectedSequence ?? 'sequence',
        ].join('-')}
        activeBrand={activeBrand}
        activeProject={activeProject}
        initialType={view.initialType}
        onNavigate={setView}
        port={creativeStudioV3ProductionPort}
        reviewTarget={view.reviewTarget}
      />
    )
  } else if (view.id === 'finishing') {
    content = (
      <StudioV3Finishing
        activeBrand={activeBrand}
        activeProject={activeProject}
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
        accessibleProjects={initialContext.accessibleProjects}
        desk={view.desk}
        key={`${view.desk}-${activeBrandId ?? 'unscoped'}`}
        foundationReadEnabled={initialContext.foundation.readEnabled}
        initialProjectId={view.projectId ?? initialContext.projectId}
        launchingProjectId={launchingProjectId}
        onNavigate={setView}
        onOpenComposition={(project) =>
          openComposition(project, 'projects')}
        port={creativeStudioV3ProductionPort}
      />
    )
  } else {
    content = (
      <StudioV3Home
        activeBrand={activeBrand}
        activeProject={activeProject}
        accessibleProjects={initialContext.accessibleProjects}
        foundationReadEnabled={initialContext.foundation.readEnabled}
        initialProjectId={initialContext.projectId}
        key={`home-${activeBrandId ?? 'unscoped'}`}
        launchingProjectId={launchingProjectId}
        onNavigate={setView}
        onOpenComposition={(project) => openComposition(project, 'home')}
        port={creativeStudioV3ProductionPort}
      />
    )
  }

  return (
    <StudioV3Shell
      activeBrandId={activeBrandId}
      activeProjectId={activeProject?.id ?? null}
      accountLabel={initialContext.accountLabel}
      brands={brands}
      projects={availableProjects}
      currentView={view}
      immersive={view.id === 'editor'}
      onBrandChange={changeBrand}
      onProjectChange={changeProject}
      onNavigate={setView}
      legacyAllowed={initialContext.legacyAllowed}
      studioRole={initialContext.studioRole}
    >
      <Toaster position="top-center" toastOptions={{ duration: 3500 }} />
      {content}
    </StudioV3Shell>
  )
}
