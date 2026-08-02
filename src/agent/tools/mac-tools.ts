/**
 * M1 — the agent's hands on the owner's Mac.
 *
 * One tool does the work (`run_mac_command`) and the classifier decides what
 * happens to each request, not the model:
 *   RED   → refused here, with the Bangla reason. No card, no retry path.
 *   AMBER → an approval card carrying the EXACT command text; nothing runs until
 *           the owner taps ✅ (the approve route then enqueues it).
 *   GREEN → runs immediately and the output comes straight back in the reply.
 *
 * The model cannot talk its way past this: it never sees a "force" flag, and the
 * bus refuses an amber enqueue that has no approval id attached.
 */
import type { AgentTool } from './registry'
import { prisma } from '@/lib/prisma'
import {
  activeDevice,
  awaitResult,
  createPairingTicket,
  enqueueCommand,
  getCommand,
  isMacAgentEnabled,
  listDevices,
  recentCommands,
} from '@/agent/lib/mac-agent/bus'
import { classifyCommand } from '@/agent/lib/mac-agent/policy'
import { shareScreenshot } from '@/agent/lib/mac-agent/screenshot-share'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = prisma as any

/** Shared preamble: capability on, a Mac paired, that Mac awake. Exported for
 * the L8 UI-driving tools (mac-ui-tools.ts) — same gate, same Bangla answers. */
export async function requireOnlineMac(): Promise<
  { ok: true; deviceId: string; deviceName: string } | { ok: false; error: string }
> {
  if (!(await isMacAgentEnabled())) {
    return {
      ok: false,
      error:
        'Mac control এখন বন্ধ আছে, Boss। চালু করতে হলে /agent/mac পেজ থেকে সুইচটা অন করুন — আপনার অনুমতি ছাড়া এটা চালু হয় না।',
    }
  }
  const device = await activeDevice()
  if (!device) {
    const all = await listDevices()
    if (all.length === 0) {
      return { ok: false, error: 'কোনো Mac এখনো যুক্ত নেই, Boss। যুক্ত করতে বলুন — আমি পেয়ারিং কোড দেবো।' }
    }
    return {
      ok: false,
      error: `আপনার Mac (${all[0].name}) এখন অফলাইন — ঘুমিয়ে আছে বা এজেন্ট বন্ধ। জাগিয়ে আবার বলুন।`,
    }
  }
  return { ok: true, deviceId: device.id, deviceName: device.name }
}

