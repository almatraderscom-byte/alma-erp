/**
 * VPS-hosted TwiML + audio proxy for Twilio (same pattern as Hermes :3000).
 * Twilio must reach this over the public internet — port 3099 on the VPS.
 */

import http from 'http'
import { createHmac, timingSafeEqual } from 'crypto'
import { createClient } from '@supabase/supabase-js'

function escapeXml(text) {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function buildSalahCallTwiml(audioUrl, sayFallback) {
  const escaped = escapeXml(audioUrl)
  const say = sayFallback?.trim()
    ? `<Say voice="Polly.Aditi" language="bn-IN">${escapeXml(sayFallback.slice(0, 400))}</Say>`
    : ''
  return (
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<Response><Play>${escaped}</Play><Pause length="2"/><Play>${escaped}</Play>${say}</Response>`
  )
}

function buildSalahCallSayTwiml(text) {
  const escaped = escapeXml(text.slice(0, 400))
  return (
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<Response>` +
    `<Say voice="Polly.Aditi" language="bn-IN">${escaped}</Say>` +
    `<Pause length="1"/>` +
    `<Say voice="Polly.Aditi" language="bn-IN">${escaped}</Say>` +
    `</Response>`
  )
}

function signingSecret() {
  return process.env.AGENT_INTERNAL_TOKEN ?? process.env.TWILIO_AUTH_TOKEN ?? ''
}

function signAudioPath(storagePath, expMs) {
  return createHmac('sha256', signingSecret()).update(`${storagePath}:${expMs}`).digest('hex')
}

function verifyAudioToken(storagePath, expMs, token) {
  if (!token || !storagePath || !Number.isFinite(expMs)) return false
  if (Date.now() > expMs) return false
  const expected = signAudioPath(storagePath, expMs)
  try {
    const a = Buffer.from(expected, 'utf8')
    const b = Buffer.from(token, 'utf8')
    if (a.length !== b.length) return false
    return timingSafeEqual(a, b)
  } catch {
    return false
  }
}

export function buildProxiedAudioUrl(publicBase, storagePath, ttlSec = 900) {
  const exp = Date.now() + ttlSec * 1000
  const t = signAudioPath(storagePath, exp)
  const base = publicBase.replace(/\/$/, '')
  return `${base}/audio?path=${encodeURIComponent(storagePath)}&exp=${exp}&t=${t}`
}

export function buildTwimlCallbackUrl(publicBase, audioUrl, sayText) {
  const base = publicBase.replace(/\/$/, '')
  const params = new URLSearchParams({ audio: audioUrl })
  if (sayText?.trim()) params.set('say', sayText.slice(0, 400))
  return `${base}/twiml/salah-call?${params.toString()}`
}

export function buildTwimlSayOnlyUrl(publicBase, sayText) {
  const base = publicBase.replace(/\/$/, '')
  return `${base}/twiml/salah-call?say=${encodeURIComponent(sayText.slice(0, 400))}`
}

export function getTwilioPublicBase() {
  const configured = process.env.TWILIO_PUBLIC_BASE_URL?.replace(/\/$/, '')
  if (configured) return configured
  const host = process.env.TWILIO_PUBLIC_HOST ?? '31.97.237.40'
  const port = process.env.TWILIO_HTTP_PORT ?? '3099'
  return `http://${host}:${port}`
}

export function startTwilioHttpServer() {
  const port = Number(process.env.TWILIO_HTTP_PORT ?? 3099)
  const publicBase = getTwilioPublicBase()
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`)
      const pathname = url.pathname.replace(/\/$/, '') || '/'

      if (req.method === 'GET' && pathname === '/twiml/salah-call') {
        const audio = url.searchParams.get('audio')?.trim()
        const say = url.searchParams.get('say')?.trim()
        const xml = say && !audio
          ? buildSalahCallSayTwiml(say)
          : audio
            ? buildSalahCallTwiml(audio, say ?? undefined)
            : '<?xml version="1.0" encoding="UTF-8"?><Response></Response>'
        res.writeHead(200, { 'Content-Type': 'text/xml; charset=utf-8' })
        res.end(xml)
        return
      }

      if (req.method === 'GET' && pathname === '/audio') {
        const path = url.searchParams.get('path')?.trim()
        const exp = Number(url.searchParams.get('exp'))
        const token = url.searchParams.get('t')?.trim() ?? ''
        if (!path || !path.startsWith('calls/') || path.includes('..')) {
          res.writeHead(400)
          res.end('bad path')
          return
        }
        if (!verifyAudioToken(path, exp, token)) {
          res.writeHead(403)
          res.end('forbidden')
          return
        }
        const { data, error } = await supabase.storage.from('agent-files').download(path)
        if (error || !data) {
          res.writeHead(404)
          res.end('not found')
          return
        }
        const buf = Buffer.from(await data.arrayBuffer())
        res.writeHead(200, {
          'Content-Type': 'audio/wav',
          'Content-Length': String(buf.length),
          'Cache-Control': 'no-store',
        })
        res.end(buf)
        return
      }

      if (req.method === 'POST' && pathname === '/call-status') {
        res.writeHead(200)
        res.end('')
        return
      }

      if (pathname === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: true, publicBase }))
        return
      }

      res.writeHead(404)
      res.end('not found')
    } catch (err) {
      console.warn('[twilio-http]', err.message)
      res.writeHead(500)
      res.end('error')
    }
  })

  server.listen(port, '0.0.0.0', () => {
    console.log(`[twilio-http] listening on :${port} (public base ${publicBase})`)
  })

  return server
}
