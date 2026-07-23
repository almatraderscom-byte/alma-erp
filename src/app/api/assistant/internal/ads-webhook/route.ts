/**
 * Meta Ads Webhooks receiver (2026 ad_account webhooks).
 * GET: hub.challenge verification (same verify token as the Messenger webhook).
 * POST: signed ad_account events — effective_status / creative_fatigue /
 *       ad_recommendations / with_issues_ad_objects / subscriptions →
 *       dedupe + Bangla owner push. See src/agent/lib/marketing/ads-webhooks.ts.
 */
import { type NextRequest } from 'next/server'
import { requireAgentEnabled } from '@/agent/lib/guards'
import { verifyMetaWebhookSignature } from '@/agent/lib/cs/meta-messenger'
import { handleAdsWebhook, type AdsWebhookEnvelope } from '@/agent/lib/marketing/ads-webhooks'

export const runtime = 'nodejs'

export async function GET(req: NextRequest) {
  const mode = req.nextUrl.searchParams.get('hub.mode')
  const token = req.nextUrl.searchParams.get('hub.verify_token')
  const challenge = req.nextUrl.searchParams.get('hub.challenge')
  const expected = process.env.META_WEBHOOK_VERIFY_TOKEN ?? ''

  if (mode === 'subscribe' && expected && token === expected && challenge) {
    return new Response(challenge, { status: 200 })
  }
  return Response.json({ error: 'forbidden' }, { status: 403 })
}

export async function POST(req: NextRequest) {
  const disabled = requireAgentEnabled()
  if (disabled) return disabled

  const rawBody = await req.text()
  const sig = req.headers.get('x-hub-signature-256')
  if (!verifyMetaWebhookSignature(rawBody, sig)) {
    return Response.json({ error: 'invalid_signature' }, { status: 401 })
  }

  let envelope: AdsWebhookEnvelope
  try {
    envelope = JSON.parse(rawBody) as AdsWebhookEnvelope
  } catch {
    return Response.json({ error: 'invalid_json' }, { status: 400 })
  }

  try {
    const result = await handleAdsWebhook(envelope)
    return Response.json({ ok: true, ...result })
  } catch (err) {
    // Always 200-range fast so Meta doesn't retry-storm; error is logged.
    console.error('[ads-webhook] handler failed:', err instanceof Error ? err.message : err)
    return Response.json({ ok: false })
  }
}
