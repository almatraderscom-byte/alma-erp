/**
 * P2 VPS Workbench tools — the agent's sandboxed "own computer"
 * (docs/agent-computer-use-roadmap.md P2; executor: worker/src/workbench/executor.mjs).
 *
 * Claude-Code-style loop, one durable job per iteration: the head writes files
 * (scripts) + a bounded command list, the VPS runs them in an isolated per-task
 * workspace (binary allowlist, no shell, time/output/disk caps, no private
 * network), results come back via job-result — so success posts artifacts and
 * ANY failure automatically leaves a P0 checkpoint the owner can resume from.
 */
import { prisma } from '@/lib/prisma'
import type { AgentTool } from './registry'

const run_workbench_task: AgentTool = {
  name: 'run_workbench_task',
  description:
    "Run commands on the agent's own sandboxed VPS workspace (the \"workbench\") — like a mini " +
    'Claude Code: write files (scripts/data), run allowlisted programs (node, python3, git, curl, ffmpeg, ' +
    'jq, standard text tools), get stdout/stderr per step, and publish result files as artifacts.\n' +
    'USE FOR: data crunching (CSV/reports), scraping+analysis of PUBLIC pages, file conversion, small ' +
    'scripts/tools, SEO crawls. NOT for: anything needing the owner\'s logins (use live_browser), ' +
    'anything touching ERP data directly (use the ERP tools), or long-running servers.\n' +
    'LIMITS (hard, per run): 20 commands, 2 min/command, 8 min total, 200KB output/step, 500MB disk, ' +
    'no shell operators (each command = one binary + args array), no private/internal network access.\n' +
    'ITERATE: run → read step outputs → fix your script → run again (new task). Ask for output files ' +
    "back via `artifacts` (workspace-relative paths) — they're uploaded to storage on success.\n" +
    'VERIFY: after queueing, poll check_workbench_task until executed/failed — never claim done before.',
  input_schema: {
    type: 'object' as const,
    properties: {
      goal: { type: 'string', description: 'One-line goal (owner-readable; used in the task summary + checkpoint)' },
      files: {
        type: 'array',
        description: 'Files to write into the workspace before running (e.g. your script)',
        items: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'workspace-relative path, e.g. "main.py"' },
            content: { type: 'string' },
          },
          required: ['path', 'content'],
        },
      },
      commands: {
        type: 'array',
        description: 'Commands to run in order; each is ONE binary + args (no shell). Stops at first failure.',
        items: {
          type: 'object',
          properties: {
            bin: { type: 'string', description: 'Allowlisted binary, e.g. "python3", "node", "curl"' },
            args: { type: 'array', items: { type: 'string' } },
          },
          required: ['bin'],
        },
      },
      artifacts: {
        type: 'array',
        items: { type: 'string' },
        description: 'Workspace-relative output files to upload on success (max 10, 20MB each)',
      },
    },
    required: ['goal', 'commands'],
  },
  handler: async (input) => {
    try {
      // executeTool merges server context into input — conversationId rides along.
      const conversationId = typeof input.conversationId === 'string' ? input.conversationId : null
      const goal = String(input.goal ?? '').trim().slice(0, 160)
      const commands = Array.isArray(input.commands) ? input.commands : []
      if (!goal) return { success: false, error: 'goal required' }
      if (!commands.length || commands.length > 20) {
        return { success: false, error: 'commands must be 1-20 items' }
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const action = await (prisma as any).agentPendingAction.create({
        data: {
          conversationId,
          type: 'workbench_run',
          payload: {
            goal,
            files: input.files ?? [],
            commands,
            artifacts: input.artifacts ?? [],
            conversationId,
          },
          summary: `🛠️ Workbench: ${goal}`,
          costEstimate: 0,
          // Sandboxed compute with no owner-side effects → runs without an
          // approval card. Money/irreversible actions are impossible in the
          // sandbox by construction (binary allowlist, no private network).
          status: 'approved',
        },
      })

      return {
        success: true,
        data: {
          pendingActionId: action.id as string,
          note: 'Queued on the VPS workbench. Poll check_workbench_task; a failure leaves a resume checkpoint automatically.',
        },
      }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  },
}

const check_workbench_task: AgentTool = {
  name: 'check_workbench_task',
  description:
    'Check a workbench run: status (approved=queued, executed=done, failed), per-step stdout/stderr, and ' +
    'uploaded artifact storage paths. Read the FAILING step\'s stderr before retrying with a fixed script.',
  input_schema: {
    type: 'object' as const,
    properties: {
      pendingActionId: { type: 'string' },
    },
    required: ['pendingActionId'],
  },
  handler: async (input) => {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const action = await (prisma as any).agentPendingAction.findUnique({
        where: { id: String(input.pendingActionId ?? '') },
        select: { id: true, type: true, status: true, summary: true, result: true, createdAt: true, resolvedAt: true },
      })
      if (!action || action.type !== 'workbench_run') {
        return { success: false, error: 'workbench task not found' }
      }
      return {
        success: true,
        data: {
          id: action.id,
          status: action.status,
          summary: action.summary,
          result: action.result ?? null,
        },
      }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  },
}

export const WORKBENCH_TOOLS: AgentTool[] = [run_workbench_task, check_workbench_task]