const run_mac_command: AgentTool = {
  name: 'run_mac_command',
  description:
    "Run a terminal command on the OWNER'S OWN Mac (not the VPS, not this server). " +
    'Read-only inspection commands (git status/log/diff, ls, cat, npm test, npx tsc --noEmit, gh pr view) run ' +
    'immediately and return their output. Anything that CHANGES something (install, commit, push, write, delete, ' +
    'run a script) automatically becomes an approval card on his phone with the exact command shown — you do not ' +
    'need to ask him separately first, just call the tool and tell him a card is waiting. ' +
    'Dangerous commands (sudo, rm -rf of home, disk tools, reading key/.env files, curl|sh, shutdown) are REFUSED ' +
    'by policy and cannot be approved — if he insists, tell him he has to run that one himself in his own terminal. ' +
    'Default working directory is his alma-erp checkout. Owner-facing: report results in Bangla, and if a command ' +
    'fails, show him the actual error line rather than guessing. ' +
    'NEVER use this for screenshots (screencapture saves a file nobody can see in chat) — a screen picture is ' +
    'ALWAYS mac_desk_control action="screenshot", which returns an imageUrl that renders inline.',
  input_schema: {
    type: 'object' as const,
    properties: {
      command: { type: 'string', description: 'The exact shell command, e.g. "git status" or "npm test".' },
      cwd: {
        type: 'string',
        description:
          'Working directory. Defaults to ~/alma-erp. Only his allowlisted project folders are permitted.',
      },
      reason: {
        type: 'string',
        description: 'One short Bangla line on WHY this command — shown to him on the approval card.',
      },
      timeoutMs: { type: 'number', description: 'Optional. Default 120000, max 600000.' },
      conversationId: {
        type: 'string',
        description: 'Server-managed conversation id — omit; the server fills it automatically.',
      },
    },
    required: ['command'],
  },
  handler: async (input) => {
    const command = String(input.command ?? '').trim()
    if (!command) return { success: false, error: 'command is required' }
    const cwd = input.cwd ? String(input.cwd) : undefined

    // WRONG-TOOL INTERCEPTOR (owner rule 2026-08-02: the model must not be
    // able to pick the wrong tool — and if it does, the SYSTEM catches it).
    // A shell `screencapture` saves a file nobody can see in chat; the head
    // chose it live on the owner's own checklist run despite the prompt.
    // Instead of refusing (the head would flounder), the misuse is ABSORBED:
    // we run the real screenshot flow and hand back the renderable link, so
    // the owner gets the right result no matter what the model selected.
    if (/(^|[;&|]\s*)screencapture\b/.test(command)) {
      const gateShot = await requireOnlineMac()
      if (!gateShot.ok) return { success: false, error: gateShot.error }
      const { id: shotId } = await enqueueCommand({
        deviceId: gateShot.deviceId,
        action: 'screenshot',
        params: {},
      })
      const shot = await awaitResult(shotId, 60_000)
      if (shot.timedOut || shot.status !== 'done') {
        return { success: false, error: shot.error ?? 'Mac থেকে সময়মতো স্ক্রিনশট আসেনি।' }
      }
      const shared = await shareScreenshot(shot.stdout ?? '', shotId, 'Mac screen')
      if (shared.ok) {
        return {
          success: true,
          data: {
            redirected: 'screenshot',
            imageUrl: shared.imageUrl,
            device: gateShot.deviceName,
            instruction: shared.instruction,
          },
        }
      }
      return {
        success: false,
        error: 'ছবিটা তোলা হয়েছে কিন্তু storage-এ রাখা গেল না, Boss — একটু পরে আবার চেষ্টা করলেই হবে।',
        data: { commandId: shotId, retryable: true },
      }
    }

    const verdict = classifyCommand(command, { cwd })

    // RED — refused before anything else, even before we check whether a Mac is
    // online. There is no path from here to running it.
    if (verdict.level === 'red') {
      return {
        success: false,
        error: `নিরাপত্তার কারণে এই কমান্ডটা চালানো যাবে না, Boss। ${verdict.reasonBn} (কোড: ${verdict.code})`,
        data: { refused: true, policy: verdict.level, code: verdict.code },
      }
    }

    const gate = await requireOnlineMac()
    if (!gate.ok) return { success: false, error: gate.error }

    // AMBER — the owner reads the literal command and taps. The command text goes
    // on the card verbatim; we never paraphrase what he is approving.
    if (verdict.level === 'amber') {
      const reason = String(input.reason ?? '').trim()
      const summary =
        `আপনার Mac-এ এই কমান্ডটা চালাবো?\n\n` +
        `\`${command}\`\n\n` +
        `ফোল্ডার: ${cwd ?? '~/alma-erp'}\n` +
        (reason ? `কারণ: ${reason}\n` : '') +
        `\nApprove করলে তবেই চলবে।`

      const action = await db.agentPendingAction.create({
        data: {
          conversationId: input.conversationId ? String(input.conversationId) : null,
          type: 'mac_command',
          payload: { command, cwd: cwd ?? null, timeoutMs: input.timeoutMs ?? null, deviceId: gate.deviceId },
          summary,
          costEstimate: 0,
          status: 'pending',
        },
      })

      return {
        success: true,
        data: {
          pendingActionId: action.id as string,
          policy: 'amber',
          summary,
          message: `এই কমান্ডটা আপনার অনুমতি ছাড়া চালাবো না — ${gate.deviceName}-এ চালানোর জন্য একটা approval card পাঠিয়েছি, Boss।`,
        },
      }
    }

    // GREEN — run it now.
    const { id } = await enqueueCommand({
      deviceId: gate.deviceId,
      action: 'run_command',
      params: { command, cwd: cwd ?? null, timeoutMs: input.timeoutMs ?? null, approved: false },
      policyLevel: 'green',
    })

    const outcome = await awaitResult(id)
    if (outcome.timedOut) {
      return {
        success: false,
        error: `কমান্ডটা এখনো শেষ হয়নি, Boss। কিছুক্ষণ পরে "mac command status" দিয়ে দেখতে বলুন (id: ${id})।`,
        data: { commandId: id, status: outcome.status },
      }
    }

    return {
      success: outcome.status === 'done',
      data: {
        commandId: id,
        policy: 'green',
        exitCode: outcome.exitCode,
        stdout: outcome.stdout,
        stderr: outcome.stderr,
        error: outcome.error,
        device: gate.deviceName,
      },
    }
  },
}

const check_mac_command: AgentTool = {
  name: 'check_mac_command',
  description:
    'Check a Mac command that was still running, or that the owner just approved on a card. ' +
    'Pass the commandId. Use this after run_mac_command reported a timeout, or after an approval, to fetch the output.',
  input_schema: {
    type: 'object' as const,
    properties: {
      commandId: { type: 'string', description: 'The id returned by run_mac_command or the approval.' },
      waitMs: { type: 'number', description: 'How long to wait for it to finish, ms. Default 20000.' },
    },
    required: ['commandId'],
  },
  handler: async (input) => {
    const commandId = String(input.commandId ?? '').trim()
    if (!commandId) return { success: false, error: 'commandId is required' }

    const waitMs = Number.isFinite(Number(input.waitMs)) ? Number(input.waitMs) : 20_000
    const outcome = waitMs > 0 ? await awaitResult(commandId, waitMs) : await getCommand(commandId)
    if (!outcome) return { success: false, error: 'এই id-র কোনো কমান্ড পাইনি।' }

    return {
      success: outcome.status === 'done',
      data: {
        commandId,
        status: outcome.status,
        exitCode: outcome.exitCode,
        stdout: outcome.stdout,
        stderr: outcome.stderr,
        error: outcome.error,
        stillRunning: outcome.timedOut,
      },
    }
  },
}

