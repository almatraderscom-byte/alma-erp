import { type NextRequest } from 'next/server'
import { internalAuthHeaders } from '@/agent/lib/catalog/internal-auth'
import {
  addSizeChartEntry,
  deleteSizeChartEntry,
  listSizeCharts,
} from '@/agent/lib/catalog/size-charts'
import { DEFAULT_CATALOG_BUSINESS } from '@/agent/lib/catalog/inventory-lookup'

export const runtime = 'nodejs'

export async function GET(req: NextRequest) {
  const denied = internalAuthHeaders(req.headers.get('authorization'))
  if (denied) return denied

  const business = req.nextUrl.searchParams.get('business') ?? DEFAULT_CATALOG_BUSINESS
  const category = req.nextUrl.searchParams.get('category') ?? undefined
  const rows = await listSizeCharts(business, category)
  return Response.json({ rows })
}

export async function POST(req: NextRequest) {
  const denied = internalAuthHeaders(req.headers.get('authorization'))
  if (denied) return denied

  let body: {
    action?: 'add' | 'delete'
    category?: string
    ageRange?: string
    sizeLabel?: string
    heightNote?: string
    id?: string
    business?: string
  }
  try {
    body = await req.json()
  } catch {
    return Response.json({ error: 'invalid_json' }, { status: 400 })
  }

  if (body.action === 'delete') {
    if (!body.id) return Response.json({ error: 'id required' }, { status: 400 })
    await deleteSizeChartEntry(body.id)
    return Response.json({ deleted: true })
  }

  if (!body.category || !body.ageRange || !body.sizeLabel) {
    return Response.json({ error: 'category, ageRange, sizeLabel required' }, { status: 400 })
  }

  const result = await addSizeChartEntry({
    business: body.business,
    category: body.category,
    ageRange: body.ageRange,
    sizeLabel: body.sizeLabel,
    heightNote: body.heightNote,
  })
  if (!result.ok) return Response.json(result, { status: 400 })
  return Response.json(result)
}
