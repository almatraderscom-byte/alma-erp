import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'
import { requireAgentApiKey } from '@/lib/agent-api/auth'
import { checkRateLimit } from '@/lib/agent-api/rate-limit'

export function guardAgentRequest(req: NextRequest): NextResponse | null {
  const rateLimited = checkRateLimit(req)
  if (rateLimited) return rateLimited
  return requireAgentApiKey(req)
}
