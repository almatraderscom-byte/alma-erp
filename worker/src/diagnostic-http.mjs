/**
 * VPS-hosted diagnostic HTTP — code grep/read + duty retrigger for agent self-diagnosis.
 * Port 3098 (Twilio uses 3099). Auth: AGENT_INTERNAL_TOKEN Bearer.
 */

import http from 'http'
import { execSync } from 'child_process'
import { timingSafeEqual } from 'crypto'
import { createClient } from '@supabase/supabase-js'
import { runCodeSearch } from './diagnostic/code-search.mjs'

let _runSchedulerJob = null
export function setRetriggerHandler(fn) { _runSchedulerJob = fn }

/** Short git HEAD of the repo on disk, or null if unavailable. */
function readGitCommit(repo) {
  try {
    return execSync(`cd ${repo} && git rev-parse --short HEAD`, { timeout: 5_000, encoding: 'utf8' }).trim()
  } catch {
    return null
  }
}

/** Locate the pm2 binary across PATH / npm-global / nvm install layouts. */
function findPm2() {
  for (const probe of ['command -v pm2', 'which pm2']) {
    try {
      const p = execSync(probe, { timeout: 5_000, encoding: 'utf8' }).trim().split('\n')[0]
      if (p) return p
    } catch { /* not on PATH */ }
  }
  const home = process.env.HOME ?? '/root'
  const guesses = [
    '/usr/local/bin/pm2', '/usr/bin/pm2',
    `${home}/.npm-global/bin/pm2`, `${home}/.local/bin/pm2`,
  ]
  try {
    const nvm = execSync(`ls -1 ${home}/.nvm/versions/node/*/bin/pm2 2>/dev/null`, { timeout: 5_000, encoding: 'utf8' })
      .trim().split('\n').filter(Boolean)
    guesses.push(...nvm)
  } catch { /* no nvm */ }
  for (const g of guesses) {
    try { execSync(`test -x ${g}`, { timeout: 3_000 }); return g } catch { /* next */ }
  }
  return null
}

/**
 * Restart THIS worker so freshly-pulled code runs. Tries the pm2 CLI (resolved
 * binary + actual process name from `pm2 jlist`); if pm2 can't be invoked, EXITS
 * the process so pm2 (which manages it with autorestart) respawns it on the new
 * code. Bulletproof as long as the worker runs under pm2. Call only AFTER the
 * HTTP response is flushed — it may terminate this process.
 */
function restartSelf() {
  const pm2 = findPm2()
  if (pm2) {
    let names = []
    try {
      names = JSON.parse(execSync(`${pm2} jlist`, { timeout: 10_000, encoding: 'utf8' }))
        .map((p) => p?.name).filter(Boolean)
    } catch { /* jlist unavailable */ }
    if (!names.length) names = ['alma-agent-worker', 'agent-worker']
    for (const n of names) {
      try {
        execSync(`${pm2} restart ${n} --update-env 2>&1`, { timeout: 30_000, encoding: 'utf8' })
        console.log(`[diagnostic-http] restarted "${n}" via ${pm2}`)
        return
      } catch { /* try next name */ }
    }
    try {
      execSync(`${pm2} restart all --update-env 2>&1`, { timeout: 30_000, encoding: 'utf8' })
      console.log('[diagnostic-http] restarted all via pm2')
      return
    } catch { /* fall through to self-exit */ }
  }
  // Last resort: under pm2, exiting triggers an automatic respawn on the new code.
  const underPm2 = process.env.pm_id !== undefined || Boolean(process.env.PM2_HOME) || Boolean(process.env.PM2_USAGE)
  if (underPm2) {
    console.log('[diagnostic-http] pm2 CLI unreachable — exiting so pm2 respawns on new code')
    setTimeout(() => process.exit(0), 300)
    return
  }
  console.error('[diagnostic-http] CRITICAL: cannot restart (pm2 not found and not under pm2)')
}

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

/** Bearer Authorization OR X-Internal-Token — some egress proxies (e.g. the
 * Claude Code sandbox relay) strip the Authorization header on plain HTTP,
 * so a custom header carries the same secret with the same constant-time check. */
