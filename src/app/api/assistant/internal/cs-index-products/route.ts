import { type NextRequest } from 'next/server'
import { timingSafeEqual } from 'crypto'
import { requireAgentEnabled } from '@/agent/lib/guards'
import { runFullProductIndex } from '@/agent/lib/cs/product-index'
import { catalogStatus } from '@/agent/lib/catalog/product-images'

export const runtime = 'nodejs'
export const maxDuration = 300

function verifyToken(provided: string): boolean {
  const expected = process.env.AGENT_INTERNAL_TOKEN ?? ''
  if (!expected || !provided) return false
  try {
    const a = Buffer.from(expected, 'utf8')
    const b = Buffer.from(provided, 'utf8')
    if (a.length !== b.length) return false
    return timingSafeEqual(a, b)
  } catch { return false }
}

export async function POST(req: NextRequest) {
  const disabled = requireAgentEnabled()
  if (disabled) return disabled

  const authHeader = req.headers.get('authorization') ?? ''
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : ''
  if (!verifyToken(token)) return Response.json({ error: 'unauthorized' }, { status: 401 })

  try {
    const result = await runFullProductIndex()
    const status = await catalogStatus()

    return Response.json({
      ...result,
      withImages: status.withImages,
      missingCount: status.missingCount,
      topMissing: status.topMissing.slice(0, 20),
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error'
    console.error('[cs-index-products]', message)
    return Response.json({ error: message.slice(0, 500) }, { status: 500 })
  }
}
