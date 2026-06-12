import { type NextRequest } from 'next/server'
import { internalAuthHeaders } from '@/agent/lib/catalog/internal-auth'
import { resolveProductCode } from '@/agent/lib/catalog/inventory-lookup'

export const runtime = 'nodejs'

export async function GET(req: NextRequest) {
  const denied = internalAuthHeaders(req.headers.get('authorization'))
  if (denied) return denied

  const code = req.nextUrl.searchParams.get('code') ?? ''
  const result = await resolveProductCode(code)
  return Response.json(result)
}
