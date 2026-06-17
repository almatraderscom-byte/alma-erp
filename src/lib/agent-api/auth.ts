import { timingSafeEqual } from 'crypto'
import { NextRequest, NextResponse } from 'next/server'

function safeEqual(a: string, b: string): boolean {
  try {
    const bufA = Buffer.from(a, 'utf8')
    const bufB = Buffer.from(b, 'utf8')
    if (bufA.length !== bufB.length) return false
    return timingSafeEqual(bufA, bufB)
  } catch {
    return false
  }
}

export function requireAgentApiKey(req: NextRequest): NextResponse | null {
  const expected = process.env.ALMA_AGENT_API_KEY?.trim()
  if (!expected) {
    return NextResponse.json({ error: 'Agent API not configured' }, { status: 503 })
  }
  const key = req.headers.get('x-alma-api-key')?.trim()
  if (!key || !safeEqual(key, expected)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  return null
}
