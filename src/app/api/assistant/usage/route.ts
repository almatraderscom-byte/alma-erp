import { type NextRequest } from 'next/server'
import { getToken } from 'next-auth/jwt'
import { requireAgentEnabled } from '@/agent/lib/guards'
import { isSystemOwner } from '@/lib/roles'
import { getUsageIntelligence } from '@/agent/lib/usage-intelligence'
import { isSelectableModelId } from '@/agent/lib/models/registry'
import { captureAgentError } from '@/agent/lib/sentry'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  const disabled = requireAgentEnabled()
  if (disabled) return disabled

  const token = await getToken({ req, secret: process.env.NEXTAUTH_SECRET })
  if (!token?.sub) return Response.json({ error: 'unauthorized' }, { status: 401 })
  if (!isSystemOwner(token)) return Response.json({ error: 'forbidden' }, { status: 403 })

  const conversationId = req.nextUrl.searchParams.get('conversationId')
  const requestedModelId = req.nextUrl.searchParams.get('modelId')
  if (requestedModelId && !isSelectableModelId(requestedModelId)) {
    return Response.json({ error: 'unknown_model' }, { status: 400 })
  }

  try {
    const snapshot = await getUsageIntelligence({ conversationId, requestedModelId })
    return Response.json(snapshot, {
      headers: {
        'Cache-Control': 'private, no-store, max-age=0',
      },
    })
  } catch (error) {
    console.error('[assistant/usage GET]', error)
    void captureAgentError(error, 'assistant.usage_failed', { route: 'assistant/usage' })
    return Response.json(
      { error: 'server_error', message: error instanceof Error ? error.message : 'Usage load failed' },
      { status: 500 },
    )
  }
}
