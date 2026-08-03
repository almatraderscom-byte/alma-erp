/**
 * M2 — the agent runs Claude Code / Codex sessions on the owner's Mac for him.
 *
 * The owner works mostly in those two apps. This lets him keep working through
 * them when he is away from the desk: "open a session in alma-erp and have it fix
 * X", then "what is it doing?", then answer whatever it asks — all from chat.
 *
 * The permission mode is the safety dial and it defaults to the safest one:
 *   plan        — it reads and proposes, nothing on disk changes. DEFAULT.
 *   acceptEdits — file edits go through; other tools still ask.
 *   bypass      — fully unattended. This one costs an approval card BEFORE the
 *                 session opens, because after that nobody is checking each step.
 */
import type { AgentTool } from './registry'
import { prisma } from '@/lib/prisma'
import { activeDevice, awaitResult, enqueueCommand, isMacAgentEnabled } from '@/agent/lib/mac-agent/bus'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = prisma as any

type SessionPayload = Record<string, unknown>

async function requireMac(): Promise<{ ok: true; deviceId: string; deviceName: string } | { ok: false; error: string }> {
  if (!(await isMacAgentEnabled())) {
    return { ok: false, error: 'Mac control বন্ধ আছে, Boss — /agent/mac থেকে চালু করুন।' }
  }
  const device = await activeDevice()
  if (!device) return { ok: false, error: 'আপনার Mac এখন অফলাইন বা যুক্ত নেই, Boss।' }
  return { ok: true, deviceId: device.id, deviceName: device.name }
}

/** Send one session verb to the daemon and parse its JSON reply. */
async function callDaemon(
  deviceId: string,
  action: 'session_open' | 'session_send' | 'session_read' | 'session_stop' | 'session_list',
  params: SessionPayload,
  waitMs = 60_000,
): Promise<{ ok: boolean; data?: Record<string, unknown>; error?: string }> {
  const { id } = await enqueueCommand({ deviceId, action, params })
  const outcome = await awaitResult(id, waitMs)
  if (outcome.timedOut) return { ok: false, error: 'Mac থেকে সময়মতো উত্তর আসেনি।' }
  if (outcome.status !== 'done') return { ok: false, error: outcome.error ?? 'daemon_error' }
  try {
    return { ok: true, data: JSON.parse(outcome.stdout) as Record<string, unknown> }
  } catch {
    return { ok: false, error: 'daemon_bad_response' }
  }
}

const start_cli_session: AgentTool = {
  name: 'start_cli_session',
  description:
    "Open a Claude Code (or Codex) session on the owner's Mac and optionally give it the first task. " +
    'Use when he says things like "Claude-e ekta session khulo", "amar hoye ei kaj ta Claude ke diye korao", ' +
    'or asks for coding work done on his machine while he is away. ' +
    'permissionMode defaults to "plan" (it reads and proposes, changes nothing) — that is the right default. ' +
    'Use "acceptEdits" when he wants files actually changed. "bypass" runs fully unattended and ALWAYS creates ' +
    'an approval card first, because after that no one checks each step. ' +
    'Returns a sessionId — keep it, you need it to send more instructions or to check progress. ' +
    'After opening, use read_cli_session to watch what it does and tell him in Bangla.',
  input_schema: {
    type: 'object' as const,
    properties: {
      task: { type: 'string', description: 'The first instruction for the session. Optional.' },
      cwd: { type: 'string', description: 'Project folder. Defaults to ~/alma-erp. Must be an allowlisted folder.' },
      tool: { type: 'string', enum: ['claude', 'codex'], description: 'Defaults to claude.' },
      permissionMode: {
        type: 'string',
        enum: ['plan', 'acceptEdits', 'bypass'],
        description: 'Defaults to plan (safest). bypass requires an owner approval card.',
      },
      model: { type: 'string', description: 'Optional model override for the session.' },
      conversationId: { type: 'string', description: 'Server-managed — omit.' },
    },
    required: [],
  },
  handler: async (input) => {
    const gate = await requireMac()
    if (!gate.ok) return { success: false, error: gate.error }

    const permissionMode = String(input.permissionMode ?? 'plan')
    const task = input.task ? String(input.task) : undefined
    const cwd = input.cwd ? String(input.cwd) : undefined
    const tool = String(input.tool ?? 'claude')

    // An unattended session is a standing grant, not a single action — so it goes
    // through the owner the same way a state-changing command does.
    if (permissionMode === 'bypass') {
      const summary =
        `আপনার Mac-এ একটা **${tool === 'codex' ? 'Codex' : 'Claude'} সেশন** খুলবো — ` +
        `**সম্পূর্ণ নিজে থেকে** (প্রতি ধাপে অনুমতি নেবে না)।\n\n` +
        `ফোল্ডার: ${cwd ?? '~/alma-erp'}\n` +
        (task ? `কাজ: ${task}\n` : '') +
        `\nApprove করলে সেশনটা নিজেই ফাইল বদলাতে ও কমান্ড চালাতে পারবে।`

      const action = await db.agentPendingAction.create({
        data: {
          conversationId: input.conversationId ? String(input.conversationId) : null,
          type: 'cli_session_bypass',
          payload: { task: task ?? null, cwd: cwd ?? null, tool, model: input.model ?? null, deviceId: gate.deviceId },
          summary,
          costEstimate: 0,
          status: 'pending',
        },
      })
      return {
        success: true,
        data: {
          pendingActionId: action.id as string,
          message: 'সম্পূর্ণ স্বাধীন সেশন — আপনার অনুমতি লাগবে, তাই একটা card পাঠিয়েছি Boss।',
        },
      }
    }

    const res = await callDaemon(gate.deviceId, 'session_open', {
      task,
      cwd,
      tool,
      permissionMode,
      model: input.model ? String(input.model) : undefined,
    })
    if (!res.ok) return { success: false, error: res.error }

    return {
      success: true,
      data: {
        ...res.data,
        device: gate.deviceName,
        message:
          `${tool === 'codex' ? 'Codex' : 'Claude'} সেশন চালু হয়েছে (${permissionMode === 'plan' ? 'শুধু দেখবে ও পরিকল্পনা দেবে' : 'ফাইল বদলাতে পারবে'})। ` +
          'কিছুক্ষণ পরে অগ্রগতি দেখে জানাবো।',
      },
    }
  },
}

