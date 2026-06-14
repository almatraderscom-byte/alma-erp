import { type NextRequest } from 'next/server'
import { getToken } from 'next-auth/jwt'
import { requireAgentEnabled } from '@/agent/lib/guards'
import { isSystemOwner } from '@/lib/roles'
import { ensurePersonalProject } from '@/lib/personal-space'
import { PERSONAL_PROJECT_NAME, PERSONAL_PROJECT_TAG } from '@/agent/lib/personal-prompt'

export const runtime = 'nodejs'

export async function GET(req: NextRequest) {
  const disabled = requireAgentEnabled()
  if (disabled) return disabled

  const token = await getToken({ req, secret: process.env.NEXTAUTH_SECRET })
  if (!token?.sub) return Response.json({ error: 'unauthorized' }, { status: 401 })
  if (!isSystemOwner(token)) return Response.json({ error: 'forbidden' }, { status: 403 })

  const projectId = await ensurePersonalProject()
  return Response.json({
    projectId,
    name: PERSONAL_PROJECT_NAME,
    tag: PERSONAL_PROJECT_TAG,
  })
}