function tokenFromRequest(req) {
  const auth = req.headers.authorization ?? ''
  if (auth.startsWith('Bearer ')) return auth.slice(7)
  const custom = req.headers['x-internal-token']
  return typeof custom === 'string' ? custom : ''
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

  // Commit this process was STARTED from. After a successful deploy+restart a
  // fresh process re-reads this and it equals the pulled commit — which is how
  // the deploy proves the new code is actually running (not just pulled to disk).
  const BOOT_COMMIT = readGitCommit(repo)
  console.log(`[diagnostic-http] boot commit=${BOOT_COMMIT ?? 'unknown'}`)

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`)
      const pathname = url.pathname.replace(/\/$/, '') || '/'

      if (pathname === '/health') {
        const token = tokenFromRequest(req)
        if (verifyToken(token)) {
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ ok: true, uptime: process.uptime(), pid: process.pid, ts: Date.now(), publicBase, repo, bootCommit: BOOT_COMMIT }))
        } else {
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ ok: true }))
        }
        return
      }

      const token = tokenFromRequest(req)

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
        if (process.env.DIAGNOSTIC_DEPLOY_ENABLED === 'false') {
          res.writeHead(403, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'deploy_disabled' }))
          return
        }
        console.log('[diagnostic-http] deploy request received')
        const steps = []
        const prevCommit = readGitCommit(repo)

        try {
          // Hard-sync to origin/main so a click ALWAYS lands the latest code, even
          // if the VPS working tree drifted (local edits make `git pull` conflict
          // and silently stall). reset --hard touches only tracked files, leaving
          // gitignored .env / secrets in place.
          execSync(`cd ${repo} && git fetch origin main 2>&1`, { timeout: 60_000, encoding: 'utf8' })
          const pullOut = execSync(`cd ${repo} && git reset --hard origin/main 2>&1`, { timeout: 60_000, encoding: 'utf8' })
          steps.push({ step: 'git_pull', ok: true, output: pullOut.slice(-300) })
        } catch (err) {
          steps.push({ step: 'git_pull', ok: false, error: err.message?.slice(0, 300) ?? 'git sync failed' })
        }

        // Commit now on disk after the pull — the client polls /health until the
        // worker reports a bootCommit equal to this, proving the restart landed.
        const targetCommit = readGitCommit(repo)

        try {
          let npmOut
          try {
            npmOut = execSync(`cd ${repo}/worker && npm ci --omit=dev 2>&1`, { timeout: 180_000, encoding: 'utf8' })
          } catch {
            // npm ci is strict (needs a perfectly in-sync lockfile). Fall back to
            // npm install so a lockfile drift can't block the deploy.
            npmOut = execSync(`cd ${repo}/worker && npm install --omit=dev 2>&1`, { timeout: 180_000, encoding: 'utf8' })
          }
          steps.push({ step: 'npm_install', ok: true, output: npmOut.slice(-200) })
        } catch (err) {
          steps.push({ step: 'npm_install', ok: false, error: err.message?.slice(0, 200) ?? 'npm install failed' })
        }

        // PM2 restart must run AFTER the HTTP response — restarting kills this process.
        const npmOk = steps.find(s => s.step === 'npm_install')?.ok ?? false
        const gitOk = steps.find(s => s.step === 'git_pull')?.ok ?? false
        // The restart kills THIS process, so it must run after the response and
        // cannot report its own success here. We mark it "scheduled" (not "ok")
        // and the client verifies the real outcome via /health bootCommit.
        if (gitOk && npmOk) {
          steps.push({ step: 'pm2_restart', ok: true, output: 'restart scheduled — verify via bootCommit' })
        } else {
          steps.push({ step: 'pm2_restart', ok: false, error: 'skipped — git pull or npm install failed' })
        }

        const allOk = steps.every(s => s.ok)
        res.writeHead(allOk ? 200 : 207, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: allOk, steps, prevCommit, targetCommit }))

        if (gitOk && npmOk) {
          // Runs AFTER the response is flushed — restartSelf() may exit the process
          // so pm2 respawns it on the new code (verified by the caller via /health
          // bootCommit).
          setImmediate(restartSelf)
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
        if (process.env.DIAGNOSTIC_ENV_SET_ENABLED === 'false') {
          res.writeHead(403, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'env_set_disabled' }))
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
        if (value.includes('\n') || value.includes('\r')) {
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'value must be single-line' }))
          return
        }
        try {
          const fs = await import('fs')
          const path = await import('path')
          const envPath = path.join(repo, 'worker', '.env')
          let content = ''
          try { content = fs.readFileSync(envPath, 'utf8') } catch { /* new file */ }
          const escaped = value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
          const line = `${key}="${escaped}"`
          const re = new RegExp(`^${key}=.*$`, 'm')
          if (re.test(content)) {
            content = content.replace(re, line)
          } else {
            content = content.trimEnd() + `\n${line}\n`
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
