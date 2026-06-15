import { type NextRequest } from 'next/server'
import { requireAgentEnabled } from '@/agent/lib/guards'
import { buildStaffContext, generateContextualGreeting, generateContextualTaskIntro } from '@/agent/lib/intelligence/staff-comms'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest) {
  const disabled = requireAgentEnabled()
  if (disabled) return disabled

  const token = req.headers.get('authorization')?.replace('Bearer ', '')
  if (token !== process.env.AGENT_INTERNAL_TOKEN) {
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
