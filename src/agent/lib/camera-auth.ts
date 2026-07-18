import { timingSafeEqual } from 'node:crypto'
import { prisma } from '@/lib/prisma'

export type CameraCredentialKind = 'bridge' | 'listener'

const TOKEN_KEYS: Record<CameraCredentialKind, string> = {
  bridge: 'camera_bridge_token',
  listener: 'camera_listener_token',
}

export function cameraTokensEqual(presented: string, expected: string): boolean {
  if (!presented || !expected) return false
  const left = Buffer.from(presented)
  const right = Buffer.from(expected)
  if (left.length !== right.length) return false
  return timingSafeEqual(left, right)
}

async function tokenValue(key: string): Promise<string> {
  try {
    const row = await prisma.agentKvSetting.findUnique({ where: { key }, select: { value: true } })
    return row?.value.trim() ?? ''
  } catch {
    return ''
  }
}

/** Listener gets a separate credential when configured; legacy bridge token is a safe migration fallback. */
export async function getCameraCredential(kind: CameraCredentialKind): Promise<{
  token: string
  source: 'dedicated' | 'bridge_fallback'
}> {
  const dedicated = await tokenValue(TOKEN_KEYS[kind])
  if (dedicated || kind === 'bridge') return { token: dedicated, source: 'dedicated' }
  return { token: await tokenValue(TOKEN_KEYS.bridge), source: 'bridge_fallback' }
}

export async function cameraRequestAuthorized(
  headers: Pick<Headers, 'get'>,
  kind: CameraCredentialKind,
): Promise<{ ok: boolean; credentialSource: 'dedicated' | 'bridge_fallback' }> {
  const header = headers.get('authorization') ?? ''
  const presented = header.startsWith('Bearer ') ? header.slice(7).trim() : ''
  const credential = await getCameraCredential(kind)
  return {
    ok: cameraTokensEqual(presented, credential.token),
    credentialSource: credential.source,
  }
}

export async function cameraLeaseTokenRequired(): Promise<boolean> {
  const value = (await tokenValue('camera_bridge_require_lease_token')).toLowerCase()
  return value === 'on' || value === 'true' || value === '1'
}
