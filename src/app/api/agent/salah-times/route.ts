import { type NextRequest } from 'next/server'
import { getToken } from 'next-auth/jwt'
import { requireAgentEnabled } from '@/agent/lib/guards'
import { isSystemOwner } from '@/lib/roles'
import {
  getSalahTimeConfig,
  setSalahTimeConfig,
  setSalahWaqtTimes,
  isValidHm,
  WAQT_ORDER,
  type SalahTimeConfig,
  type WaqtKey,
} from '@/lib/salah/time-config'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

async function requireOwner(req: NextRequest) {
  const disabled = requireAgentEnabled()
  if (disabled) return { error: disabled }

  const token = await getToken({ req, secret: process.env.NEXTAUTH_SECRET })
  if (!token?.sub) return { error: Response.json({ error: 'unauthorized' }, { status: 401 }) }
  if (!isSystemOwner(token)) return { error: Response.json({ error: 'forbidden' }, { status: 403 }) }
  return { ok: true as const }
}

export async function GET(req: NextRequest) {
  const auth = await requireOwner(req)
  if ('error' in auth && auth.error) {
    if (auth.error instanceof Response) return auth.error
    return auth.error
  }

  try {
    const cfg = await getSalahTimeConfig()
    return Response.json({ config: cfg })
  } catch (err) {
    console.error('[agent/salah-times]', err)
    return Response.json({ error: 'server_error' }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  const auth = await requireOwner(req)
  if ('error' in auth && auth.error) {
    if (auth.error instanceof Response) return auth.error
    return auth.error
  }

  try {
    const body = await req.json() as {
      config?: SalahTimeConfig
      waqt?: WaqtKey
      azan?: string
      prayer?: string
      end?: string
    }

    if (body.config) {
      for (const waqt of WAQT_ORDER) {
        const row = body.config[waqt]
        if (!row) continue
        for (const k of ['azan', 'prayer', 'end'] as const) {
          if (row[k] && !isValidHm(row[k])) {
            return Response.json({ error: `${waqt}.${k} — HH:MM ফরম্যাট লাগবে` }, { status: 400 })
          }
        }
      }
      const saved = await setSalahTimeConfig(body.config)
      return Response.json({ ok: true, config: saved })
    }

    if (body.waqt) {
      const patch: Partial<SalahTimeConfig[WaqtKey]> = {}
      for (const k of ['azan', 'prayer', 'end'] as const) {
        const v = body[k]
        if (v != null) {
          if (!isValidHm(String(v))) {
            return Response.json({ error: `${k} — HH:MM ফরম্যাট লাগবে` }, { status: 400 })
          }
          patch[k] = String(v)
        }
      }
      if (!Object.keys(patch).length) {
        return Response.json({ error: 'কমপক্ষে একটি সময় দিন' }, { status: 400 })
      }
      const saved = await setSalahWaqtTimes(body.waqt, patch)
      return Response.json({ ok: true, config: saved })
    }

    return Response.json({ error: 'config বা waqt+times পাঠান' }, { status: 400 })
  } catch (err) {
    console.error('[agent/salah-times POST]', err)
    return Response.json({ error: 'server_error' }, { status: 500 })
  }
}