const send_to_cli_session: AgentTool = {
  name: 'send_to_cli_session',
  description:
    'Send another instruction (or an answer to a question it asked) into a running Claude/Codex session on the ' +
    "owner's Mac. Use this when he replies to something the session asked, or wants to add to the task. " +
    'Needs the sessionId from start_cli_session or list_cli_sessions.',
  input_schema: {
    type: 'object' as const,
    properties: {
      sessionId: { type: 'string', description: 'Session id.' },
      text: { type: 'string', description: 'What to say to the session.' },
    },
    required: ['sessionId', 'text'],
  },
  handler: async (input) => {
    const gate = await requireMac()
    if (!gate.ok) return { success: false, error: gate.error }
    const res = await callDaemon(gate.deviceId, 'session_send', {
      sessionId: String(input.sessionId),
      text: String(input.text ?? ''),
    })
    return res.ok ? { success: true, data: res.data } : { success: false, error: res.error }
  },
}

const read_cli_session: AgentTool = {
  name: 'read_cli_session',
  description:
    'Read what a Claude/Codex session on the Mac has done since you last looked. Returns its status, the assistant ' +
    'text, which tools it used, cost so far, and whether it finished, errored, or stalled. ' +
    'Pass sinceSeq (the lastSeq you got last time) to get only what is new. ' +
    'Use this to keep the owner posted in Bangla — summarise, do NOT dump raw events at him. ' +
    'If status is "error" with not_logged_in, tell him to run `claude` once in his Terminal and do /login. ' +
    'If it asked a question, relay the question and send his answer back with send_to_cli_session.',
  input_schema: {
    type: 'object' as const,
    properties: {
      sessionId: { type: 'string', description: 'Session id.' },
      sinceSeq: { type: 'number', description: 'Only return events after this sequence number.' },
    },
    required: ['sessionId'],
  },
  handler: async (input) => {
    const gate = await requireMac()
    if (!gate.ok) return { success: false, error: gate.error }
    const res = await callDaemon(gate.deviceId, 'session_read', {
      sessionId: String(input.sessionId),
      sinceSeq: Number(input.sinceSeq ?? 0),
    })
    return res.ok ? { success: true, data: res.data } : { success: false, error: res.error }
  },
}

const stop_cli_session: AgentTool = {
  name: 'stop_cli_session',
  description: 'Stop a running Claude/Codex session on the Mac. Use when the owner says stop, or the work is done.',
  input_schema: {
    type: 'object' as const,
    properties: { sessionId: { type: 'string', description: 'Session id.' } },
    required: ['sessionId'],
  },
  handler: async (input) => {
    const gate = await requireMac()
    if (!gate.ok) return { success: false, error: gate.error }
    const res = await callDaemon(gate.deviceId, 'session_stop', { sessionId: String(input.sessionId) })
    return res.ok ? { success: true, data: res.data } : { success: false, error: res.error }
  },
}

const list_cli_sessions: AgentTool = {
  name: 'list_cli_sessions',
  description:
    "List the Claude/Codex sessions currently running on the owner's Mac — what folder each is in, whether it is " +
    'working, idle, stalled or ended, and what it has cost. Use when he asks "ki ki cholche?" or you lost a sessionId.',
  input_schema: { type: 'object' as const, properties: {}, required: [] },
  handler: async () => {
    const gate = await requireMac()
    if (!gate.ok) return { success: false, error: gate.error }
    const res = await callDaemon(gate.deviceId, 'session_list', {}, 30_000)
    return res.ok ? { success: true, data: res.data } : { success: false, error: res.error }
  },
}

export const CLI_SESSION_TOOLS: AgentTool[] = [
  start_cli_session,
  send_to_cli_session,
  read_cli_session,
  stop_cli_session,
  list_cli_sessions,
]
