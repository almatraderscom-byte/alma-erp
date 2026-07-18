import { createHash } from 'node:crypto'
import { type NextRequest } from 'next/server'
import { requireAgentEnabled } from '@/agent/lib/guards'
import { identifyOfficeCallRequest } from '@/agent/lib/office-call-auth'
import {
  registerOfficeCallDevice,
  unregisterOfficeCallInstallation,
  type OfficeCallDeviceEnvironment,
} from '@/agent/lib/office-call-devices'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

type RegisterBody = {
  platform?: string
  environment?: string
  installationId?: string
  voipToken?: string
  fcmToken?: string
  appBuild?: string
  buildSha?: string
}

function legacyInstallationId(token: string) {
  return `legacy-${createHash('sha256').update(token).digest('hex').slice(0, 32)}`
}

export async function POST(req: NextRequest) {
  const disabled = requireAgentEnabled()
  if (disabled) return disabled
  const identity = await identifyOfficeCallRequest(req)
  if (!identity.ok) return Response.json({ error: identity.error }, { status: identity.code })

  let body: RegisterBody
  try {
    body = await req.json()
  } catch {
    return Response.json({ error: 'invalid_json' }, { status: 400 })
  }
  const platform = body.platform === 'ios' || body.platform === 'android' ? body.platform : null
  if (!platform) return Response.json({ error: 'platform_required' }, { status: 400 })
  const token = platform === 'ios' ? body.voipToken?.trim() : body.fcmToken?.trim()
  if (!token) return Response.json({ error: 'token_required' }, { status: 400 })
  const provider = platform === 'ios' ? 'apns_voip' : 'fcm'
  const environment: OfficeCallDeviceEnvironment =
    body.environment === 'sandbox' || body.environment === 'production'
      ? body.environment
      : platform === 'ios' && process.env.APNS_PRODUCTION !== 'true'
        ? 'sandbox'
        : 'production'
  const result = await registerOfficeCallDevice({
    userId: identity.userId,
    businessId: identity.businessId,
    installationId: body.installationId?.trim() || legacyInstallationId(token),
    platform,
    environment,
    provider,
    token,
    appBuild: body.appBuild,
    buildSha: body.buildSha,
  }).catch((error: unknown) => ({
    ok: false as const,
    error: error instanceof Error ? error.message : 'register_failed',
  }))
  if (!result.ok) {
    const status = result.error === 'office_call_device_key_unconfigured' ? 503 : 400
    return Response.json({ error: result.error }, { status })
  }
  return Response.json({ ok: true, deviceId: result.deviceId })
}

export async function DELETE(req: NextRequest) {
  const disabled = requireAgentEnabled()
  if (disabled) return disabled
  const identity = await identifyOfficeCallRequest(req)
  if (!identity.ok) return Response.json({ error: identity.error }, { status: identity.code })
  let body: { installationId?: string }
  try {
    body = await req.json()
  } catch {
    return Response.json({ error: 'invalid_json' }, { status: 400 })
  }
  const installationId = body.installationId?.trim()
  if (!installationId) return Response.json({ error: 'installation_id_required' }, { status: 400 })
  const removed = await unregisterOfficeCallInstallation({ userId: identity.userId, installationId })
  return Response.json({ ok: true, removed })
}
