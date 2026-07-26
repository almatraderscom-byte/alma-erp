'use client'

/* eslint-disable @next/next/no-img-element */

import { useEffect, useMemo, useState } from 'react'
import type {
  SavedStudioModel,
  StudioBrandProfile,
} from '@/agent/components/creative-studio/studio-api'
import { AudioLabView } from '@/agent/components/creative-studio/AudioLabView'
import { BrandRecipeEditor } from '@/agent/components/creative-studio/BrandRecipeEditor'
import { CampaignPackPanel } from '@/agent/components/creative-studio/CampaignPackPanel'
import { PerformanceView } from '@/agent/components/creative-studio/PerformanceView'
import { ProjectLibraryView } from '@/agent/components/creative-studio/ProjectLibraryView'
import { StudioSettingsView } from '@/agent/components/creative-studio/StudioSettingsView'
import { VoiceLibrary } from '@/agent/components/creative-studio/VoiceLibrary'
import { setActiveStudioContentContext } from '@/agent/components/creative-studio/studio-api'
import type {
  StudioBrandRecipe,
  StudioProjectSummary,
} from '@/lib/creative-studio/project-contract'
import { StudioV3Icon, type StudioV3IconName } from '@/agent/components/creative-studio-v3/StudioV3Icon'
import {
  STUDIO_V3_SCOPE_BOUNDARY,
  type CreativeStudioV3ProductionPort,
} from '@/agent/components/creative-studio-v3/ports'
import type {
  CreativeStudioV3DeskId,
  CreativeStudioV3Navigate,
  CreativeStudioV3ReviewQueueItem,
} from '@/agent/components/creative-studio-v3/types'
import { galleryViewForReviewItem } from '@/agent/components/creative-studio-v3/ui-contract'
import styles from '@/agent/components/creative-studio-v3/creative-studio-v3.module.css'

const deskCopy: Record<CreativeStudioV3DeskId, {
  eyebrow: string
  title: string
  description: string
  icon: StudioV3IconName
}> = {
  projects: {
    eyebrow: 'Content OS',
    title: 'Projects',
    description: 'ERP product, folder, recipe, asset count and immutable lineage remain attached to a business project.',
    icon: 'project',
  },
  systems: {
    eyebrow: 'Reusable systems',
    title: 'Recipes & Models',
    description: 'Authority-locked creative recipes and brand-isolated identities are production context, never generic media.',
    icon: 'systems',
  },
  review: {
    eyebrow: 'Collaboration',
    title: 'Review',
    description: 'Needs-review assets, pinned version boundaries and server-owned role policy stay visible together.',
    icon: 'review',
  },
  operations: {
    eyebrow: 'Trust and lifecycle',
    title: 'Operations',
    description: 'Provider health, kill switches, spend/QC policy, attribution and retention follow server role controls.',
    icon: 'operations',
  },
  voice: {
    eyebrow: 'Saved identity',
    title: 'Voice',
    description: 'Consent, immutable versions, activation, revocation and provider deletion remain owner-only.',
    icon: 'voice',
  },
  audio: {
    eyebrow: 'Audio production',
    title: 'Audio',
    description: 'Music, wish songs, dubbing, clean voice and SFX estimate cost before queue insertion.',
    icon: 'audio',
  },
  campaign: {
    eyebrow: 'Durable workflow',
    title: 'Campaign',
    description: 'Preview manifest, two drafts, authorized selection, stage retry, idempotency and a hard cap.',
    icon: 'campaign',
  },
}

function ProjectRows({
  projects,
  selectedId,
  onSelect,
}: {
  projects: StudioProjectSummary[]
  selectedId: string
  onSelect: (projectId: string) => void
}) {
  return (
    <div className={styles.deskList}>
      {projects.map((project) => (
        <button aria-pressed={selectedId === project.id} key={project.id} onClick={() => onSelect(project.id)} type="button">
          <span className={styles.deskListIcon}><StudioV3Icon name="project" /></span>
          <span>
            <strong>{project.name}</strong>
            <small>{project.product?.code ?? 'No ERP product'} · {project.defaultFolder} · {project.assetCount} assets</small>
          </span>
          <em>{project.readonly ? 'Legacy' : project.currentRecipe?.locked ? 'Locked recipe' : 'Active'}</em>
        </button>
      ))}
    </div>
  )
}

