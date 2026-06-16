import { type NextRequest } from 'next/server'
import { requireAgentEnabled } from '@/agent/lib/guards'
import { buildStaffContext, generateContextualGreeting, generateContextualTaskIntro } from '@/agent/lib/intelligence/staff-comms'
import { extractBearerToken, verifyAgentInternalToken } from '@/lib/agent-internal-auth'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest) {
  const disabled = requireAgentEnabled()
  if (disabled) return disabled

  if (!verifyAgentInternalToken(extractBearerToken(req.headers.get('authorization')))) {
    return Response.json({ error: 'unauthorized' }, { status: 401 })
  }

  const { staffId, staffName, taskCount } = await req.json()
  const ctx = await buildStaffContext(staffId, staffName)

  return Response.json({
    greeting: generateContextualGreeting(ctx),
    taskIntro: taskCount ? generateContextualTaskIntro(ctx, taskCount) : '',
    context: ctx,
  })
}
