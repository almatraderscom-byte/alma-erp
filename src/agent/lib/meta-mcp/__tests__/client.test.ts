import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

/**
 * Meta Ads MCP client (Phase MA1) — guards the wire contract:
 *   1. Handshake — initialize (MCP-Protocol-Version + Bearer headers) then
 *      notifications/initialized before any tools/* call; session id echoed.
 *   2. Bounded retry — exactly ONE retry on 429/5xx, then a typed retryable error.
 *   3. Auth recovery — 401 forces ONE token refresh and replays the request.
 *   4. Streamable HTTP — a text/event-stream single response parses like JSON.
 */

const tokenMock = vi.fn(async (_opts?: { forceRefresh?: boolean }) => 'tok-1')
vi.mock('../oauth', () => ({
  getMetaMcpAccessToken: (opts?: { forceRefresh?: boolean }) => tokenMock(opts),
  getMetaMcpEndpoint: () => 'https://mcp.example.test/ads',
}))

import {
  metaMcpCallTool,
  metaMcpListTools,
  MetaMcpError,
  __resetMetaMcpSessionForTests,
  __setMetaMcpRetryDelayForTests,
} from '../client'

type RpcBody = { id?: number; method: string; params?: Record<string, unknown> }

function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
    ...init,
  })
}

/** fetch stub that answers initialize/initialized automatically and delegates the rest. */
function stubMcpFetch(onCall: (body: RpcBody, req: Request) => Response | Promise<Response>) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init)
    const body = JSON.parse(init?.body as string) as RpcBody
    if (body.method === 'initialize') {
      return jsonResponse(
        { jsonrpc: '2.0', id: body.id, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'meta' } } },
        { headers: { 'Content-Type': 'application/json', 'Mcp-Session-Id': 'sess-1' } },
      )
    }
    if (body.method === 'notifications/initialized') return new Response(null, { status: 202 })
    return onCall(body, req)
  })
  vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch)
  return fetchMock
}

beforeEach(() => {
  __resetMetaMcpSessionForTests()
  __setMetaMcpRetryDelayForTests(0)
  tokenMock.mockClear()
  tokenMock.mockResolvedValue('tok-1')
})
afterEach(() => {
  vi.unstubAllGlobals()
})

describe('handshake + tools/list', () => {
  it('initializes first, sends protocol/auth headers, then lists tools', async () => {
    const fetchMock = stubMcpFetch((body) =>
      jsonResponse({ jsonrpc: '2.0', id: body.id, result: { tools: [{ name: 'ads_get_ad_accounts' }] } }),
    )
    const tools = await metaMcpListTools()
    expect(tools).toEqual([{ name: 'ads_get_ad_accounts' }])

    const methods = fetchMock.mock.calls.map((c) => (JSON.parse((c[1] as RequestInit).body as string) as RpcBody).method)
    expect(methods).toEqual(['initialize', 'notifications/initialized', 'tools/list'])

    const initHeaders = new Headers((fetchMock.mock.calls[0][1] as RequestInit).headers)
    expect(initHeaders.get('mcp-protocol-version')).toBe('2025-06-18')
    expect(initHeaders.get('authorization')).toBe('Bearer tok-1')

    // The session id from initialize rides on the tools/list call.
    const listHeaders = new Headers((fetchMock.mock.calls[2][1] as RequestInit).headers)
    expect(listHeaders.get('mcp-session-id')).toBe('sess-1')
  })

  it('follows nextCursor pagination', async () => {
    let page = 0
    stubMcpFetch((body) => {
      page++
      return jsonResponse({
        jsonrpc: '2.0',
        id: body.id,
        result: page === 1 ? { tools: [{ name: 'a' }], nextCursor: 'c2' } : { tools: [{ name: 'b' }] },
      })
    })
    const tools = await metaMcpListTools()
    expect(tools.map((t) => t.name)).toEqual(['a', 'b'])
  })
})

