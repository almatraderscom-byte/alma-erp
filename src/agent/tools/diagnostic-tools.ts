import { runHealthScan } from '@/lib/diagnostic/health-scan'
import type { AgentTool } from './registry'

const APP_URL = () => (process.env.APP_URL ?? process.env.NEXTAUTH_URL ?? '').replace(/\/$/, '')
const INT = () => process.env.AGENT_INTERNAL_TOKEN ?? ''

async function codeSearch(body: Record<string, unknown>) {
  const base = APP_URL()
  if (!base || !INT()) return { error: 'APP_URL or AGENT_INTERNAL_TOKEN not configured' }
  const res = await fetch(`${base}/api/assistant/internal/code-search`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${INT()}` },
    body: JSON.stringify(body),
  })
  if (!res.ok) return { error: `code-search ${res.status}` }
  return res.json()
}

const run_health_scan: AgentTool = {
  name: 'run_health_scan',
  description:
    'Scan the whole system for problems RIGHT NOW: failed/missed scheduled jobs, dead heartbeats, cost ' +
    'anomalies, stuck approvals. Returns a prioritized issue list. Use for "system thik ache to", "kichu ' +
    'problem ache ki na dekho", or the daily morning health check. This only READS signals — never fixes.',
  input_schema: { type: 'object' as const, properties: {} },
  handler: async () => {
    try {
      const report = await runHealthScan()
      return { success: true, data: report }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  },
}

const diagnose_issue: AgentTool = {
  name: 'diagnose_issue',
  description:
    'Diagnose a specific problem the owner describes (in Bangla). Reads runtime signals AND searches the ' +
    'actual source code to find the ROOT CAUSE — returns the exact file/line and what fix is needed, in ' +
    'plain Bangla. DIAGNOSE-ONLY: never writes, commits, or applies any fix — the owner/engineer applies it. ' +
    'Use when the owner says "X kaj korche na", "Y te bug ache", "Z keno fail korche".',
  input_schema: {
    type: 'object' as const,
    properties: {
      problem: { type: 'string', description: 'The problem in the owner\'s words (Bangla ok)' },
      searchHint: {
        type: 'string',
        description: 'Optional code keyword to grep, e.g. "salah reminder", "buildStaffTaskProposal"',
      },
    },
    required: ['problem'],
  },
  handler: async (input) => {
    const problem = String(input.problem ?? '')
    const hint = input.searchHint ? String(input.searchHint) : ''

    let signals: unknown = null
    try {
      signals = await runHealthScan()
    } catch {
      /* ignore */
    }

    let codeMatches: unknown = null
    if (hint) {
      codeMatches = await codeSearch({ mode: 'grep', query: hint })
    }

    return {
      success: true,
      data: {
        problem,
        runtimeSignals: signals,
        codeMatches,
        instruction:
          'এই signal + code match দেখে root cause নির্ণয় করুন। দরকারে diagnose_issue আবার call করে আরও নির্দিষ্ট keyword দিয়ে grep করুন, অথবা read_source_file দিয়ে নির্দিষ্ট ফাইল পড়ুন। তারপর owner-কে বাংলায় বলুন: কোন ফাইল/লাইনে সমস্যা, কেন হচ্ছে, এবং কী fix লাগবে। কোড নিজে লিখবেন না — শুধু নির্ণয় ও পরামর্শ।',
      },
    }
  },
}

const read_source_file: AgentTool = {
  name: 'read_source_file',
  description:
    'Read a specific source file (relative path from repo root, e.g. "src/agent/lib/staff-task-proposal.ts") ' +
    'to inspect the exact code during diagnosis. READ-ONLY. Use after diagnose_issue/grep narrows down the ' +
    'likely file.',
  input_schema: {
    type: 'object' as const,
    properties: { file: { type: 'string', description: 'Repo-relative path' } },
    required: ['file'],
  },
  handler: async (input) => {
    const r = await codeSearch({ mode: 'read', file: String(input.file ?? '') })
    if ((r as { error?: string }).error) {
      return { success: false, error: (r as { error: string }).error }
    }
    return { success: true, data: r }
  },
}

const get_audit_summary: AgentTool = {
  name: 'get_audit_summary',
  description:
    'Get a security/audit summary: tool usage stats, failure rates, sensitive tool calls, ' +
    'pending actions, and AI cost for a given period. Use when owner asks "audit", "security check", ' +
    '"কত খরচ হচ্ছে", "কোন tool বেশি ব্যবহার হচ্ছে", etc.',
  input_schema: {
    type: 'object' as const,
    properties: {
      days: { type: 'number', description: 'Lookback days (default 7, max 30)' },
    },
  },
  handler: async (input) => {
    try {
      const days = Math.min(30, Math.max(1, Number(input.days ?? 7)))
      const since = new Date(Date.now() - days * 86_400_000).toISOString()
      const base = APP_URL()
      if (!base || !INT()) return { success: false, error: 'APP_URL or token not set' }

      const res = await fetch(`${base}/api/assistant/internal/audit-summary?since=${encodeURIComponent(since)}`, {
        headers: { Authorization: `Bearer ${INT()}` },
      })
      if (!res.ok) return { success: false, error: `HTTP ${res.status}` }
      return { success: true, data: await res.json() }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  },
}

export const DIAGNOSTIC_TOOLS: AgentTool[] = [run_health_scan, diagnose_issue, read_source_file, get_audit_summary]

export const DIAGNOSTIC_ROLE_PROMPT = `
## সেলফ-ডায়াগনস্টিক (শুধু নির্ণয়, fix নয়)
owner কোনো সমস্যা/বাগ বললে → diagnose_issue (distinctive keyword দিয়ে), দরকারে read_source_file দিয়ে নির্দিষ্ট ফাইল পড়ুন।
"system thik ache to / problem ache ki na" → run_health_scan।
নিয়ম:
- আপনি কোড **লিখবেন না, commit করবেন না, deploy করবেন না** — শুধু root cause + exact file/line + কী fix লাগবে বাংলায় বলুন। owner/Cursor fix করবে।
- অনুমান নয় — code পড়ে নিশ্চিত হয়ে বলুন। নিশ্চিত না হলে স্পষ্ট বলুন "এটা যাচাই করতে X ফাইল দেখা দরকার"।
- payroll/orders/finance core-এর diagnosis দিতে পারেন, কিন্তু কোনো অবস্থাতেই পরিবর্তন প্রস্তাব করে নিজে প্রয়োগ করবেন না।
`
