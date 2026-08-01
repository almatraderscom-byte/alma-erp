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
import {
  awaitResult,
  enqueueCommand,
  isMacUiDrivingEnabled,
  listDevices,
  UI_SERVER_IDLE_SENTINEL,
} from '@/agent/lib/mac-agent/bus'
import { ALLOWED_APPS, appLabel, capTree, classifyUiAction } from '@/agent/lib/mac-agent/ui-policy'
import {
  agentStorageDelete,
  agentStorageListFolder,
  agentStorageUpload,
} from '@/agent/lib/storage'
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

/**
 * Shared engine for both tools. The tool split exists for the OWNER-TURN gate:
 * `look_mac_app` is classified `read` so "শুধু দেখো, কিছু কোরো না" turns keep
 * their eyes, while `drive_mac_app` is `stage` and is stripped there — the one
 * phrasing that must always work is the safest one. `allowed` is defence in
 * depth on top of each schema's enum.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function handleUiAction(input: Record<string, any>, allowed: ReadonlySet<string>) {
  {
    const short = String(input.action ?? '').trim()
    const action = short.startsWith('ui_') ? short : `ui_${short}`
    if (!allowed.has(action)) {
      return { success: false, error: `এই টুল দিয়ে ${short} হয় না।`, data: { refused: true, code: 'wrong_tool' } }
    }
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

    // With several Macs online, "most recently seen" is a guess — and only some
    // may carry the W3 ui-driver. An honest refusal beats a silent wrong-Mac
    // action (head ruling on the W4 PR); per-device capability gating replaces
    // this once the daemon reports capabilities at poll time.
    const online = (await listDevices()).filter((d) => d.online && d.pairedAt)
    if (online.length > 1) {
      return {
        success: false,
        error:
          'একাধিক Mac এখন অনলাইনে — কোনটার অ্যাপ চালাবো অনুমান করে করবো না, Boss। একটা Mac রেখে (বা অন্যটা ঘুম পাড়িয়ে) আবার বলুন।',
        data: { refused: true, code: 'multiple_macs_online', online: online.map((d) => d.name) },
      }
    }

    const params = {
      bundleId,
      elementLabel: elementLabel ?? null,
      text: text ?? null,
      key: key ?? null,
      focusedLabel: focusedLabel ?? null,
      scrollAmount: Number.isFinite(Number(input.scrollAmount)) ? Number(input.scrollAmount) : null,
      // Interactive-only by default: a full ChatGPT conversation tree blows
      // the text cap and the composer at the BOTTOM is exactly what got cut,
      // so the model looped on truncated trees without ever seeing the one
      // element it needed (live-demo finding). fullTree=true opts back in.
      interactive: action === 'ui_tree' ? input.fullTree !== true : undefined,
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
      // Never hand the head a base64 body: it pastes the megabyte into its
      // reply as "markdown", the chat renders raw base64, and the tokens are
      // billed. Upload once and return a short-lived URL with the exact
      // camera-snapshot instruction the head already knows how to follow.
      const uri = String(outcome.stdout ?? '')
      const m = uri.match(/^data:image\/(jpeg|png);base64,([A-Za-z0-9+/=]+)$/)
      if (m) {
        try {
          const ext = m[1] === 'png' ? 'png' : 'jpg'
          // Timestamp in the name is the retention key: the signed URL dies in
          // an hour, and the object follows within a day via the opportunistic
          // sweep below — there is no cron for this bucket on purpose.
          const objectPath = `mac-ui/shot-${Date.now()}-${id}.${ext}`
          await agentStorageUpload(objectPath, Buffer.from(m[2], 'base64'), `image/${m[1]}`)
          // SHORT owner-authed link, not the 300-char signed JWT: the head
          // wraps long URLs (proven live — the markdown image broke on a
          // newline between ] and ( ), and /api/assistant/files exists for
          // exactly this. The route 302s to a fresh signed URL per view.
          // Absolute, because the same reply may land in Telegram where a
          // root-relative path has no origin to resolve against (Codex P2).
          const base = (
            process.env.APP_URL ||
            process.env.NEXTAUTH_URL ||
            process.env.NEXT_PUBLIC_APP_URL ||
            'https://alma-erp-six.vercel.app'
          ).replace(/\/$/, '')
          const imageUrl = `${base}/api/assistant/files?path=${encodeURIComponent(objectPath)}&redirect=1`
          try {
            const dayAgo = Date.now() - 24 * 3600 * 1000
            const stale = (await agentStorageListFolder('mac-ui/')).filter((f) => {
              const ts = Number(/^shot-(\d+)-/.exec(f.name)?.[1])
              return Number.isFinite(ts) && ts < dayAgo
            })
            if (stale.length) await agentStorageDelete(stale.map((f) => `mac-ui/${f.name}`))
          } catch {
            /* retention is best-effort; next capture retries */
          }
          return {
            success: true,
            data: {
              imageUrl,
              device: gate.deviceName,
              app: appLabel(bundleId),
              instruction:
                'ছবিটা ওনারকে দেখাতে markdown image হিসেবে দাও, এক লাইনে: ![' + appLabel(bundleId) + '](imageUrl)। ' +
                'imageUrl হুবহু কপি করো — ছোট লিংক, ভাঙার কিছু নেই। base64 বা লম্বা টেক্সট কখনো লিখবে না।',
            },
          }
        } catch {
          // A raw fallback would hand the head the megabyte base64 this whole
          // branch exists to avoid — fail retryably instead (Codex P2).
          return {
            success: false,
            error: 'ছবিটা তোলা হয়েছে কিন্তু storage-এ রাখা গেল না, Boss — একটু পরে আবার চেষ্টা করলেই হবে।',
            data: { commandId: id, retryable: true },
          }
        }
      }
      // No data URI at all (unexpected daemon payload) — pass the bounded text.
      return {
        success: true,
        data: { screenshot: capTree(uri), device: gate.deviceName, app: appLabel(bundleId) },
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
  }
}

