import { type NextRequest, NextResponse } from 'next/server'
import crypto from 'node:crypto'
import { requireAgentEnabled } from '@/agent/lib/guards'
import { TOOLS, type AgentTool } from '@/agent/tools/registry'

/**
 * Remote MCP "connector" for Claude.ai / Anthropic API.
 *
 * Exposes a DEFAULT-DENY, read-only slice of the agent tool registry so an
 * external Claude co-worker can pull ERP reports, inventory, customer intel and
 * run research — but can NEVER write, refund, message, publish, or touch
 * personal/family scope. Owner can widen the scope later via a follow-up.
 *
 * Transport: MCP Streamable HTTP (JSON-RPC 2.0 over POST, single-response mode).
 * Auth: Bearer CONNECTOR_TOKEN (separate least-privilege secret, constant-time).
 * Kill switch: AGENT_ENABLED (via requireAgentEnabled).
 */

export const runtime = 'nodejs'
export const maxDuration = 60

const PROTOCOL_VERSION = '2025-06-18'
const SERVER_INFO = { name: 'alma-erp-connector', version: '1.0.0' }

// Read-only verbs. Default-deny: a tool is exposed ONLY if its name starts with
// one of these prefixes (or is in EXTRA_ALLOW), and is never in FORCE_DENY.
const READ_ONLY_PREFIXES = [
  'get_', 'list_', 'search_', 'research_', 'analyze_', 'compare_',
  'audit_', 'recall_', 'fetch_website', 'read_competitor', 'web_research',
  'simulate_', 'advisor_',
]
const EXTRA_ALLOW = new Set(['marketing_report', 'check_order_issues', 'diagnose_issue'])
// Read-only but out of "business/research" scope for option A.
const FORCE_DENY = new Set(['list_family_contacts'])

function isExposed(name: string): boolean {
  if (FORCE_DENY.has(name)) return false
  if (EXTRA_ALLOW.has(name)) return true
  return READ_ONLY_PREFIXES.some((p) => name.startsWith(p))
}

const EXPOSED_TOOLS: AgentTool[] = TOOLS.filter((t) => isExposed(t.name))
const EXPOSED_BY_NAME = new Map<string, AgentTool>(EXPOSED_TOOLS.map((t) => [t.name, t]))

type JsonRpcId = string | number | null
type JsonRpcReq = {
  jsonrpc?: string
  id?: JsonRpcId
  method?: string
  params?: Record<string, unknown>
}

function tokenOk(req: NextRequest): boolean {
  const expected = process.env.CONNECTOR_TOKEN?.trim()
  if (!expected) return false
  const header = req.headers.get('authorization') ?? ''
  const provided = header.toLowerCase().startsWith('bearer ')
    ? header.slice(7).trim()
    : header.trim()
  if (!provided) return false
  const a = Buffer.from(provided)
  const b = Buffer.from(expected)
  if (a.length !== b.length) return false
  return crypto.timingSafeEqual(a, b)
}

function rpcResult(id: JsonRpcId, result: unknown) {
  return NextResponse.json({ jsonrpc: '2.0', id: id ?? null, result })
}
function rpcError(id: JsonRpcId, code: number, message: string, status = 200) {
  return NextResponse.json({ jsonrpc: '2.0', id: id ?? null, error: { code, message } }, { status })
}

export async function POST(req: NextRequest) {
  const disabled = requireAgentEnabled()
  if (disabled) return disabled

  if (!tokenOk(req)) {
    return NextResponse.json(
      { jsonrpc: '2.0', id: null, error: { code: -32001, message: 'unauthorized' } },
      { status: 401 },
    )
  }

  let body: JsonRpcReq | JsonRpcReq[]
  try {
    body = (await req.json()) as JsonRpcReq | JsonRpcReq[]
  } catch {
    return rpcError(null, -32700, 'Parse error', 400)
  }

  const msg = Array.isArray(body) ? body[0] : body
  const id = (msg?.id ?? null) as JsonRpcId
  const method = msg?.method

  switch (method) {
    case 'initialize':
      return rpcResult(id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
        instructions:
          'ALMA ERP read-only connector. Business reports, inventory, orders, customers, finance summaries, and market research. Read-only — no writes.',
      })
    case 'notifications/initialized':
    case 'initialized':
      return new NextResponse(null, { status: 202 })
    case 'ping':
      return rpcResult(id, {})
    case 'tools/list':
      return rpcResult(id, {
        tools: EXPOSED_TOOLS.map((t) => ({
          name: t.name,
          description: t.description,
          inputSchema: t.input_schema,
        })),
      })
    case 'tools/call': {
      const name = msg?.params?.name as string | undefined
      const args = (msg?.params?.arguments as Record<string, unknown> | undefined) ?? {}
      const tool = name ? EXPOSED_BY_NAME.get(name) : undefined
      if (!tool) {
        return rpcError(id, -32602, `Unknown or not-permitted tool: ${name ?? '(none)'}`)
      }
      try {
        const result = await tool.handler(args)
        const text = result.success
          ? JSON.stringify(result.data ?? null)
          : `Error: ${result.error ?? 'tool_failed'}`
        return rpcResult(id, {
          content: [{ type: 'text', text }],
          isError: !result.success,
        })
      } catch (err) {
        const message = err instanceof Error ? err.message : 'tool_exception'
        return rpcResult(id, { content: [{ type: 'text', text: `Error: ${message}` }], isError: true })
      }
    }
    default:
      return rpcError(id, -32601, `Method not found: ${method ?? '(none)'}`)
  }
}

export async function GET() {
  // Stateless server: no server-initiated SSE stream. Clients use POST.
  return new NextResponse('ALMA ERP MCP connector — use POST (JSON-RPC 2.0).', { status: 405 })
}
