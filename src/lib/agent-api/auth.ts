import { NextRequest, NextResponse } from 'next/server'

export function requireAgentApiKey(req: NextRequest): NextResponse | null {
  const expected = process.env.ALMA_AGENT_API_KEY?.trim()
  if (!expected) {
    return NextResponse.json({ error: 'Agent API not configured' }, { status: 503 })
  }
  const key = req.headers.get('x-alma-api-key')?.trim()
  if (!key || key !== expected) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  return null
}
