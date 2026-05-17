import { NextRequest, NextResponse } from 'next/server'

/** Proxy Drive/external logos for react-pdf (avoids CORS). */
export async function GET(req: NextRequest) {
  const url = new URL(req.url).searchParams.get('url')
  if (!url || !url.startsWith('https://')) {
    return NextResponse.json({ error: 'invalid url' }, { status: 400 })
  }
  const proxiedUrl = normalizeImageUrl(url)
  const parsed = new URL(proxiedUrl)
  const allowedHosts = ['drive.google.com', 'lh3.googleusercontent.com', 'storage.googleapis.com', 'supabase.co', 'vercel.app']
  if (!allowedHosts.some(host => parsed.hostname === host || parsed.hostname.endsWith(`.${host}`))) {
    return NextResponse.json({ error: 'image host not allowed' }, { status: 400 })
  }
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 6000)
  try {
    const res = await fetch(proxiedUrl, { redirect: 'follow', signal: ctrl.signal })
    if (!res.ok) return NextResponse.json({ error: 'fetch failed' }, { status: 502 })
    const mime = res.headers.get('content-type') || 'image/png'
    if (!mime.startsWith('image/')) return NextResponse.json({ error: 'unsupported content type' }, { status: 400 })
    const contentLength = Number(res.headers.get('content-length') || 0)
    if (contentLength > 2_000_000) return NextResponse.json({ error: 'image too large' }, { status: 413 })
    const buf = Buffer.from(await res.arrayBuffer())
    if (buf.byteLength > 2_000_000) return NextResponse.json({ error: 'image too large' }, { status: 413 })
    const dataUrl = `data:${mime};base64,${buf.toString('base64')}`
    return NextResponse.json({ dataUrl }, { headers: { 'Cache-Control': 'private, max-age=3600' } })
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 })
  } finally {
    clearTimeout(timer)
  }
}

function normalizeImageUrl(url: string) {
  try {
    const parsed = new URL(url)
    if (parsed.hostname === 'drive.google.com') {
      const fileMatch = parsed.pathname.match(/\/file\/d\/([^/]+)/)
      const id = fileMatch?.[1] || parsed.searchParams.get('id')
      if (id) return `https://drive.google.com/uc?export=view&id=${encodeURIComponent(id)}`
    }
  } catch {
    /* validated by caller */
  }
  return url
}