/** Shared schema fragments. */
const APP_PARAM = {
  type: 'string',
  description: 'Which app: "claude" or "chatgpt" (or an exact bundle id). Required.',
} as const

const look_mac_app: AgentTool = {
  name: 'look_mac_app',
  description:
    "LOOK inside the OWNER'S OWN Mac desktop apps — ONLY the Claude app and the ChatGPT app. Read-only, runs " +
    'immediately, changes nothing: "tree" lists the window\'s actionable elements (buttons, text boxes — the exact ' +
    'labels drive_mac_app needs; pass fullTree=true only when you must READ the conversation text), ' +
    '"screenshot" captures the app window, "scroll" scrolls to see more. ' +
    'Use this whenever he asks WHAT an app shows ("ChatGPT app-e ki ache dekho") — and ALWAYS before drive_mac_app, ' +
    'because clicking/typing needs the exact element labels this returns. ' +
    'Owner-facing: report in Bangla what you saw.',
  input_schema: {
    type: 'object' as const,
    properties: {
      action: { type: 'string', enum: ['tree', 'screenshot', 'scroll'], description: 'How to look.' },
      app: APP_PARAM,
      scrollAmount: { type: 'number', description: 'For scroll: positive scrolls down, negative up. Default 3.' },
      fullTree: {
        type: 'boolean',
        description:
          'For tree: true returns the FULL tree with conversation text (big, may truncate). Default is the compact actionable-elements view.',
      },
    },
    required: ['action', 'app'],
  },
  handler: (input) => handleUiAction(input, new Set(['ui_tree', 'ui_screenshot', 'ui_scroll'])),
}

const drive_mac_app: AgentTool = {
  name: 'drive_mac_app',
  description:
    "ACT inside the OWNER'S OWN Mac desktop apps — ONLY the Claude app and the ChatGPT app, nothing else. " +
    'FIRST look with look_mac_app (action="tree") — it gives the real element labels this tool requires. ' +
    'Actions: "click" (needs elementLabel from the tree), "type" (needs elementLabel + the literal text), "key" ' +
    '(a combo like "enter"; Enter/Space also need focusedLabel — the label of the element that has focus, from the tree). ' +
    'Every action automatically becomes an approval card on his phone showing the app, the element and the exact ' +
    'text — call the tool directly and tell him a card is waiting, do not ask separately first. ' +
    'Refused by policy, not approvable: any other app, destructive/payment/permission buttons, typing secrets, ' +
    'typing while he is at the keyboard (comes back as owner_active — wait and retry). ' +
    'After an approval, fetch the outcome with check_mac_command using the returned id. ' +
    'Workflow for "ChatGPT-e eta jigges koro": look tree → type into the composer → key enter → look tree with fullTree=true to read the reply text. ' +
    'Owner-facing: report in Bangla what you did.',
  input_schema: {
    type: 'object' as const,
    properties: {
      action: { type: 'string', enum: ['click', 'type', 'key'], description: 'What to do in the app.' },
      app: APP_PARAM,
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
  handler: (input) => handleUiAction(input, new Set(['ui_click', 'ui_type', 'ui_key'])),
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

export const MAC_UI_TOOLS: AgentTool[] = [look_mac_app, drive_mac_app, list_mac_apps]
