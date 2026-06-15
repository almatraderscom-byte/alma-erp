/**
 * VPS-hosted diagnostic HTTP — code grep/read + duty retrigger for agent self-diagnosis.
 * Port 3098 (Twilio uses 3099). Auth: AGENT_INTERNAL_TOKEN Bearer.
 */

import http from 'http'
import { timingSafeEqual } from 'crypto'
import { createClient } from '@supabase/supabase-js'
import { runCodeSearch } from './diagnostic/code-search.mjs'

let _runSchedulerJob = null
export function setRetriggerHandler(fn) { _runSchedulerJob = fn }

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
        res.end(JSON.stringify({ ok: true, uptime: process.uptime(), pid: process.pid, ts: Date.now(), publicBase, repo }))
        return
      }

      const auth = req.headers.authorization ?? ''
      const token = auth.startsWith('Bearer ') ? auth.slice(7) : ''

      if (req.method === 'POST' && pathname === '/retrigger') {
        if (!verifyToken(token)) {
          res.writeHead(401, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'unauthorized' }))
          return
        }
        const chunks = []
        for await (const chunk of req) chunks.push(chunk)
        let body
        try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch {
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'bad json' }))
          return
        }
        if (!body.jobName || typeof body.jobName !== 'string') {
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'jobName required' }))
          return
        }
        if (!_runSchedulerJob) {
          res.writeHead(503, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'scheduler not initialized' }))
          return
        }
        console.log(`[diagnostic-http] retrigger request: ${body.jobName}`)
        try {
          await _runSchedulerJob(body.jobName, { catchUp: true })
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ ok: true, jobName: body.jobName }))
        } catch (err) {
          res.writeHead(500, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: err.message }))
        }
        return
      }

      if (req.method === 'POST' && pathname === '/deploy') {
        if (!verifyToken(token)) {
          res.writeHead(401, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'unauthorized' }))
          return
        }
        console.log('[diagnostic-http] deploy request received')
        const { execSync } = await import('child_process')
        const steps = []

        try {
          const pullOut = execSync(`cd ${repo} && git pull origin main 2>&1`, { timeout: 60_000, encoding: 'utf8' })
          steps.push({ step: 'git_pull', ok: true, output: pullOut.slice(-300) })
        } catch (err) {
          steps.push({ step: 'git_pull', ok: false, error: err.message?.slice(0, 300) ?? 'git pull failed' })
        }

        try {
          const npmOut = execSync(`cd ${repo}/worker && npm ci --omit=dev 2>&1`, { timeout: 120_000, encoding: 'utf8' })
          steps.push({ step: 'npm_install', ok: true, output: npmOut.slice(-200) })
        } catch (err) {
          steps.push({ step: 'npm_install', ok: false, error: err.message?.slice(0, 200) ?? 'npm ci failed' })
        }

        // PM2 restart must run AFTER the HTTP response — restarting kills this process.
        const npmOk = steps.find(s => s.step === 'npm_install')?.ok ?? false
        const gitOk = steps.find(s => s.step === 'git_pull')?.ok ?? false
        if (gitOk && npmOk) {
          steps.push({ step: 'pm2_restart', ok: true, output: 'restart scheduled (post-response)' })
        } else {
          steps.push({ step: 'pm2_restart', ok: false, error: 'skipped — git pull or npm install failed' })
        }

        const allOk = steps.every(s => s.ok)
        res.writeHead(allOk ? 200 : 207, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: allOk, steps }))

        if (gitOk && npmOk) {
          setImmediate(() => {
            try {
              execSync('pm2 restart agent-worker --update-env 2>&1', { timeout: 30_000, encoding: 'utf8' })
            } catch {
              try {
                execSync('pm2 restart alma-agent-worker --update-env 2>&1', { timeout: 30_000, encoding: 'utf8' })
              } catch (err) {
                console.error('[diagnostic-http] pm2 restart failed:', err.message?.slice(0, 200))
              }
            }
          })
        }
        return
      }

      if (req.method === 'POST' && pathname === '/staff-send') {
        if (!verifyToken(token)) {
          res.writeHead(401, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'unauthorized' }))
          return
        }
        try {
          const chunks = []
          for await (const chunk of req) chunks.push(chunk)
          const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
          const p = body.payload
          if (!p?.chatId) {
            res.writeHead(400, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ error: 'no chatId in payload' }))
            return
          }
          const { loggedSendToStaff } = await import('./telegram/logged-send.mjs')
          const { getDispatcherBot } = await import('./telegram/dispatcher.mjs')
          const bot = getDispatcherBot()
          if (!bot?.telegram) {
            res.writeHead(503, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ error: 'bot not ready' }))
            return
          }
          const result = await loggedSendToStaff(bot.telegram, {
            staffId: p.staffId, staffName: p.staffName, businessId: p.businessId,
            type: p.type, content: p.content, chatId: p.chatId,
            relatedTaskIds: p.relatedTaskIds,
            extra: { ...(p.extra ?? {}), skipApproval: true },
            requiresAck: p.requiresAck ?? false, officeHoursOnly: false,
          })
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ ok: true, result }))
        } catch (err) {
          res.writeHead(500, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: err.message?.slice(0, 300) }))
        }
        return
      }

      // ── Env Set (secured, append-only for worker .env) ──
      if (req.method === 'POST' && pathname === '/env-set') {
        if (!verifyToken(token)) {
          res.writeHead(401, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'unauthorized' }))
          return
        }
        const chunks = []
        for await (const chunk of req) chunks.push(chunk)
        let body
        try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch {
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'bad json' }))
          return
        }
        const { key, value } = body
        if (!key || typeof key !== 'string' || !value || typeof value !== 'string') {
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'key and value required' }))
          return
        }
        if (!/^[A-Z_][A-Z0-9_]*$/.test(key)) {
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'invalid key format' }))
          return
        }
        try {
          const fs = await import('fs')
          const path = await import('path')
          const envPath = path.join(repo, 'worker', '.env')
          let content = ''
          try { content = fs.readFileSync(envPath, 'utf8') } catch { /* new file */ }
          const re = new RegExp(`^${key}=.*$`, 'm')
          if (re.test(content)) {
            content = content.replace(re, `${key}=${value}`)
          } else {
            content = content.trimEnd() + `\n${key}=${value}\n`
          }
          fs.writeFileSync(envPath, content, 'utf8')
          process.env[key] = value
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ ok: true, key, action: 'set' }))
        } catch (err) {
          res.writeHead(500, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: err.message?.slice(0, 200) }))
        }
        return
      }

      // ── Vercel Alert Webhook ──
      if (req.method === 'POST' && pathname === '/vercel-alert') {
        const chunks = []
        for await (const chunk of req) chunks.push(chunk)
        let body
        try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch {
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'bad json' }))
          return
        }
        const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)
        const alerts = body.payload?.alerts ?? []
        for (const alert of alerts) {
          const key = `vercel.alert.${Date.now()}.${(alert.alertId ?? '').slice(0, 8)}`
          await supabase.from('agent_kv_settings').upsert({
            key,
            value: JSON.stringify({
              title: alert.title ?? 'Vercel Alert',
              severity: 'high',
              detail: `${alert.count ?? '?'} errors · z-score ${alert.zscore?.toFixed(1) ?? '?'}`,
              count: alert.count, type: alert.type,
              processed: false, receivedAt: new Date().toISOString(),
            }),
          })
        }
        console.log(`[diagnostic-http] received ${alerts.length} Vercel alert(s)`)
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: true, received: alerts.length }))
        return
      }

      // ── Auto-Fix: notify owner via Telegram ──
      if (req.method === 'POST' && pathname === '/auto-fix-notify') {
        if (!verifyToken(token)) {
          res.writeHead(401, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'unauthorized' }))
          return
        }
        const chunks = []
        for await (const chunk of req) chunks.push(chunk)
        let body
        try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch {
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'bad json' }))
          return
        }
        const { actionId, issue } = body
        const ownerChatId = process.env.TELEGRAM_OWNER_CHAT_ID
        const botToken = process.env.ASSISTANT_BOT_TOKEN
        if (ownerChatId && botToken) {
          const preview = issue.detail?.length > 100 ? issue.detail.slice(0, 100) + '…' : (issue.detail ?? '')
          await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              chat_id: ownerChatId,
              text: `🔧 Auto-Fix Request\n\n📋 ${issue.title}\n📁 ${issue.area} · ${issue.severity}\n📝 ${preview}\n\n💰 আনুমানিক খরচ: $${(issue.costEstimate ?? 0).toFixed(2)}\n\nApprove করলে Cursor Cloud Agent fix শুরু করবে`,
              reply_markup: {
                inline_keyboard: [[
                  { text: '✅ Fix করো', callback_data: `autofix_approve:${actionId}` },
                  { text: '❌ বাদ দাও', callback_data: `autofix_reject:${actionId}` },
                ]],
              },
            }),
          })
        }
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: true }))
        return
      }

      // ── Auto-Fix: run after owner approval ──
      if (req.method === 'POST' && pathname === '/auto-fix-run') {
        if (!verifyToken(token)) {
          res.writeHead(401, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'unauthorized' }))
          return
        }
        const chunks = []
        for await (const chunk of req) chunks.push(chunk)
        let body
        try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch {
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'bad json' }))
          return
        }
        setImmediate(async () => {
          try {
            const { dispatchAutoFix } = await import('./auto-fix/dispatch.mjs')
            await dispatchAutoFix({ actionId: body.actionId, issue: body.issue })
          } catch (err) {
            console.error('[auto-fix-run] dispatch failed:', err.message)
          }
        })
        res.writeHead(202, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: true, message: 'dispatched' }))
        return
      }

      if (req.method !== 'POST' || pathname !== '/code-search') {
        res.writeHead(404)
        res.end('not found')
        return
      }

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
