import { notFound, redirect } from 'next/navigation'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { isAgentEnabled } from '@/agent/config'
import { canManageCatalogImages, isSystemOwner } from '@/lib/roles'
import CatalogImagesScreen from '@/agent/components/catalog/CatalogImagesScreen'

export const metadata = { title: 'ALMA Agent — Product Images' }

/**
 * Product-image screen: every catalog product as a card (family-matching sets
 * collapsed into one), image-count badges, and per-card upload/delete. Shared
 * with Admins so they can upload photos too — SUPER_ADMIN keeps delete (the
 * screen hides delete for Admins; the API enforces it server-side).
 */
export default async function CatalogImagesPage() {
  if (!isAgentEnabled()) notFound()

  const session = await getServerSession(authOptions)
  if (!session?.user) redirect('/login')
  if (!canManageCatalogImages(session)) notFound()

  return <CatalogImagesScreen canDelete={isSystemOwner(session)} />
}
