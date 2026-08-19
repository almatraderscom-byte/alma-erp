import { afterEach, describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const AGENT = resolve(__dirname, '../../../../../mac-agent/agent.mjs')
const TOKEN = 'outbox-test-token'
let daemon: ChildProcess | undefined
let server: Server | undefined
let testHome: string | undefined

afterEach(() => {
  daemon?.kill('SIGKILL')
  server?.close()
  if (testHome) rmSync(testHome, { recursive: true, force: true })
  daemon = undefined
  server = undefined
  testHome = undefined
})

describe('Mac daemon durable result outbox', () => {
  it('acks the first receipt before polling or executing the next command', async () => {
    testHome = mkdtempSync(join(tmpdir(), 'alma-mac-outbox-'))
    const configDir = join(testHome, '.alma-mac-agent')
    const pendingFile = join(configDir, 'pending-result.json')
    mkdirSync(configDir, { recursive: true, mode: 0o700 })

    const events: string[] = []
    let pollIndex = 0
    let firstResultAttempts = 0
    let pendingAtFailure = ''
    let finish: () => void = () => {}
    const complete = new Promise<void>((resolve) => { finish = resolve })
    server = createServer((req, res) => {
      if (req.headers.authorization !== `Bearer ${TOKEN}`) {
        res.writeHead(401).end('{}')
        return
      }
      if (req.url?.endsWith('/poll')) {
        const command = pollIndex === 0
          ? { id: 'command-a', action: 'ping', params: {} }
          : pollIndex === 1
            ? { id: 'command-b', action: 'ping', params: {} }
            : null
        events.push(`poll:${command?.id ?? 'idle'}`)
        pollIndex += 1
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ command }))
        return
      }
      if (req.url?.endsWith('/result')) {
        let raw = ''
        req.on('data', (chunk) => { raw += chunk })
        req.on('end', () => {
          const body = JSON.parse(raw) as { commandId: string }
          if (body.commandId === 'command-a') {
            firstResultAttempts += 1
            if (firstResultAttempts === 1) {
              pendingAtFailure = existsSync(pendingFile)
                ? JSON.parse(readFileSync(pendingFile, 'utf8')).commandId : ''
              events.push('result:command-a:failed')
              res.writeHead(500, { 'Content-Type': 'application/json' })
              res.end('{}')
              return
            }
          }
          events.push(`result:${body.commandId}:acked`)
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end('{"ok":true}')
          if (body.commandId === 'command-b') finish()
        })
        return
      }
      res.writeHead(404).end('{}')
    })
    await new Promise<void>((resolve) => server!.listen(0, resolve))
    const address = server.address()
    const port = typeof address === 'object' && address ? address.port : 0
    writeFileSync(join(configDir, 'config.json'), JSON.stringify({
      token: TOKEN,
      deviceId: 'outbox-device',
      baseUrl: `http://127.0.0.1:${port}`,
    }), { mode: 0o600 })

    daemon = spawn(process.execPath, [AGENT, 'run'], {
      env: {
        ...process.env,
        HOME: testHome,
        ALMA_BASE_URL: `http://127.0.0.1:${port}`,
        ALMA_POLL_MS: '20',
        ALMA_POLL_IDLE_MS: '20',
        // One inner attempt reproduces the old false-return path quickly; the
        // outer loop must retain/flush A instead of polling B.
        ALMA_RESULT_ATTEMPTS: '1',
      },
      stdio: 'ignore',
    })

    await Promise.race([
      complete,
      new Promise((_, reject) => setTimeout(
        () => reject(new Error(`daemon outbox timed out: ${events.join(',')}`)), 8_000)),
    ])

    expect(pendingAtFailure).toBe('command-a')
    expect(events.slice(0, 5)).toEqual([
      'poll:command-a',
      'result:command-a:failed',
      'result:command-a:acked',
      'poll:command-b',
      'result:command-b:acked',
    ])
    await expect.poll(() => existsSync(pendingFile), { timeout: 2_000 }).toBe(false)
    // Distinguishes the fixed outer-gate path from the old implementation,
    // which ignored postResult(false) and stayed inside its own delivery loop.
    expect(readFileSync(join(configDir, 'agent.log'), 'utf8'))
      .toContain('result for command-a is still unacknowledged')
  }, 10_000)
})
