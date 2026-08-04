import { timingSafeEqual } from 'node:crypto'
import { type NextRequest } from 'next/server'
import { requireAgentEnabled } from '@/agent/lib/guards'
import { publishCalendarEntry } from '@/agent/lib/growth/publish'
import {
  authenticateStudioRequest,
  studioAccessErrorResponse,
} from '@/lib/creative-studio/studio-access'
import {
  cancelStudioPublish,
  listStudioPublishDeliveries,
  previewStudioPublish,
  processDueStudioPublishes,
  retryStudioPublish,
  scheduleStudioPublish,
  setStudioMetaPublishingEnabled,
  StudioPublishError,
  studioPublishErrorResponse,
  type StudioPublisher,
} from '@/lib/creative-studio/publish-service'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 120

function internalAuthorized(req: NextRequest): boolean {
  const expected = process.env.AGENT_INTERNAL_TOKEN?.trim()
  const actual = req.headers.get('x-agent-internal-token')?.trim()
  if (!expected || !actual) return false
  const expectedBytes = Buffer.from(expected)
  const actualBytes = Buffer.from(actual)
  return expectedBytes.length === actualBytes.length
    && timingSafeEqual(expectedBytes, actualBytes)
}

const metaPublisher: StudioPublisher = async (entry) => {
  const outcome = await publishCalendarEntry({
    id: entry.id,
    platform: entry.platform,
    pageRef: entry.pageRef,
    caption: entry.caption,
    imageRef: entry.imageRef,
  })
  return {
    ...outcome,
    // The existing Graph path does not expose an idempotency token. Any error
    // after dispatch is therefore treated as ambiguous and quarantined instead
    // of automatically retried.
    safeToRetry: false,
    errorCode: outcome.ok ? undefined : 'meta_publish_unconfirmed',
  }
}

function routeError(error: unknown): Response {
  if (error instanceof StudioPublishError) {
    return studioPublishErrorResponse(error, 'creative-publish')
  }
  return studioAccessErrorResponse(error, 'creative-publish')
}

export async function GET(req: NextRequest) {
  const actor = await authenticateStudioRequest(req)
  if (actor instanceof Response) return actor
  const assetId = req.nextUrl.searchParams.get('assetId')?.trim() ?? ''
  const brandProfileId = req.nextUrl.searchParams.get('brandProfileId')
  if (!assetId) return Response.json({ error: 'asset_id_required' }, { status: 422 })
  try {
    return Response.json(await listStudioPublishDeliveries(actor, assetId, brandProfileId))
  } catch (error) {
    return routeError(error)
  }
}

export async function POST(req: NextRequest) {
  const disabled = requireAgentEnabled()
  if (disabled) return disabled
  let body: Record<string, unknown>
  try {
    body = await req.json() as Record<string, unknown>
  } catch {
    return Response.json({ error: 'invalid_json' }, { status: 400 })
  }

  if (body.intent === 'process_due') {
    if (!internalAuthorized(req)) return Response.json({ error: 'unauthorized' }, { status: 401 })
    try {
      return Response.json(await processDueStudioPublishes({
        publish: metaPublisher,
        limit: body.limit == null ? undefined : Number(body.limit),
      }))
    } catch (error) {
      return routeError(error)
    }
  }

  const actor = await authenticateStudioRequest(req)
  if (actor instanceof Response) return actor
  try {
    if (body.intent === 'dry_run') {
      return Response.json({ preview: await previewStudioPublish(actor, body) })
    }
    if (body.intent === 'set_enabled') {
      const brandProfileId = typeof body.brandProfileId === 'string' ? body.brandProfileId : ''
      if (!brandProfileId || typeof body.enabled !== 'boolean') {
        return Response.json({ error: 'invalid_publish_setting' }, { status: 422 })
      }
      return Response.json(await setStudioMetaPublishingEnabled(
        actor,
        brandProfileId,
        body.enabled,
      ))
    }
    if (body.intent === 'cancel') {
      return Response.json({
        delivery: await cancelStudioPublish(actor, String(body.deliveryId ?? '')),
      })
    }
    if (body.intent === 'retry') {
      return Response.json({
        delivery: await retryStudioPublish(actor, String(body.deliveryId ?? '')),
      })
    }
    if (body.intent !== 'schedule' && body.intent !== 'publish_now') {
      return Response.json({ error: 'invalid_publish_intent' }, { status: 422 })
    }
    const scheduled = await scheduleStudioPublish(actor, body)
    if (body.intent === 'publish_now') {
      const processing = await processDueStudioPublishes({
        publish: metaPublisher,
        deliveryId: scheduled.delivery.id,
        limit: 1,
      })
      const refreshed = await listStudioPublishDeliveries(
        actor,
        scheduled.delivery.assetId,
        scheduled.delivery.brandProfileId,
      )
      return Response.json({
        ...scheduled,
        delivery: refreshed.deliveries.find((row) => row.id === scheduled.delivery.id)
          ?? scheduled.delivery,
        processing,
      }, { status: scheduled.idempotent ? 200 : 201 })
    }
    return Response.json(scheduled, { status: scheduled.idempotent ? 200 : 201 })
  } catch (error) {
    return routeError(error)
  }
}
