import { NextRequest, NextResponse } from 'next/server'

/** Proxy Drive/external logos for react-pdf (avoids CORS). */
export async function GET(req: NextRequest) {
  const url = new URL(req.url).searchParams.get('url')
  if (!url || !url.startsWith('https://')) {
    return NextResponse.json({ error: 'invalid url' }, { status: 400 })
  }
  try {
    const res = await fetch(url, { redirect: 'follow' })
    if (!res.ok) return NextResponse.json({ error: 'fetch failed' }, { status: 502 })
    const buf = Buffer.from(await res.arrayBuffer())
    const mime = res.headers.get('content-type') || 'image/png'
    const dataUrl = `data:${mime};base64,${buf.toString('base64')}`
    return NextResponse.json({ dataUrl }, { headers: { 'Cache-Control': 'private, max-age=3600' } })
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 })
  }
}
