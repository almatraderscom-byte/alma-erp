import { redirect } from 'next/navigation'
import { ordersFocusPath } from '@/lib/order-links'

export default async function OrderDetailRoute({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>
  searchParams?: Promise<{ business_id?: string | string[] }>
}) {
  const { id } = await params
  const query = await searchParams
  const businessId = typeof query?.business_id === 'string'
    ? query.business_id
    : 'ALMA_LIFESTYLE'
  redirect(ordersFocusPath(id, businessId))
}
