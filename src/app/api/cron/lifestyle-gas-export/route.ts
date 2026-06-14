import { NextRequest, NextResponse } from 'next/server'
import { notifyOwner } from '@/agent/lib/notify-owner'
import { exportLifestyleSnapshotToGas } from '@/lib/lifestyle/gas-export'
import { errorMeta, logEvent } from '@/lib/logger'

export const dynamic = 'force-dynamic'
export const maxDuration = 180

function cronAuthorized(req: NextRequest) {
  const auth = req.headers.get('authorization') || ''
  const expected = process.env.CRON_SECRET
  return expected && auth === `Bearer ${expected}`
}

export async function GET(req: NextRequest) {
  if (!cronAuthorized(req)) {
    return NextResponse.json({ error: 'Unauthorized cron' }, { status: 401 })
  }

  try {
    const result = await exportLifestyleSnapshotToGas()
    if (!result.ok) {
      await notifyOwner({
        tier: 2,
        title: 'Lifestyle sheet export failed',
        message: `Nightly Postgres→Sheet sync failed: ${result.error ?? 'unknown error'}. Counts: ${JSON.stringify(result.counts)}`,
        category: 'urgent',
      })
      return NextResponse.json({ ...result }, { status: 500 })
    }
    return NextResponse.json(result)
  } catch (e) {
    logEvent('error', 'migration.gas_export_cron_failed', errorMeta(e))
    await notifyOwner({
      tier: 2,
      title: 'Lifestyle sheet export crashed',
      message: `Nightly Postgres→Sheet cron error: ${(e as Error).message}`,
      category: 'urgent',
    })
    return NextResponse.json({ error: (e as Error).message }, { status: 500 })
  }
}
