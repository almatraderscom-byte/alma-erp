import { type NextRequest } from 'next/server'
import { getToken } from 'next-auth/jwt'
import { requireAgentEnabled } from '@/agent/lib/guards'
import { getGlobalOfficePetStatus } from '@/agent/lib/background-tasks/pet-status'
import { isSystemOwner } from '@/lib/roles'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const PRIVATE_NO_STORE_HEADERS = {
  'Cache-Control': 'private, no-store, max-age=0',
}

function emptyPetStatus() {
  return {
    runningCount: 0,
    attentionCount: 0,
    items: [],
    latestCompletion: null,
    updatedAt: new Date().toISOString(),
  }
}

/** Owner-only status feed for the app-wide floating Office Robot. */
export async function GET(req: NextRequest) {
  const disabled = requireAgentEnabled()
  if (disabled) return disabled

  const token = await getToken({ req, secret: process.env.NEXTAUTH_SECRET })
  if (!token?.sub) return Response.json({ error: 'unauthorized' }, { status: 401 })
  // AlmaAPI treats every 403 as an expired login. Authenticated non-owner users
  // therefore receive an empty snapshot rather than being logged out by this
  // owner-only ambient feature.
  if (!isSystemOwner(token)) {
    return Response.json(emptyPetStatus(), { headers: PRIVATE_NO_STORE_HEADERS })
  }

  return Response.json(await getGlobalOfficePetStatus(), {
    headers: PRIVATE_NO_STORE_HEADERS,
  })
}
