import { type NextRequest } from 'next/server'
import { requireAgentEnabled } from '@/agent/lib/guards'
import { generateSmartTask, getStaffCompletionRate } from '@/agent/lib/intelligence/task-intelligence'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest) {
  const disabled = requireAgentEnabled()
  if (disabled) return disabled

  const token = req.headers.get('authorization')?.replace('Bearer ', '')
  if (token !== process.env.AGENT_INTERNAL_TOKEN) {
    return Response.json({ error: 'unauthorized' }, { status: 401 })
  }

  try {
    const body = await req.json()
    const { staffName, taskType, productName, completionRate } = body

    if (!taskType) {
      return Response.json({ error: 'taskType required' }, { status: 400 })
    }

    let rate = typeof completionRate === 'number' ? completionRate : null

    if (rate === null && body.staffId) {
      rate = await getStaffCompletionRate(body.staffId, taskType)
    }

    const brief = generateSmartTask(
      staffName ?? 'Staff',
      taskType,
      productName ?? null,
      rate ?? 50,
    )

    return Response.json(brief)
  } catch (err: any) {
    return Response.json({ error: err.message ?? 'internal error' }, { status: 500 })
  }
}
