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

/**
 * Message-delivery call (playOnce): speak the audio exactly once, then hang up.
 * No double-play, no <Say> repetition. If there is no audio URL (say-only
 * retry case) a single <Say> + <Hangup/> is returned instead.
 */
export function buildMessageCallTwiml(audioUrl, sayFallback) {
  if (audioUrl) {
    return (
      `<?xml version="1.0" encoding="UTF-8"?>` +
      `<Response><Play>${escapeXml(audioUrl)}</Play><Hangup/></Response>`
    )
  }
  const say = sayFallback?.trim() ?? ''
  return (
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<Response><Say voice="Polly.Aditi" language="bn-IN">${escapeXml(say.slice(0, 400))}</Say><Hangup/></Response>`
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

/**
 * `once` flag is part of the signed payload when set. Backward compatible:
 * when once is falsy the payload is exactly the legacy shape, so in-flight
 * salah URLs (no once flag) keep verifying unchanged.
 */
function signTwimlQuery(audio, say, expMs, once = false) {
  const payload = once
    ? `${audio ?? ''}:${say ?? ''}:${expMs}:once`
    : `${audio ?? ''}:${say ?? ''}:${expMs}`
  return createHmac('sha256', signingSecret()).update(payload).digest('hex')
}

function verifyTwimlToken(audio, say, expMs, token, once = false) {
  if (!token || !Number.isFinite(expMs)) return false
  if (Date.now() > expMs) return false
  const expected = signTwimlQuery(audio, say, expMs, once)
  try {
    const a = Buffer.from(expected, 'utf8')
    const b = Buffer.from(token, 'utf8')
    if (a.length !== b.length) return false
    return timingSafeEqual(a, b)
  } catch {
    return false
  }
}

/** @param {{ once?: boolean }} [opts]  once=true → single play + hangup (message-delivery call) */
export function buildTwimlCallbackUrl(publicBase, audioUrl, sayText, opts = {}) {
  const base = publicBase.replace(/\/$/, '')
  const once = Boolean(opts.once)
  const exp = Date.now() + 900_000
  // Trim after slicing: the verifier trims the query value, so a slice ending in
  // whitespace would otherwise sign a different payload than it verifies (403).
  const say = sayText?.trim() ? sayText.slice(0, 400).trim() : ''
  const t = signTwimlQuery(audioUrl, say, exp, once)
  const params = new URLSearchParams({ audio: audioUrl, exp: String(exp), t })
  if (say) params.set('say', say)
  if (once) params.set('once', '1')
  return `${base}/twiml/salah-call?${params.toString()}`
}

/** @param {{ once?: boolean }} [opts]  once=true → single say + hangup (message-delivery call) */
export function buildTwimlSayOnlyUrl(publicBase, sayText, opts = {}) {
  const base = publicBase.replace(/\/$/, '')
  const once = Boolean(opts.once)
  const exp = Date.now() + 900_000
  const say = sayText.slice(0, 400).trim()
  const t = signTwimlQuery('', say, exp, once)
  const onceParam = once ? '&once=1' : ''
  return `${base}/twiml/salah-call?say=${encodeURIComponent(say)}&exp=${exp}&t=${t}${onceParam}`
}

function verifyTwilioSignature(authToken, signature, url, params) {
  if (!authToken || !signature) return false
  const sorted = Object.keys(params).sort()
  let data = url
  for (const key of sorted) data += key + params[key]
  const expected = createHmac('sha1', authToken).update(data).digest('base64')
  try {
    const a = Buffer.from(expected, 'utf8')
    const b = Buffer.from(signature, 'utf8')
    if (a.length !== b.length) return false
    return timingSafeEqual(a, b)
  } catch {
    return false
  }
}

async function readUrlEncodedBody(req) {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  const raw = Buffer.concat(chunks).toString('utf8')
  const params = {}
  for (const part of raw.split('&')) {
    if (!part) continue
    const eq = part.indexOf('=')
    const key = decodeURIComponent(eq >= 0 ? part.slice(0, eq) : part)
    const val = decodeURIComponent((eq >= 0 ? part.slice(eq + 1) : '').replace(/\+/g, ' '))
    if (key) params[key] = val
  }
  return params
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
        const exp = Number(url.searchParams.get('exp'))
        const token = url.searchParams.get('t')?.trim() ?? ''
        const once = url.searchParams.get('once') === '1'
        if (!verifyTwimlToken(audio ?? '', say ?? '', exp, token, once)) {
          res.writeHead(403)
          res.end('forbidden')
          return
        }
        const xml = once
          ? (audio || say
              ? buildMessageCallTwiml(audio || undefined, say ?? undefined)
              : '<?xml version="1.0" encoding="UTF-8"?><Response></Response>')
          : say && !audio
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
        const authToken = process.env.TWILIO_AUTH_TOKEN ?? ''
        const signature = req.headers['x-twilio-signature'] ?? ''
        const params = await readUrlEncodedBody(req)
        const publicUrl = `${publicBase}${url.pathname}${url.search}`
        if (authToken && !verifyTwilioSignature(authToken, signature, publicUrl, params)) {
          res.writeHead(403)
          res.end('forbidden')
          return
        }
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
