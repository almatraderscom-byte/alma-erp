/**
 * VPS-hosted diagnostic HTTP — READ-ONLY code grep/read for agent self-diagnosis.
 * Port 3098 (Twilio uses 3099). Auth: AGENT_INTERNAL_TOKEN Bearer.
 */

import http from 'http'
import { timingSafeEqual } from 'crypto'
import { runCodeSearch } from './diagnostic/code-search.mjs'

function verifyToken(token) {
  const expected = process.env.AGENT_INTERNAL_TOKEN ?? ''
  if (!expected || !token) return false
  try {
    const a = Buffer.from(expected)
    const b = Buffer.from(token)
    return a.length === b.length && timingSafeEqual(a, b)
  } catch {
    return false
  }
}

export function getDiagnosticPublicBase() {
  const configured = process.env.AGENT_WORKER_DIAGNOSTIC_PUBLIC_URL?.replace(/\/$/, '')
  if (configured) return configured
  const host = process.env.DIAGNOSTIC_PUBLIC_HOST ?? process.env.TWILIO_PUBLIC_HOST ?? '31.97.237.40'
  const port = process.env.DIAGNOSTIC_HTTP_PORT ?? '3098'
  return `http://${host}:${port}`
}

export function startDiagnosticHttpServer() {
  const port = Number(process.env.DIAGNOSTIC_HTTP_PORT ?? 3098)
  const publicBase = getDiagnosticPublicBase()
  const repo = process.env.AGENT_REPO_PATH || '/opt/alma-erp'

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`)
      const pathname = url.pathname.replace(/\/$/, '') || '/'

      if (pathname === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: true, publicBase, repo }))
        return
      }

      if (req.method !== 'POST' || pathname !== '/code-search') {
        res.writeHead(404)
        res.end('not found')
        return
      }

      const auth = req.headers.authorization ?? ''
      const token = auth.startsWith('Bearer ') ? auth.slice(7) : ''
      if (!verifyToken(token)) {
        res.writeHead(401, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'unauthorized' }))
        return
      }

      const chunks = []
      for await (const chunk of req) chunks.push(chunk)
      let body
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'bad json' }))
        return
      }

      if (body.mode === 'grep' && (!body.query || body.query.length > 200)) {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'bad query' }))
        return
      }
      if (body.mode === 'read' && !body.file) {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'file required' }))
        return
      }

      const result = await runCodeSearch(body)
      const status = result.error === 'bad mode' || result.error === 'path out of repo' ? 400 : 200
      res.writeHead(status, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(result))
    } catch (err) {
      console.warn('[diagnostic-http]', err.message)
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: String(err.message) }))
    }
  })

  server.listen(port, '0.0.0.0', () => {
    console.log(`[diagnostic-http] listening on :${port} repo=${repo} (public ${publicBase})`)
  })

  return server
}
