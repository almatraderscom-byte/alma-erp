import { type NextRequest } from 'next/server'
import { getToken } from 'next-auth/jwt'
import { requireAgentEnabled } from '@/agent/lib/guards'
import { isSystemOwner } from '@/lib/roles'
import { runCreativeStudio, type CreativeStudioRunInput } from '@/lib/creative-studio/create-run'
import { resolveModel } from '@/lib/tryon/model-library'
import type { StudioModeId, StudioProvider, FamilyPresetId } from '@/lib/creative-studio/constants'

export const runtime = 'nodejs'
export const maxDuration = 60

async function auth(req: NextRequest) {
  const disabled = requireAgentEnabled()
  if (disabled) return disabled
  const token = await getToken({ req, secret: process.env.NEXTAUTH_SECRET })
  if (!token?.sub) return Response.json({ error: 'unauthorized' }, { status: 401 })
  if (!isSystemOwner(token)) return Response.json({ error: 'forbidden' }, { status: 403 })
  return null
}

export async function POST(req: NextRequest) {
  const denied = await auth(req)
  if (denied) return denied

  let body: CreativeStudioRunInput & { modelId?: string }
  try {
    body = await req.json()
  } catch {
    return Response.json({ error: 'invalid_json' }, { status: 400 })
  }

  if (body.modelId && !body.modelImagePath) {
    const model = await resolveModel(body.modelId)
    if (model) body.modelImagePath = model.imagePath
  }
  if (body.modelId && body.faceReferencePath === undefined) {
    const model = await resolveModel(body.modelId)
    if (model) body.faceReferencePath = model.imagePath
  }

  try {
    const result = await runCreativeStudio(body)
    return Response.json({
      ok: true,
      jobs: result.jobs,
      provider: result.provider,
      fashnReady: result.fashnReady,
      message:
        result.provider === 'fashn'
          ? 'FASHN render queued — Gallery-তে ফলাফল দেখুন।'
          : 'Gemini render queued — FASHN_API_KEY add করলে Pro quality পাবেন।',
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return Response.json({ error: msg }, { status: 422 })
  }
}