const mac_agent_status: AgentTool = {
  name: 'mac_agent_status',
  description:
    "Report whether the owner's Mac is connected and what has recently been run on it. " +
    'Use when he asks "Mac connected ache?", "ki ki command chalaili?", or before a long piece of Mac work. ' +
    'Set action="pair_code" to generate a fresh one-time pairing code when he wants to connect a Mac — give him ' +
    'the code AND tell him to run the install script from the alma-erp/mac-agent folder.',
  input_schema: {
    type: 'object' as const,
    properties: {
      action: { type: 'string', enum: ['status', 'pair_code'], description: 'Defaults to status.' },
      deviceName: { type: 'string', description: 'Optional friendly name when generating a pairing code.' },
    },
    required: [],
  },
  handler: async (input) => {
    const action = String(input.action ?? 'status')
    const enabled = await isMacAgentEnabled()

    if (action === 'pair_code') {
      if (!enabled) {
        return {
          success: false,
          error: 'আগে /agent/mac পেজ থেকে Mac control সুইচটা অন করতে হবে, Boss — তারপর কোড দিচ্ছি।',
        }
      }
      try {
        const ticket = await createPairingTicket(input.deviceName ? String(input.deviceName) : undefined)
        return {
          success: true,
          data: {
            code: ticket.code,
            expiresAt: ticket.expiresAt,
            message:
              `পেয়ারিং কোড: **${ticket.code}** (১০ মিনিট চলবে)\n\n` +
              'Mac-এ Terminal খুলে একবার চালান:\n' +
              '```bash\n' +
              `cd ~/alma-erp/mac-agent && bash install.sh ${ticket.code}\n` +
              '```',
          },
        }
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : 'pair_failed' }
      }
    }

    const [devices, history] = await Promise.all([listDevices(), recentCommands(10)])
    return {
      success: true,
      data: {
        enabled,
        devices: devices.map((d) => ({ name: d.name, online: d.online, lastSeenAt: d.lastSeenAt })),
        recent: history.map((h) => ({
          command: h.command,
          policy: h.policyLevel,
          status: h.status,
          exitCode: h.exitCode,
          at: h.createdAt,
        })),
      },
    }
  },
}

const mac_desk_control: AgentTool = {
  name: 'mac_desk_control',
  description:
    "Desk-level control of the owner's Mac: take a screenshot of his screen (THE one way to show his screen — " +
    'returns an imageUrl that renders inline in chat; never run screencapture via run_mac_command), or stop the Mac from going to sleep ' +
    'while a long job runs (and let it sleep again afterwards). ' +
    'A sleeping Mac stops answering entirely, so use keep_awake before starting long work he is waiting on, and ' +
    'allow_sleep when it is done — leaving it awake all night drains his battery. ' +
    'A screenshot needs Screen Recording permission for the agent; if it fails with that, tell him to grant it in ' +
    'System Settings → Privacy & Security → Screen Recording.',
  input_schema: {
    type: 'object' as const,
    properties: {
      action: {
        type: 'string',
        enum: ['screenshot', 'keep_awake', 'allow_sleep', 'power_status'],
        description: 'What to do.',
      },
    },
    required: ['action'],
  },
  handler: async (input) => {
    const gate = await requireOnlineMac()
    if (!gate.ok) return { success: false, error: gate.error }

    const action = String(input.action)
    const isShot = action === 'screenshot'
    const { id } = await enqueueCommand({
      deviceId: gate.deviceId,
      action: isShot ? 'screenshot' : 'power',
      params: isShot
        ? {}
        : { mode: action === 'power_status' ? 'status' : action },
    })

    const outcome = await awaitResult(id, 60_000)
    if (outcome.timedOut) return { success: false, error: 'Mac থেকে সময়মতো উত্তর আসেনি।' }
    if (outcome.status !== 'done') return { success: false, error: outcome.error ?? 'failed' }

    if (isShot) {
      // Same share story as look_mac_app: short /files link, never the base64
      // body (the owner's checklist run hit the old raw shape live — the head
      // pasted an unrenderable wall of text).
      const shared = await shareScreenshot(outcome.stdout ?? '', id, 'Mac screen')
      if (shared.ok) {
        return {
          success: true,
          data: {
            imageUrl: shared.imageUrl,
            device: gate.deviceName,
            instruction: shared.instruction,
          },
        }
      }
      if (shared.retryable) {
        return {
          success: false,
          error: 'ছবিটা তোলা হয়েছে কিন্তু storage-এ রাখা গেল না, Boss — একটু পরে আবার চেষ্টা করলেই হবে।',
          data: { commandId: id, retryable: true },
        }
      }
      return {
        success: true,
        data: { screenshot: shared.boundedText, device: gate.deviceName },
      }
    }
    try {
      return { success: true, data: { ...JSON.parse(outcome.stdout), device: gate.deviceName } }
    } catch {
      return { success: true, data: { raw: outcome.stdout } }
    }
  },
}

export const MAC_TOOLS: AgentTool[] = [run_mac_command, check_mac_command, mac_agent_status, mac_desk_control]
