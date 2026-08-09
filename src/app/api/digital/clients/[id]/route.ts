import { NextRequest, NextResponse } from 'next/server'
import { serverGet } from '@/lib/server-api'

export async function GET(_req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  try {
    const data = await serverGet('cdit_client', { id: params.id }, 0)
    if (data && (data as { error?: string }).error) {
      return NextResponse.json(data, { status: 404 })
    }
    return NextResponse.json(data, { headers: { 'Cache-Control': 'private, no-store' } })
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 })
  }
}