describe('tools/call', () => {
  it('returns the MCP result envelope', async () => {
    stubMcpFetch((body) => {
      expect(body.params).toEqual({ name: 'ads_insights_performance_trend', arguments: { days: 7 } })
      return jsonResponse({
        jsonrpc: '2.0',
        id: body.id,
        result: { content: [{ type: 'text', text: '{"trend":"up"}' }], isError: false },
      })
    })
    const result = await metaMcpCallTool('ads_insights_performance_trend', { days: 7 })
    expect(result.isError).toBe(false)
    expect(result.content?.[0].text).toBe('{"trend":"up"}')
  })

  it('surfaces a JSON-RPC error as a typed non-retryable rpc error', async () => {
    stubMcpFetch((body) => jsonResponse({ jsonrpc: '2.0', id: body.id, error: { code: -32602, message: 'bad params' } }))
    const err = await metaMcpCallTool('ads_get_errors', {}).catch((e) => e)
    expect(err).toBeInstanceOf(MetaMcpError)
    expect((err as MetaMcpError).code).toBe('rpc')
    expect((err as MetaMcpError).retryable).toBe(false)
  })
})

describe('bounded retry', () => {
  it('retries ONCE on 429 then succeeds', async () => {
    let calls = 0
    stubMcpFetch((body) => {
      calls++
      if (calls === 1) return new Response('slow down', { status: 429 })
      return jsonResponse({ jsonrpc: '2.0', id: body.id, result: { tools: [] } })
    })
    await expect(metaMcpListTools()).resolves.toEqual([])
    expect(calls).toBe(2)
  })

  it('fails with rate_limited after the second 429 (no infinite loop)', async () => {
    let calls = 0
    stubMcpFetch(() => {
      calls++
      return new Response('slow down', { status: 429 })
    })
    const err = await metaMcpListTools().catch((e) => e)
    expect((err as MetaMcpError).code).toBe('rate_limited')
    expect((err as MetaMcpError).retryable).toBe(true)
    expect(calls).toBe(2)
  })

  it('maps 5xx to provider_5xx after one retry', async () => {
    stubMcpFetch(() => new Response('boom', { status: 502 }))
    const err = await metaMcpListTools().catch((e) => e)
    expect((err as MetaMcpError).code).toBe('provider_5xx')
  })
})

describe('401 auth recovery', () => {
  it('forces one token refresh and replays', async () => {
    let calls = 0
    tokenMock.mockImplementation(async (opts) => (opts?.forceRefresh ? 'tok-2' : 'tok-1'))
    const fetchMock = stubMcpFetch((body, req) => {
      calls++
      if (req.headers.get('authorization') === 'Bearer tok-1') return new Response('expired', { status: 401 })
      return jsonResponse({ jsonrpc: '2.0', id: body.id, result: { tools: [] } })
    })
    await expect(metaMcpListTools()).resolves.toEqual([])
    expect(tokenMock).toHaveBeenCalledWith({ forceRefresh: true })
    expect(calls).toBe(2)
    expect(fetchMock).toHaveBeenCalled()
  })

  it('gives a typed auth error when refresh does not help', async () => {
    stubMcpFetch(() => new Response('expired', { status: 401 }))
    const err = await metaMcpListTools().catch((e) => e)
    expect((err as MetaMcpError).code).toBe('auth')
    expect((err as MetaMcpError).retryable).toBe(false)
  })

  it('propagates not_connected without any network call', async () => {
    tokenMock.mockRejectedValue(new Error('not_connected'))
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch)
    const err = await metaMcpListTools().catch((e) => e)
    expect((err as MetaMcpError).code).toBe('not_connected')
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('streamable HTTP (SSE single response)', () => {
  it('parses a text/event-stream body', async () => {
    stubMcpFetch((body) => {
      const sse = [
        'event: message',
        `data: ${JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { content: [{ type: 'text', text: 'ok' }] } })}`,
        '',
      ].join('\n')
      return new Response(sse, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
    })
    const result = await metaMcpCallTool('ads_get_help_article', { topic: 'x' })
    expect(result.content?.[0].text).toBe('ok')
  })
})
