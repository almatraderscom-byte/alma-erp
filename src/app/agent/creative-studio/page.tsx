import { notFound, redirect } from 'next/navigation'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { isAgentEnabled } from '@/agent/config'
import { isSystemOwner } from '@/lib/roles'
import {
  listAccessibleStudioBrands,
  type StudioActor,
} from '@/lib/creative-studio/studio-access'
import {
  getCreativeStudioV4PreviewFoundationFlags,
} from '@/lib/creative-studio/composition-feature-flags'
import { listProjects } from '@/lib/creative-studio/project-service'
import { hydrateStudioProjectProducts } from '@/lib/creative-studio/studio-project-product-hydration'
import CreativeStudio from '@/agent/components/creative-studio/CreativeStudio'
import { CreativeStudioV3 } from '@/agent/components/creative-studio-v3/CreativeStudioV3'
import {
  resolveCreativeStudioV3RouteDecision,
  selectCreativeStudioV3InitialProjectId,
} from '@/agent/components/creative-studio-v3/route-access-policy'

export const metadata = {
  title: 'Creative Studio',
  robots: 'noindex',
}

type CreativeStudioSearchParams = {
  studio?: string | string[]
  brand?: string | string[]
  project?: string | string[]
}

function first(value: string | string[] | undefined): string | null {
  const item = Array.isArray(value) ? value[0] : value
  return typeof item === 'string' && item.trim() ? item.trim().slice(0, 160) : null
}

export default async function CreativeStudioPage({
  searchParams,
}: {
  searchParams?: CreativeStudioSearchParams
}) {
  if (!isAgentEnabled()) notFound()

  const session = await getServerSession(authOptions)
  if (!session?.user) redirect('/login')

  const actor: StudioActor = {
    userId: session.user.id,
    name: session.user.name?.trim().slice(0, 120)
      || session.user.email?.trim().slice(0, 120)
      || 'Studio user',
    email: session.user.email?.trim().slice(0, 240) || null,
    erpRole: String(session.user.role),
  }
  const actorIsSystemOwner = isSystemOwner(actor.erpRole)
  const requestedBrandId = first(searchParams?.brand)
  const requestedProjectId = first(searchParams?.project)
  const requestedStudio = first(searchParams?.studio)
  const forceLegacy = requestedStudio === 'legacy'
  const forceOwnerV4Preview =
    requestedStudio === 'v4'
    && process.env.VERCEL_ENV === 'preview'
    && actorIsSystemOwner

  const accessibleBrands = await listAccessibleStudioBrands(actor)
  const ownerIds = [...new Set(accessibleBrands.map((brand) => brand.ownerId))]
  const accessibleBrandIds = new Set(
    accessibleBrands.map((brand) => brand.brandProfileId),
  )
  const accessibleProjects = await hydrateStudioProjectProducts(
    (await Promise.all(ownerIds.map((ownerId) => listProjects(ownerId))))
      .flat()
      .filter((project) =>
        Boolean(project.brandProfileId)
        && accessibleBrandIds.has(project.brandProfileId as string)),
  )

  const decision = resolveCreativeStudioV3RouteDecision({
    actorIsSystemOwner,
    accessibleBrands,
    accessibleProjects,
    requestedBrandId,
    requestedProjectId,
    forceLegacy,
    environment: {
      CREATIVE_STUDIO_V3_UI_ENABLED: forceOwnerV4Preview
        ? '1'
        : process.env.CREATIVE_STUDIO_V3_UI_ENABLED,
      CREATIVE_STUDIO_V3_OWNER_IDS: process.env.CREATIVE_STUDIO_V3_OWNER_IDS,
      CREATIVE_STUDIO_V3_BRAND_IDS: forceOwnerV4Preview
        ? '*'
        : process.env.CREATIVE_STUDIO_V3_BRAND_IDS,
      CREATIVE_STUDIO_V3_PROJECT_IDS: process.env.CREATIVE_STUDIO_V3_PROJECT_IDS,
    },
  })

  if (decision.kind === 'v3') {
    const foundation = getCreativeStudioV4PreviewFoundationFlags({
      actorIsSystemOwner,
      requestedStudio,
    })
    const initialProjectId = selectCreativeStudioV3InitialProjectId({
      accessibleProjects,
      brandProfileId: decision.brand.brandProfileId,
      requestedProjectId: decision.projectId,
    })
    return (
      <CreativeStudioV3
        initialContext={{
          brandId: decision.brand.brandProfileId,
          projectId: initialProjectId,
          actorUserId: actor.userId,
          accountLabel: actor.name,
          studioRole: decision.brand.role,
          accessibleProjects,
          foundation: {
            readEnabled: foundation.readEnabled,
            writesEnabled: foundation.writesEnabled,
          },
          legacyAllowed: actorIsSystemOwner,
        }}
      />
    )
  }

  if (decision.kind === 'legacy' && actorIsSystemOwner) return <CreativeStudio />
  notFound()
}
