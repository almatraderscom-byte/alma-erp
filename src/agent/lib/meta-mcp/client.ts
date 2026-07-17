/**
 * Meta Ads MCP — Streamable HTTP client (Phase MA1).
 *
 * The repo already speaks MCP wire format as a SERVER
 * (src/app/api/assistant/mcp/route.ts); this is the same JSON-RPC 2.0 handling
 * in reverse: initialize → notifications/initialized → tools/list | tools/call
 * against https://mcp.facebook.com/ads with an OAuth Bearer token.
 *
 * Contract (plan §4): 20s timeout, single bounded retry on 429/5xx/network,
 * typed errors, 401 → one forced token refresh. Streamable HTTP servers may
 * answer either application/json or a single-response text/event-stream — both
 * are parsed here.
 */
import { getMetaMcpAccessToken, getMetaMcpEndpoint } from './oauth'

export const META_MCP_PROTOCOL_VERSION = '2025-06-18'
const CLIENT_INFO = { name: 'alma-agent-meta-mcp', version: '1.0.0' }
const CALL_TIMEOUT_MS = 20_000

export type MetaMcpErrorCode =
  | 'not_connected'
  | 'auth'
  | 'rate_limited'
  | 'timeout'
  | 'network'
  | 'provider_5xx'
  | 'rpc'
  | 'bad_response'

export class MetaMcpError extends Error {
  code: MetaMcpErrorCode
  retryable: boolean
  constructor(code: MetaMcpErrorCode, message: string) {
    super(message)
    this.name = 'MetaMcpError'
    this.code = code
    this.retryable = ['rate_limited', 'timeout', 'network', 'provider_5xx'].includes(code)
  }
}

export type McpToolDescriptor = {
  name: string
  description?: string
  inputSchema?: Record<string, unknown>
}

export type McpToolCallResult = {
  content?: Array<{ type: string; text?: string; [k: string]: unknown }>
  structuredContent?: unknown
  isError?: boolean
}

type JsonRpcResponse = {
  jsonrpc?: string
  id?: string | number | null
  result?: unknown
  error?: { code?: number; message?: string }
}

// Per-lambda-instance MCP session. Streamable HTTP sessions are cheap to
// re-establish, so losing this on cold start is fine.
let session: { id: string | null; initialized: boolean } = { id: null, initialized: false }
let nextId = 1

// Retry backoff — module-level so tests can zero it out.
let retryDelayMs = 500
export function __setMetaMcpRetryDelayForTests(ms: number): void {
  retryDelayMs = ms
}
export function __resetMetaMcpSessionForTests(): void {
  session = { id: null, initialized: false }
  nextId = 1
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Parse a single-response SSE body: last `data:` JSON payload that is a JSON-RPC response. */
function parseSseBody(text: string): JsonRpcResponse | null {
  let last: JsonRpcResponse | null = null
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line.startsWith('data:')) continue
    const payload = line.slice(5).trim()
    if (!payload || payload === '[DONE]') continue
    try {
      const msg = JSON.parse(payload) as JsonRpcResponse
      if (msg && (msg.result !== undefined || msg.error !== undefined)) last = msg
    } catch {
      // ignore non-JSON keepalive lines
    }
  }
  return last
}

async function parseRpcResponse(res: Response): Promise<JsonRpcResponse | null> {
  const ct = res.headers.get('content-type') ?? ''
  const text = await res.text()
  if (!text.trim()) return null
  if (ct.includes('text/event-stream')) return parseSseBody(text)
  try {
    return JSON.parse(text) as JsonRpcResponse
  } catch {
    throw new MetaMcpError('bad_response', `meta_mcp: unparseable response (${ct || 'no content-type'})`)
  }
}

type RpcOptions = { notification?: boolean; skipSession?: boolean }

/**
 * One JSON-RPC exchange with the Meta MCP endpoint.
 * Handles: Bearer auth (+ one 401 refresh-retry), one bounded retry on
 * 429/5xx/network/timeout, session header capture, SSE-or-JSON parsing.
 */