export function StudioV3CapabilityDesk({
  activeBrand,
  accessibleProjects,
  desk,
  foundationReadEnabled,
  initialProjectId,
  launchingProjectId,
  onNavigate,
  onOpenComposition,
  port,
}: {
  activeBrand: StudioBrandProfile | null
  accessibleProjects: StudioProjectSummary[]
  desk: CreativeStudioV3DeskId
  foundationReadEnabled: boolean
  initialProjectId: string | null
  launchingProjectId: string | null
  onNavigate: CreativeStudioV3Navigate
  onOpenComposition: (project: StudioProjectSummary) => Promise<void>
  port: CreativeStudioV3ProductionPort
}) {
  const copy = deskCopy[desk]
  const ownerActionAvailable = activeBrand?.role === 'owner'
  const [projects, setProjects] = useState<StudioProjectSummary[]>([])
  const [recipes, setRecipes] = useState<StudioBrandRecipe[]>([])
  const [models, setModels] = useState<SavedStudioModel[]>([])
  const [reviewItems, setReviewItems] = useState<CreativeStudioV3ReviewQueueItem[]>([])
  const [selectedProjectId, setSelectedProjectId] = useState(initialProjectId ?? '')
  const [libraryProject, setLibraryProject] = useState<StudioProjectSummary | null>(null)
  const [recipeOpen, setRecipeOpen] = useState(false)
  const [loading, setLoading] = useState(true)
  const [issues, setIssues] = useState<string[]>([])

  useEffect(() => {
    if (!['projects', 'systems', 'review', 'campaign'].includes(desk)) {
      setLoading(false)
      return
    }
    if (!activeBrand) {
      setProjects([])
      setRecipes([])
      setModels([])
      setReviewItems([])
      setIssues(['Accessible brand context is unavailable; no project request was sent.'])
      setLoading(false)
      return
    }
    const scopedProjects = accessibleProjects.filter((project) =>
      project.brandProfileId === activeBrand.brandProfileId)
    const scopedProjectId = (
      selectedProjectId
      && scopedProjects.some((item) => item.id === selectedProjectId)
    )
      ? selectedProjectId
      : scopedProjects.find((item) => item.id === initialProjectId)?.id
        ?? scopedProjects[0]?.id
        ?? ''
    let live = true
    setLoading(true)
    void Promise.allSettled([
      port.listProjects(activeBrand.brandProfileId),
      port.listRecipes(activeBrand?.brandProfileId),
      scopedProjectId
        ? port.listModels(activeBrand.brandProfileId, scopedProjectId)
        : Promise.resolve([]),
      scopedProjectId
        ? port.listReviewQueue({
            brandProfileId: activeBrand.brandProfileId,
            projectId: scopedProjectId,
          })
        : Promise.resolve({ items: [], nextCursor: null }),
    ]).then(([projectResult, recipeResult, modelResult, reviewResult]) => {
      if (!live) return
      const nextIssues: string[] = []
      const nextProjects = projectResult.status === 'fulfilled'
        ? projectResult.value
        : scopedProjects
      const nextRecipes = recipeResult.status === 'fulfilled' ? recipeResult.value : []
      const nextModels = modelResult.status === 'fulfilled' ? modelResult.value : []
      const nextReview = reviewResult.status === 'fulfilled'
        ? reviewResult.value.items
        : []
      if (projectResult.status === 'rejected') nextIssues.push(projectResult.reason instanceof Error ? projectResult.reason.message : 'Access-scoped projects unavailable; using the authenticated route snapshot')
      if (recipeResult.status === 'rejected') nextIssues.push(recipeResult.reason instanceof Error ? recipeResult.reason.message : 'Recipes unavailable')
      if (modelResult.status === 'rejected') nextIssues.push(modelResult.reason instanceof Error ? modelResult.reason.message : 'Models unavailable')
      if (reviewResult.status === 'rejected') nextIssues.push(reviewResult.reason instanceof Error ? reviewResult.reason.message : 'Review queue unavailable')
      setProjects(nextProjects)
      setRecipes(nextRecipes)
      setModels(nextModels)
      setReviewItems(nextReview)
      setSelectedProjectId((current) =>
        current && nextProjects.some((item) => item.id === current)
          ? current
          : nextProjects.find((item) => item.id === scopedProjectId)?.id
            ?? nextProjects[0]?.id
            ?? '')
      setIssues(nextIssues)
    }).finally(() => {
      if (live) setLoading(false)
    })
    return () => { live = false }
  }, [accessibleProjects, activeBrand, desk, initialProjectId, port, selectedProjectId])

  const selectedProject = projects.find((project) => project.id === selectedProjectId) ?? null

  useEffect(() => {
    if (!selectedProject) return
    setActiveStudioContentContext({
      brandProfileId: selectedProject.brandProfileId!,
      projectId: selectedProject.id,
      productId: selectedProject.product?.code ?? null,
      recipeId: selectedProject.currentRecipeId,
      folder: selectedProject.defaultFolder,
    })
  }, [selectedProject])

  useEffect(() => () => {
    setActiveStudioContentContext(null)
  }, [])

  const recipesForBrand = useMemo(
    () => recipes.filter((recipe) => !activeBrand || recipe.brandProfileId === activeBrand.brandProfileId),
    [activeBrand, recipes],
  )

  return (
    <div className={styles.page}>
      <header className={styles.workspaceHeader}>
        <div className={styles.workspaceTitle}>
          <span><StudioV3Icon name={copy.icon} /></span>
          <div>
            <span className={styles.eyebrow}>{copy.eyebrow}</span>
            <h1>{copy.title}</h1>
            <p>{copy.description}</p>
          </div>
        </div>
        <span className={styles.serverBadge}><StudioV3Icon name="lock" /> Production APIs</span>
      </header>

      {issues.length > 0 && <div className={styles.inlineWarning}><StudioV3Icon name="warning" /><span>{issues.join(' · ')}</span></div>}
      <p className={styles.scopeNotice}>
        <StudioV3Icon name="lock" />
        This desk remounted for {activeBrand?.name ?? 'the current access context'}.
        {activeBrand?.role === 'owner'
          ? ` Projects come from the authenticated route context; recipes, models and review rows are reloaded for the exact brand/project (${STUDIO_V3_SCOPE_BOUNDARY.models}).`
          : ' Projects are server-derived; recipes, identities and canonical review rows use authenticated brand/project filters. Unscoped legacy data is excluded.'}
      </p>

      {desk === 'projects' && (
        <div className={styles.deskLayout}>
          <section className={styles.deskPrimary}>
            <header className={styles.sectionHeading}>
              <div><span className={styles.eyebrow}>Project registry</span><h2>Business-scoped work</h2></div>
              <span className={styles.sectionMeta}>{projects.length} production project{projects.length === 1 ? '' : 's'}</span>
            </header>
            {loading ? <div className={styles.laneSkeleton} /> : projects.length === 0 ? (
              <p className={styles.emptyState}>
                No access-scoped project was returned for this brand. The owner-only legacy
                project endpoint was not used as a fallback.
              </p>
            ) : (
              <ProjectRows onSelect={setSelectedProjectId} projects={projects} selectedId={selectedProjectId} />
            )}
          </section>
          <aside className={styles.deskDetail}>
            {selectedProject ? (
              <>
                <span className={styles.eyebrow}>Selected project</span>
                <h2>{selectedProject.name}</h2>
                <p>{selectedProject.description ?? 'No project description.'}</p>
                <dl className={styles.detailFacts}>
                  <div><dt>ERP product</dt><dd>{selectedProject.product ? `${selectedProject.product.code} · ${selectedProject.product.name}` : 'Not linked'}</dd></div>
                  <div><dt>Recipe</dt><dd>{selectedProject.currentRecipe ? `${selectedProject.currentRecipe.name} v${selectedProject.currentRecipe.version}` : 'Not selected'}</dd></div>
                  <div><dt>Folder</dt><dd>{selectedProject.defaultFolder}</dd></div>
                  <div><dt>Assets</dt><dd>{selectedProject.assetCount}</dd></div>
                  <div><dt>Write state</dt><dd>{selectedProject.readonly ? 'Legacy read-only' : 'Production project'}</dd></div>
                </dl>
                <div className={styles.detailActions}>
                  <button className={styles.primaryButton} disabled={!ownerActionAvailable} onClick={() => setLibraryProject(selectedProject)} type="button">Open asset library <StudioV3Icon name="arrow" /></button>
                  <button
                    className={styles.secondaryButton}
                    disabled={
                      selectedProject.readonly
                      || !foundationReadEnabled
                      || launchingProjectId !== null
                    }
                    onClick={() => void onOpenComposition(selectedProject)}
                    type="button"
                  >
                    {selectedProject.readonly
                      ? 'Legacy project · Editor unavailable'
                      : !foundationReadEnabled
                        ? 'Composition preview · Foundation off'
                        : launchingProjectId === selectedProject.id
                          ? 'Opening composition…'
                          : 'Open composition'}
                  </button>
                </div>
              </>
            ) : <p className={styles.emptyState}>Select a project to inspect its production context.</p>}
          </aside>
          {libraryProject && <ProjectLibraryView onClose={() => setLibraryProject(null)} project={libraryProject} />}
        </div>
      )}

      {desk === 'systems' && (
        <div className={styles.systemsLayout}>
          <section className={styles.deskPrimary}>
            <header className={styles.sectionHeading}>
              <div><span className={styles.eyebrow}>Authority-locked recipes</span><h2>Creative systems</h2></div>
              <button className={styles.textButton} disabled={!ownerActionAvailable || !selectedProject} onClick={() => setRecipeOpen(true)} type="button">Manage recipe</button>
            </header>
            {recipesForBrand.length === 0 ? <p className={styles.emptyState}>No recipe is available for the active brand.</p> : (
              <div className={styles.systemCards}>
                {recipesForBrand.map((recipe) => (
                  <article key={recipe.id}>
                    <header><span><StudioV3Icon name="systems" /></span><em>{recipe.locked ? 'Locked' : 'Editable'}</em></header>
                    <h3>{recipe.name}</h3>
                    <p>{recipe.captionTone} · {recipe.finishTheme} · {recipe.musicVibe}</p>
                    <dl><div><dt>Version</dt><dd>v{recipe.version}</dd></div><div><dt>QC</dt><dd>{recipe.qcLevel}</dd></div><div><dt>Spend cap</dt><dd>৳{recipe.spendCeilingBdt}</dd></div></dl>
                    <small>{recipe.aspectPack.join(' · ')} · roles {recipe.modelRoles.join(', ')}</small>
                  </article>
                ))}
              </div>
            )}
          </section>
          <section className={styles.deskPrimary}>
            <header className={styles.sectionHeading}>
              <div><span className={styles.eyebrow}>Brand-isolated identity</span><h2>Avatars & saved models</h2></div>
              <button className={styles.textButton} onClick={() => onNavigate({ id: 'gallery', initialType: 'avatar' })} type="button">Avatar Gallery</button>
            </header>
            {models.length === 0 ? <p className={styles.emptyState}>No saved model was returned.</p> : (
              <div className={styles.modelGrid}>
                {models.map((model) => (
                  <article key={model.id}>
                    <span>{model.imageUrl ? <img alt="" src={model.imageUrl} /> : <StudioV3Icon name="voice" />}</span>
                    <div><h3>{model.name}</h3><p>{model.role ?? 'No role'} · {model.avatar?.built ? `${model.avatar.count} identity angles` : 'single reference'}</p></div>
                    <button onClick={() => onNavigate({ id: 'image-lab', avatarId: model.id })} type="button">Use <StudioV3Icon name="arrow" /></button>
                  </article>
                ))}
              </div>
            )}
          </section>
          {ownerActionAvailable && selectedProject && (
            <BrandRecipeEditor
              onClose={() => setRecipeOpen(false)}
              onSelect={async () => { setRecipeOpen(false); setRecipes(await port.listRecipes(activeBrand?.brandProfileId)) }}
              open={recipeOpen}
              project={selectedProject}
            />
          )}
        </div>
      )}

      {desk === 'review' && (
        <div className={styles.deskLayout}>
          <section className={styles.deskPrimary}>
            <header className={styles.sectionHeading}>
              <div><span className={styles.eyebrow}>Server-classified queue</span><h2>Needs review</h2></div>
              <span className={styles.sectionMeta}>{reviewItems.length} canonical asset{reviewItems.length === 1 ? '' : 's'}</span>
            </header>
            {reviewItems.length === 0 ? <p className={styles.emptyState}>No draft, revised, or changes-requested project asset is currently returned.</p> : (
              <div className={styles.reviewQueue}>
                {reviewItems.map((item) => (
                  <article key={item.projectAssetId}>
                    <span>{item.previewUrl ? <img alt="" src={item.previewUrl} /> : <StudioV3Icon name="image" />}</span>
                    <div><h3>{item.title ?? 'Untitled project asset'}</h3><p>{item.state.replace('_', ' ')} · version {item.currentVersionId}</p><small>Sequence {item.expectedSequence} · canonical asset {item.projectAssetId}</small></div>
                    <button
                      onClick={() => onNavigate(galleryViewForReviewItem(item))}
                      type="button"
                    >
                      Inspect
                    </button>
                  </article>
                ))}
              </div>
            )}
          </section>
          <aside className={styles.deskDetail}>
            <span className={styles.eyebrow}>Integration boundary</span>
            <h2>Version-pinned review threads</h2>
            <p>The queue is read from canonical project assets and their current durable versions. It never derives review identity from Gallery jobs.</p>
            <div className={styles.truthBoundary}><StudioV3Icon name="lock" /><div><strong>Lifecycle commands remain disabled</strong><p>Owner/Creator/Reviewer transitions remain server-enforced. This Phase 1–2 remediation wires the access-scoped queue only; corrected Lifecycle command ports are intentionally not merged yet.</p></div></div>
            <button className={styles.secondaryButton} onClick={() => onNavigate({ id: 'desk', desk: 'projects' })} type="button">Open a project asset library</button>
          </aside>
        </div>
      )}

      {desk === 'operations' && (
        <div className={styles.operationsLayout}>
          <section className={styles.operationsIntro}>
            <article><StudioV3Icon name="lock" /><div><strong>Generation policy</strong><p>Engine readiness, kill switches, QC and cost caps are server-owned.</p></div></article>
            <article><StudioV3Icon name="review" /><div><strong>Distribution boundary</strong><p>Dry run, schedule and live publish remain separate commands.</p></div></article>
            <article><StudioV3Icon name="archive" /><div><strong>Retention truth</strong><p>Original deletion requires a verified Drive archive receipt and fetch-back.</p></div></article>
          </section>
          {activeBrand?.role === 'owner' ? (
            <div className={styles.embeddedLegacySurface}><StudioSettingsView /></div>
          ) : (
            <div className={styles.truthBoundary}>
              <StudioV3Icon name="lock" />
              <div>
                <strong>Owner controls are read-only for this brand role</strong>
                <p>{activeBrand?.role ?? 'Unknown'} access cannot change provider, spend, retention or kill-switch settings. The server remains authoritative.</p>
              </div>
            </div>
          )}
          {activeBrand && <div className={styles.embeddedLegacySurface}><PerformanceView brandProfileId={activeBrand.brandProfileId} /></div>}
        </div>
      )}

      {desk === 'voice' && (
        <div className={styles.capabilitySurface}>
          <div className={styles.truthBoundary}><StudioV3Icon name="lock" /><div><strong>Owner-only identity</strong><p>Consent and immutable provider versions are required. Paid clone actions estimate and confirm before queueing.</p></div></div>
          {activeBrand?.role === 'owner' ? (
            <VoiceLibrary />
          ) : (
            <p className={styles.emptyState}>
              The active brand grants {activeBrand?.role ?? 'no'} access. Voice clone, activation,
              revocation and provider deletion stay disabled until the server returns owner access.
            </p>
          )}
        </div>
      )}

      {desk === 'audio' && (
        <div className={styles.capabilitySurface}>
          {ownerActionAvailable ? (
            <AudioLabView />
          ) : (
            <div className={styles.truthBoundary}>
              <StudioV3Icon name="lock" />
              <div><strong>Collaborator audio adapter required</strong><p>The current upload, library and queue routes are owner-only, so this desk does not expose controls that would only fail at the server gate.</p></div>
            </div>
          )}
        </div>
      )}

      {desk === 'campaign' && (
        <div className={styles.campaignLayout}>
          <aside className={styles.campaignProjects}>
            <span className={styles.eyebrow}>Campaign context</span>
            <h2>Choose a project</h2>
            <p>Manifest, costs and lineage are computed from the exact project and locked recipe.</p>
            {projects.length === 0 ? <p className={styles.emptyState}>A production project is required.</p> : <ProjectRows onSelect={setSelectedProjectId} projects={projects} selectedId={selectedProjectId} />}
          </aside>
          <section className={styles.campaignSurface}>
            {selectedProject && ownerActionAvailable ? (
              <>
                <div className={styles.truthBoundary}><StudioV3Icon name="lock" /><div><strong>{selectedProject.name}</strong><p>{selectedProject.currentRecipe ? `${selectedProject.currentRecipe.name} v${selectedProject.currentRecipe.version}` : 'No recipe selected'} · {selectedProject.assetCount} assets</p></div></div>
                <CampaignPackPanel />
              </>
            ) : (
              <p className={styles.emptyState}>
                {ownerActionAvailable
                  ? 'Select a project before requesting a Campaign Pack manifest.'
                  : 'Campaign Pack preview and queue routes remain owner-only for this brand role.'}
              </p>
            )}
          </section>
        </div>
      )}
    </div>
  )
}
