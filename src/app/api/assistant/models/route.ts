import { type NextRequest } from 'next/server'
import { getToken } from 'next-auth/jwt'
import { requireAgentEnabled } from '@/agent/lib/guards'
import { isSystemOwner } from '@/lib/roles'
import { MODEL_REGISTRY, modelsByProvider, DEFAULT_MODEL_ID } from '@/agent/lib/models/registry'

export async function GET(req: NextRequest) {
  const disabled = requireAgentEnabled()
  if (disabled) return disabled

  const token = await getToken({ req, secret: process.env.NEXTAUTH_SECRET })
  if (!token?.sub) return Response.json({ error: 'unauthorized' }, { status: 401 })
  if (!isSystemOwner(token)) return Response.json({ error: 'forbidden' }, { status: 403 })

  return Response.json({
    defaultModelId: DEFAULT_MODEL_ID,
    models: MODEL_REGISTRY.map(({ id, label, provider, supportsCaching, default: isDefault }) => ({
      id,
      label,
      provider,
      supportsCaching,
      default: isDefault ?? false,
    })),
    byProvider: modelsByProvider(),
  })
}