async function rpc(method: string, params?: Record<string, unknown>, opts?: RpcOptions): Promise<unknown> {
  const id = opts?.notification ? undefined : nextId++
  const body = JSON.stringify({ jsonrpc: '2.0', ...(id !== undefined ? { id } : {}), method, ...(params ? { params } : {}) })

  let triedRefresh = false
  let triedRetry = false
  let token: string
  try {
    token = await getMetaMcpAccessToken()
  } catch (e) {
    throw new MetaMcpError('not_connected', e instanceof Error ? e.message : 'not_connected')
  }

  // Bounded loop: at most one transient retry + at most one 401 refresh.
  for (;;) {
    let res: Response
    try {
      res = await fetch(getMetaMcpEndpoint(), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          Authorization: `Bearer ${token}`,
          'MCP-Protocol-Version': META_MCP_PROTOCOL_VERSION,
          ...(session.id && !opts?.skipSession ? { 'Mcp-Session-Id': session.id } : {}),
        },
        body,
        signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
      })
    } catch (e) {
      const isTimeout = e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError')
      if (!triedRetry) {
        triedRetry = true
        await sleep(retryDelayMs)
        continue
      }
      throw new MetaMcpError(isTimeout ? 'timeout' : 'network', e instanceof Error ? e.message : 'fetch failed')
    }

    if (res.status === 401) {
      if (!triedRefresh) {
        triedRefresh = true
        try {
          token = await getMetaMcpAccessToken({ forceRefresh: true })
        } catch (e) {
          throw new MetaMcpError('auth', e instanceof Error ? e.message : 'token refresh failed')
        }
        continue
      }
      throw new MetaMcpError('auth', 'meta_mcp: unauthorized (401) after refresh — আবার Connect চাপুন')
    }

    if (res.status === 404 && session.id && !opts?.skipSession) {
      // Session expired server-side — drop it; the caller (ensureInitialized path)
      // re-establishes on the next exchange.
      session = { id: null, initialized: false }
      throw new MetaMcpError('network', 'meta_mcp: session expired (404)')
    }

    if (res.status === 429 || res.status >= 500) {
      if (!triedRetry) {
        triedRetry = true
        await sleep(retryDelayMs)
        continue
      }
      await res.text().catch(() => '')
      throw new MetaMcpError(
        res.status === 429 ? 'rate_limited' : 'provider_5xx',
        `meta_mcp: HTTP ${res.status} on ${method}`,
      )
    }

    if (!res.ok) {
      const detail = (await res.text().catch(() => '')).slice(0, 300)
      throw new MetaMcpError('rpc', `meta_mcp: HTTP ${res.status} on ${method}: ${detail}`)
    }

    const sid = res.headers.get('mcp-session-id')
    if (sid) session.id = sid

    if (opts?.notification) {
      await res.text().catch(() => '')
      return null
    }

    const msg = await parseRpcResponse(res)
    if (!msg) throw new MetaMcpError('bad_response', `meta_mcp: empty response on ${method}`)
    if (msg.error) {
      throw new MetaMcpError('rpc', `meta_mcp: ${method} error ${msg.error.code ?? ''}: ${msg.error.message ?? 'unknown'}`)
    }
    return msg.result
  }
}

async function ensureInitialized(): Promise<void> {
  if (session.initialized) return
  await rpc('initialize', {
    protocolVersion: META_MCP_PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: CLIENT_INFO,
  })
  session.initialized = true
  // Spec-required notification; some servers 202 it, some ignore — best effort.
  await rpc('notifications/initialized', undefined, { notification: true }).catch(() => {})
}

/** Run `fn` with an initialized session; one transparent re-init when the session died. */
async function withSession<T>(fn: () => Promise<T>): Promise<T> {
  await ensureInitialized()
  try {
    return await fn()
  } catch (e) {
    if (e instanceof MetaMcpError && !session.initialized) {
      // 404 path reset the session — re-establish once and replay.
      await ensureInitialized()
      return fn()
    }
    throw e
  }
}

/** Full remote tool inventory (follows nextCursor pagination). */
export async function metaMcpListTools(): Promise<McpToolDescriptor[]> {
  return withSession(async () => {
    const tools: McpToolDescriptor[] = []
    let cursor: string | undefined
    for (let page = 0; page < 10; page++) {
      const result = (await rpc('tools/list', cursor ? { cursor } : undefined)) as {
        tools?: McpToolDescriptor[]
        nextCursor?: string
      }
      tools.push(...(result?.tools ?? []))
      if (!result?.nextCursor) break
      cursor = result.nextCursor
    }
    return tools
  })
}

/** Call one remote tool by its ORIGINAL Meta name (no meta_ prefix). */
export async function metaMcpCallTool(
  name: string,
  args: Record<string, unknown>,
): Promise<McpToolCallResult> {
  return withSession(async () => {
    const result = (await rpc('tools/call', { name, arguments: args })) as McpToolCallResult
    return result ?? {}
  })
}
