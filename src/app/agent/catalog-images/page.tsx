import { notFound, redirect } from 'next/navigation'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { isAgentEnabled } from '@/agent/config'
import { isSystemOwner } from '@/lib/roles'
import CatalogImagesScreen from '@/agent/components/catalog/CatalogImagesScreen'

export const metadata = { title: 'ALMA Agent — Product Images' }

/**
 * Owner/CS product-image screen: every catalog product as a card (family-matching
 * sets collapsed into one), image-count badges, and per-card upload + delete so
 * CS and the supervisor can always see/manage the photos for any product.
 */
export default async function CatalogImagesPage() {
  if (!isAgentEnabled()) notFound()

  const session = await getServerSession(authOptions)
  if (!session?.user) redirect('/login')
  if (!isSystemOwner(session)) notFound()

  return <CatalogImagesScreen />
}
