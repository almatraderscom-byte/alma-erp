import { timingSafeEqual } from 'node:crypto'
import type { NextRequest } from 'next/server'
import { requireAgentEnabled } from '@/agent/lib/guards'
import {
  claimLifecycleJobs,
  lifecycleServiceErrorResponse,
  recordLifecycleWorkerResult,
} from '@/lib/creative-studio/lifecycle-service'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 120

function authorized(req: NextRequest): boolean {
  const expected = process.env.AGENT_INTERNAL_TOKEN?.trim() ?? ''
  const header = req.headers.get('authorization') ?? ''
  const provided = header.startsWith('Bearer ') ? header.slice(7).trim() : ''
  if (!expected || !provided) return false
  const left = Buffer.from(expected, 'utf8')
  const right = Buffer.from(provided, 'utf8')
  return left.length === right.length && timingSafeEqual(left, right)
}

function parseLimit(req: NextRequest): number {
  const value = Number(req.nextUrl.searchParams.get('limit'))
  return Number.isInteger(value) ? Math.max(1, Math.min(10, value)) : 5
}

export async function GET(req: NextRequest) {
  const disabled = requireAgentEnabled()
  if (disabled) return disabled
  if (!authorized(req)) return Response.json({ error: 'unauthorized' }, { status: 401 })
  try {
    const jobs = await claimLifecycleJobs({ limit: parseLimit(req) })
    return Response.json({
      jobs,
      executionPolicy: {
        zeroCostLocalOnly: true,
        paidProvidersAllowed: false,
        automaticAmbiguousRetry: false,
      },
    })
  } catch (error) {
    return lifecycleServiceErrorResponse(error, 'creative-lifecycle-claim')
  }
}

export async function POST(req: NextRequest) {
  const disabled = requireAgentEnabled()
  if (disabled) return disabled
  if (!authorized(req)) return Response.json({ error: 'unauthorized' }, { status: 401 })
  let body: Record<string, unknown>
  try {
    body = await req.json() as Record<string, unknown>
  } catch {
    return Response.json({ error: 'invalid_json' }, { status: 400 })
  }
  if (body.outcome !== 'ready' && body.outcome !== 'failed') {
    return Response.json({ error: 'invalid_lifecycle_outcome' }, { status: 422 })
  }
  try {
    const job = await recordLifecycleWorkerResult({
      jobId: String(body.jobId ?? ''),
      leaseToken: String(body.leaseToken ?? ''),
      outcome: body.outcome,
      storagePath: typeof body.storagePath === 'string' ? body.storagePath : undefined,
      checksum: typeof body.checksum === 'string' ? body.checksum : undefined,
      sizeBytes: typeof body.sizeBytes === 'number' ? body.sizeBytes : undefined,
      artifactVersionId: typeof body.artifactVersionId === 'string'
        ? body.artifactVersionId
        : undefined,
      errorCode: typeof body.errorCode === 'string' ? body.errorCode : undefined,
      errorMessage: typeof body.errorMessage === 'string' ? body.errorMessage : undefined,
      ambiguousEffect: body.ambiguousEffect === true,
      operationPackageChecksum: typeof body.operationPackageChecksum === 'string'
        ? body.operationPackageChecksum
        : undefined,
      playableProxyPath: typeof body.playableProxyPath === 'string'
        ? body.playableProxyPath
        : undefined,
      originalStoragePath: typeof body.originalStoragePath === 'string'
        ? body.originalStoragePath
        : undefined,
    })
    return Response.json({ job })
  } catch (error) {
    return lifecycleServiceErrorResponse(error, 'creative-lifecycle-result')
  }
}
