/**
 * L8 (W4) — the agent's hands INSIDE the owner's Mac apps.
 *
 * One tool (`drive_mac_app`) drives the two allowlisted desktop apps (Claude,
 * ChatGPT) through the daemon's ui_* verbs, and the UI classifier decides what
 * happens to each request, not the model:
 *   RED   → refused here, with the Bangla reason. No card, no retry path.
 *   AMBER → an approval card naming the APP, the ELEMENT and the LITERAL text
 *           or key; nothing happens until the owner taps ✅ (the approve route
 *           then enqueues it).
 *   GREEN → reads (tree / screenshot / scroll) run immediately.
 *
 * Three layers see every action: this tool (classify before enqueue), the bus
 * (backstop — red never enqueues, amber never without a card), and the daemon
 * (re-judges with the REAL owner-idle measurement before synthesising events).
 * The model never sees a "force" flag on any of them.
 */
import type { AgentTool } from './registry'
import { prisma } from '@/lib/prisma'
import { awaitResult, enqueueCommand, isMacUiDrivingEnabled, UI_SERVER_IDLE_SENTINEL } from '@/agent/lib/mac-agent/bus'
import { ALLOWED_APPS, appLabel, capTree, classifyUiAction } from '@/agent/lib/mac-agent/ui-policy'
import { requireOnlineMac } from './mac-tools'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = prisma as any

/**
 * The head speaks in app names, the policy in bundle ids. Only the two
 * allowlisted apps get a friendly alias — an unknown name passes through
 * verbatim and the classifier refuses it with `app_not_allowlisted`.
 */
const APP_ALIASES: Readonly<Record<string, string>> = {
  claude: 'com.anthropic.claudefordesktop',
  // The SHIPPING ChatGPT desktop app identifies as com.openai.codex (verified
  // from its Info.plist on the owner's Mac, W2 PR #681). `com.openai.chat`
  // stays allowlisted in the policy and passes through as a raw id.
  chatgpt: 'com.openai.codex',
}

function resolveBundleId(raw: string): string {
  const key = raw.trim().toLowerCase()
  return APP_ALIASES[key] ?? key
}

/** Owner-readable one-liner of what an action DOES, for cards and errors. */
function describeActionBn(input: {
  action: string
  bundleId: string
  elementLabel?: string
  text?: string
  key?: string
  focusedLabel?: string
}): string {
  const app = appLabel(input.bundleId)
  switch (input.action) {
    case 'ui_click':
      return `${app} অ্যাপে "${input.elementLabel}" বোতামে ক্লিক`
    case 'ui_type':
      return `${app} অ্যাপে "${input.elementLabel}" ঘরে লেখা`
    case 'ui_key':
      return input.focusedLabel
        ? `${app} অ্যাপে "${input.focusedLabel}"-এ ${input.key} চাপা`
        : `${app} অ্যাপে ${input.key} চাপা`
    default:
      return `${app} অ্যাপে ${input.action}`
  }
}

