import { type NextRequest } from 'next/server'
import { internalAuthHeaders } from '@/agent/lib/catalog/internal-auth'
import { createOrExtendGroup, getDesignGroup, setMemberRole } from '@/agent/lib/catalog/design-groups'
import type { MemberRole } from '@/agent/lib/catalog/role-guess'

export const runtime = 'nodejs'

export async function GET(req: NextRequest) {
  const denied = internalAuthHeaders(req.headers.get('authorization'))
  if (denied) return denied

  const codeOrGroup = req.nextUrl.searchParams.get('codeOrGroup') ?? ''
  if (!codeOrGroup) return Response.json({ error: 'codeOrGroup required' }, { status: 400 })

  const group = await getDesignGroup({ codeOrGroup })
  if (!group) return Response.json({ error: 'not_found' }, { status: 404 })
  return Response.json(group)
}

export async function POST(req: NextRequest) {
  const denied = internalAuthHeaders(req.headers.get('authorization'))
  if (denied) return denied

  let body: {
    action?: 'create' | 'set_role'
    codes?: string[]
    title?: string
    notes?: string
    groupCode?: string
    productCode?: string
    role?: MemberRole
  }
  try {
    body = await req.json()
  } catch {
    return Response.json({ error: 'invalid_json' }, { status: 400 })
  }

  if (body.action === 'set_role') {
    if (!body.productCode || !body.role) {
      return Response.json({ error: 'productCode and role required' }, { status: 400 })
    }
    const result = await setMemberRole(body.groupCode ?? undefined, body.productCode, body.role)
    if (!result.ok) return Response.json(result, { status: 404 })
    return Response.json(result)
  }

  if (!body.codes?.length) {
    return Response.json({ error: 'codes required' }, { status: 400 })
  }

  const result = await createOrExtendGroup({
    codes: body.codes,
    title: body.title,
    notes: body.notes,
  })
  if (!result.ok) return Response.json(result, { status: 400 })
  return Response.json(result)
}
