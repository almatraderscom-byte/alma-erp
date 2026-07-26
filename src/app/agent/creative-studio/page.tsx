import { notFound, redirect } from 'next/navigation'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { isAgentEnabled } from '@/agent/config'
import { isSystemOwner } from '@/lib/roles'
import {
  listAccessibleStudioBrands,
  type StudioActor,
} from '@/lib/creative-studio/studio-access'
import { listProjects } from '@/lib/creative-studio/project-service'
import CreativeStudio from '@/agent/components/creative-studio/CreativeStudio'
import { CreativeStudioV3 } from '@/agent/components/creative-studio-v3/CreativeStudioV3'
import { resolveCreativeStudioV3RouteDecision } from '@/agent/components/creative-studio-v3/route-access-policy'

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
  const forceLegacy = first(searchParams?.studio) === 'legacy'

  const accessibleBrands = await listAccessibleStudioBrands(actor)
  const ownerIds = [...new Set(accessibleBrands.map((brand) => brand.ownerId))]
  const accessibleProjects = requestedProjectId
    ? (await Promise.all(ownerIds.map((ownerId) => listProjects(ownerId))))
      .flat()
      .filter((project) =>
        Boolean(project.brandProfileId)
        && accessibleBrands.some((brand) => brand.brandProfileId === project.brandProfileId))
    : []

  const decision = resolveCreativeStudioV3RouteDecision({
    actorIsSystemOwner,
    accessibleBrands,
    accessibleProjects,
    requestedBrandId,
    requestedProjectId,
    forceLegacy,
    environment: {
      CREATIVE_STUDIO_V3_UI_ENABLED: process.env.CREATIVE_STUDIO_V3_UI_ENABLED,
      CREATIVE_STUDIO_V3_OWNER_IDS: process.env.CREATIVE_STUDIO_V3_OWNER_IDS,
      CREATIVE_STUDIO_V3_BRAND_IDS: process.env.CREATIVE_STUDIO_V3_BRAND_IDS,
      CREATIVE_STUDIO_V3_PROJECT_IDS: process.env.CREATIVE_STUDIO_V3_PROJECT_IDS,
    },
  })

  if (decision.kind === 'v3') {
    const roleLabel = `${decision.brand.role.slice(0, 1).toUpperCase()}${decision.brand.role.slice(1)}`
    return (
      <CreativeStudioV3
        initialContext={{
          brandId: decision.brand.brandProfileId,
          projectId: decision.projectId,
          accountLabel: actor.name,
          studioRoleLabel: roleLabel,
          legacyAllowed: actorIsSystemOwner,
        }}
      />
    )
  }

  if (decision.kind === 'legacy' && actorIsSystemOwner) return <CreativeStudio />
  notFound()
}