const drive_mac_app: AgentTool = {
  name: 'drive_mac_app',
  description:
    "Drive the OWNER'S OWN Mac desktop apps like a person — ONLY the Claude app and the ChatGPT app, nothing else. " +
    'Actions: "tree" reads the window\'s accessibility tree (do this FIRST — it gives you the real element labels), ' +
    '"screenshot" captures the app window, "scroll" scrolls it — these are read-only and run immediately. ' +
    '"click" (needs elementLabel from the tree), "type" (needs elementLabel + the literal text), and "key" ' +
    '(a combo like "enter"; Enter/Space also need focusedLabel — the label of the element that has focus, from the tree) ' +
    'CHANGE things, so they automatically become an approval card on his phone showing the app, the element and the ' +
    'exact text — call the tool directly and tell him a card is waiting, do not ask separately first. ' +
    'Refused by policy, not approvable: any other app, destructive/payment/permission buttons, typing secrets, ' +
    'typing while he is at the keyboard (comes back as owner_active — wait and retry). ' +
    'After an approval, fetch the outcome with check_mac_command using the returned id. ' +
    'Workflow for "ChatGPT-e eta jigges koro": tree → type into the composer → key enter → tree again to read the reply. ' +
    'Owner-facing: report in Bangla what you saw and did.',
  input_schema: {
    type: 'object' as const,
    properties: {
      action: {
        type: 'string',
        enum: ['tree', 'screenshot', 'scroll', 'click', 'type', 'key'],
        description: 'What to do in the app.',
      },
      app: {
        type: 'string',
        description: 'Which app: "claude" or "chatgpt" (or an exact bundle id). Required.',
      },
      elementLabel: {
        type: 'string',
        description:
          'For click/type: the label of the target element EXACTLY as the tree reported it. Required — actions without a named element are refused.',
      },
      text: { type: 'string', description: 'For type: the literal text to type, verbatim.' },
      key: { type: 'string', description: 'For key: the combo, e.g. "enter" or "cmd+a".' },
      focusedLabel: {
        type: 'string',
        description: 'For key with Enter/Space: the label of the element that currently has focus, from the tree.',
      },
      scrollAmount: {
        type: 'number',
        description: 'For scroll: positive scrolls down, negative up. Default 3.',
      },
      reason: {
        type: 'string',
        description: 'One short Bangla line on WHY — shown to him on the approval card.',
      },
      conversationId: {
        type: 'string',
        description: 'Server-managed conversation id — omit; the server fills it automatically.',
      },
    },
    required: ['action', 'app'],
  },
  handler: async (input) => {
    const short = String(input.action ?? '').trim()
    const action = short.startsWith('ui_') ? short : `ui_${short}`
    const appRaw = String(input.app ?? '').trim()
    if (!appRaw) return { success: false, error: 'app is required' }
    const bundleId = resolveBundleId(appRaw)

    const elementLabel = input.elementLabel ? String(input.elementLabel) : undefined
    const text = input.text !== undefined ? String(input.text) : undefined
    const key = input.key ? String(input.key) : undefined
    const focusedLabel = input.focusedLabel ? String(input.focusedLabel) : undefined

    // The server judges the permanent questions (app / element / text). Owner
    // idle time only the daemon can measure, so it is sentinel-satisfied here
    // and re-judged for real on the Mac before anything is synthesised.
    const verdict = classifyUiAction({
      action,
      bundleId,
      elementLabel,
      text,
      key,
      focusedLabel,
      ownerIdleSeconds: UI_SERVER_IDLE_SENTINEL,
    })

    // RED — refused before anything else. There is no path from here to running it.
    if (verdict.level === 'red') {
      return {
        success: false,
        error: `নিরাপত্তার কারণে এটা করা যাবে না, Boss। ${verdict.reasonBn} (কোড: ${verdict.code})`,
        data: { refused: true, policy: verdict.level, code: verdict.code },
      }
    }

    // The shipped daemon answers ui_* with unknown_action until W3's driver is
    // deployed — gate the whole capability until the owner flips the KV switch,
    // so no read fails confusingly and no approved card burns on nothing.
    if (!(await isMacUiDrivingEnabled())) {
      return {
        success: false,
        error:
          'Mac-এর অ্যাপ চালানোর ফিচারটা এখনো চালু হয়নি, Boss — আপনার Mac-এর এজেন্টে UI-driver আপডেটটা বসার পর এটা অন করা হবে। ততক্ষণ টার্মিনাল কমান্ড আর Claude/Codex সেশন আগের মতোই চলবে।',
        data: { refused: true, code: 'ui_driving_disabled' },
      }
    }

    const gate = await requireOnlineMac()
    if (!gate.ok) return { success: false, error: gate.error }

    const params = {
      bundleId,
      elementLabel: elementLabel ?? null,
      text: text ?? null,
      key: key ?? null,
      focusedLabel: focusedLabel ?? null,
      scrollAmount: Number.isFinite(Number(input.scrollAmount)) ? Number(input.scrollAmount) : null,
    }

    // AMBER — the owner reads the app, the element and the LITERAL text before
    // anything happens. Never paraphrase what he is approving.
    if (verdict.level === 'amber') {
      const reason = String(input.reason ?? '').trim()
      const what = describeActionBn({ action, bundleId, elementLabel, text, key, focusedLabel })
      const summary =
        `${what} — অনুমতি দেবেন?\n\n` +
        (text !== undefined ? `লেখাটা হুবহু এই:\n\`\`\`\n${text}\n\`\`\`\n` : '') +
        (reason ? `কারণ: ${reason}\n` : '') +
        `\nApprove করলে তবেই হবে।`

      const card = await db.agentPendingAction.create({
        data: {
          conversationId: input.conversationId ? String(input.conversationId) : null,
          type: 'mac_ui_action',
          payload: { uiAction: action, ...params, deviceId: gate.deviceId },
          summary,
          costEstimate: 0,
          status: 'pending',
        },
      })

      return {
        success: true,
        data: {
          pendingActionId: card.id as string,
          policy: 'amber',
          summary,
          message: `এটা আপনার অনুমতি ছাড়া করবো না — ${gate.deviceName}-এ করার জন্য একটা approval card পাঠিয়েছি, Boss।`,
        },
      }
    }

    // GREEN — a read. Run it now.
    const { id } = await enqueueCommand({
      deviceId: gate.deviceId,
      action: action as Parameters<typeof enqueueCommand>[0]['action'],
      params,
      policyLevel: 'green',
    })

    const outcome = await awaitResult(id, 60_000)
    if (outcome.timedOut) {
      return {
        success: false,
        error: `Mac থেকে সময়মতো উত্তর আসেনি, Boss (id: ${id})। check_mac_command দিয়ে পরে দেখা যাবে।`,
        data: { commandId: id, status: outcome.status },
      }
    }
    if (outcome.status !== 'done') {
      // The daemon's re-judge can defer a read too (e.g. kill-switch mid-flight).
      return {
        success: false,
        error: outcome.error ?? 'failed',
        data: { commandId: id, status: outcome.status, stderr: outcome.stderr },
      }
    }

    if (action === 'ui_screenshot') {
      return {
        success: true,
        data: { screenshot: outcome.stdout, device: gate.deviceName, app: appLabel(bundleId) },
      }
    }
    return {
      success: true,
      data: {
        commandId: id,
        device: gate.deviceName,
        app: appLabel(bundleId),
        output: capTree(outcome.stdout ?? ''),
      },
    }
  },
}

const list_mac_apps: AgentTool = {
  name: 'list_mac_apps',
  description:
    'List which Mac desktop apps the agent is allowed to drive with drive_mac_app, with their bundle ids. ' +
    'The allowlist is fixed in code (Claude and ChatGPT only) — widening it needs a code change, so if the owner ' +
    'asks for another app, say honestly that it needs a deploy, not a setting.',
  input_schema: { type: 'object' as const, properties: {}, required: [] },
  handler: async () => {
    return {
      success: true,
      data: {
        apps: Object.entries(ALLOWED_APPS).map(([bundleId, name]) => ({ name, bundleId })),
      },
    }
  },
}

export const MAC_UI_TOOLS: AgentTool[] = [drive_mac_app, list_mac_apps]
