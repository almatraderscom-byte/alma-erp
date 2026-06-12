import { type NextRequest } from 'next/server'
import { internalAuthHeaders } from '@/agent/lib/catalog/internal-auth'
import { generateGroupSuggestions } from '@/agent/lib/catalog/group-suggestions'
import { createOrExtendGroup } from '@/agent/lib/catalog/design-groups'

export const runtime = 'nodejs'

export async function GET(req: NextRequest) {
  const denied = internalAuthHeaders(req.headers.get('authorization'))
  if (denied) return denied

  const limit = Number(req.nextUrl.searchParams.get('limit') ?? 20)
  const suggestions = await generateGroupSuggestions(limit)
  return Response.json({ suggestions })
}

export async function POST(req: NextRequest) {
  const denied = internalAuthHeaders(req.headers.get('authorization'))
  if (denied) return denied

  let body: { suggestionId?: string; codes?: string[]; title?: string; approve?: boolean }
  try {
    body = await req.json()
  } catch {
    return Response.json({ error: 'invalid_json' }, { status: 400 })
  }

  if (!body.approve) {
    return Response.json({ declined: true, suggestionId: body.suggestionId })
  }

  let codes = body.codes ?? []
  let title = body.title
  if (body.suggestionId && codes.length === 0) {
    const suggestions = await generateGroupSuggestions(50)
    const match = suggestions.find((s) => s.id === body.suggestionId)
    if (!match) return Response.json({ error: 'suggestion_not_found' }, { status: 404 })
    codes = match.codes
    title = title ?? match.title
  }
  if (!codes.length) {
    return Response.json({ error: 'codes required' }, { status: 400 })
  }

  const result = await createOrExtendGroup({ codes, title })
  if (!result.ok) return Response.json(result, { status: 400 })
  return Response.json({ approved: true, group: result.group })
}
