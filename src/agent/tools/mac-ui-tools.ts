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
import { shareScreenshot } from '@/agent/lib/mac-agent/screenshot-share'
import { requireOnlineMac } from './mac-tools'
import { normalizeExpectSession } from '@/agent/lib/mac-agent/expect-session'

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
  replace?: boolean
}): string {
  const app = appLabel(input.bundleId)
  switch (input.action) {
    case 'ui_click':
      return `${app} অ্যাপে "${input.elementLabel}" বোতামে ক্লিক`
    case 'ui_type':
      return input.replace
        ? `${app} অ্যাপে "${input.elementLabel}" ঘরের আগের লেখা মুছে নতুন লেখা`
        : `${app} অ্যাপে "${input.elementLabel}" ঘরে লেখা`
    case 'ui_new_chat':
      return `${app} অ্যাপে নতুন চ্যাট খোলা`
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
    // `mirror` is the one read whose daemon verb is not ui_-prefixed.
    const action = short === 'mirror' ? 'app_mirror' : short.startsWith('ui_') ? short : `ui_${short}`
    if (!allowed.has(action)) {
      return { success: false, error: `এই টুল দিয়ে ${short} হয় না।`, data: { refused: true, code: 'wrong_tool' } }
    }
    const appRaw = String(input.app ?? '').trim()
    if (!appRaw) return { success: false, error: 'app is required' }
    const bundleId = resolveBundleId(appRaw)

    // See expect-session.ts: the head hands back the DAEMON's session object,
    // whose field names differ from the expectation's. Normalised in one place
    // because dropping a field here fails invisibly — the guard still runs and
    // still says "match".
    const expectSession = normalizeExpectSession(input.expectSession)

    // P0-3 (review bot #690): `new_chat` advertises itself as label-free — the
    // point is that the head does NOT have to discover the button. But the
    // policy judges it exactly like a click, and a click with no label fails
    // CLOSED, so a schema-following call could never even reach a card. The
    // server names the button instead: the card still shows Boss a real label,
    // and the daemon keeps its own candidate list for the apps that renamed it.
    const DEFAULT_NEW_CHAT_LABEL = 'New chat'
    const elementLabel = input.elementLabel
      ? String(input.elementLabel)
      : action === 'ui_new_chat'
        ? DEFAULT_NEW_CHAT_LABEL
        : undefined
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

    // Per-device capability gating: daemons report what they can do at poll
    // time (X-Agent-Capabilities → device.meta.capabilities), so with several
    // Macs online we pick the ONE that carries the ui-driver instead of
    // refusing. Ambiguity (several capable) or a fleet of unreported legacy
    // daemons still refuses honestly — never guess which Mac to drive.
    const online = (await listDevices()).filter((d) => d.online && d.pairedAt)
    // A report older than a day is EXPIRED: a device rolled back to a
    // pre-capability daemon keeps polling (lastSeenAt fresh) but never
    // refreshes its report, and the current daemon re-reports every 6h —
    // so a stale ui_driving claim cannot select the wrong Mac for long.
    const capsOf = (d: (typeof online)[number]) => {
      const meta = d.meta as Record<string, unknown> | null
      if (!Array.isArray(meta?.capabilities)) return null
      const at = Date.parse(String(meta.capabilitiesAt ?? ''))
      if (!Number.isFinite(at) || Date.now() - at > 24 * 3600 * 1000) return null
      return (meta.capabilities as unknown[]).map(String)
    }
    const capable = online.filter((d) => capsOf(d)?.includes('ui_driving'))
    let targetDeviceId = gate.deviceId
    let targetDeviceName = gate.deviceName
    if (capable.length === 1) {
      // Name follows the id — telling the owner one Mac while queueing on
      // another would make the approval card lie (Codex P2).
      targetDeviceId = capable[0].id
      targetDeviceName = capable[0].name
    } else if (online.length > 1) {
      return {
        success: false,
        error:
          capable.length > 1
            ? 'একাধিক Mac-এই অ্যাপ চালানোর ব্যবস্থা চালু — কোনটায় করবো অনুমান করবো না, Boss। একটা Mac রেখে (বা অন্যটা ঘুম পাড়িয়ে) আবার বলুন।'
            : 'একাধিক Mac এখন অনলাইনে — কোনটার অ্যাপ চালাবো অনুমান করে করবো না, Boss। একটা Mac রেখে (বা অন্যটা ঘুম পাড়িয়ে) আবার বলুন।',
        data: { refused: true, code: 'multiple_macs_online', online: online.map((d) => d.name) },
      }
    }

    const params = {
      bundleId,
      // The label rides through to the card and to the approval re-validation,
      // because a click policy without a label fails CLOSED — dropping it here
      // rejected every label-free new-chat card AFTER Boss approved it (review
      // bot, #692). It does not freeze the daemon's candidate list: `ui_new_chat`
      // treats a given label as the FIRST candidate and still falls through to
      // the app's own alternatives.
      elementLabel: elementLabel ?? null,
      text: text ?? null,
      key: key ?? null,
      focusedLabel: focusedLabel ?? null,
      // Owner-approved overwrite: the card says the old text goes; the daemon
      // clears (and verifies the clear) before typing.
      replace: input.replace === true ? true : null,
      scrollAmount: Number.isFinite(Number(input.scrollAmount)) ? Number(input.scrollAmount) : null,
      // Interactive-only by default: a full ChatGPT conversation tree blows
      // the text cap and the composer at the BOTTOM is exactly what got cut,
      // so the model looped on truncated trees without ever seeing the one
      // element it needed (live-demo finding). fullTree=true opts back in.
      interactive: action === 'ui_tree' ? input.fullTree !== true : undefined,
      // P1-10 mirror controls: start | stop | stop_all, and how long to watch.
      mode: action === 'app_mirror' ? String(input.mode ?? 'start') : null,
      maxSeconds: Number.isFinite(Number(input.maxSeconds)) ? Number(input.maxSeconds) : null,
      // P0-3: WHICH chat this act belongs to. The daemon reads the live session
      // right before acting and refuses on a mismatch, so a chat the owner
      // switched away from cannot be written into — the exact failure he
      // reported. Absent ⇒ no expectation stated ⇒ nothing to violate.
      expect: expectSession,
    }

    // AMBER — the owner reads the app, the element and the LITERAL text before
    // anything happens. Never paraphrase what he is approving.
    if (verdict.level === 'amber') {
      const reason = String(input.reason ?? '').trim()
      const what = describeActionBn({ action, bundleId, elementLabel, text, key, focusedLabel, replace: input.replace === true })
      const summary =
        `${what} — অনুমতি দেবেন?\n\n` +
        (text !== undefined ? `লেখাটা হুবহু এই:\n\`\`\`\n${text}\n\`\`\`\n` : '') +
        (input.replace === true ? `⚠️ ঘরে আগের যা লেখা আছে সেটা মুছে যাবে।\n` : '') +
        (reason ? `কারণ: ${reason}\n` : '') +
        `\nApprove করলে তবেই হবে।`

      const card = await db.agentPendingAction.create({
        data: {
          conversationId: input.conversationId ? String(input.conversationId) : null,
          type: 'mac_ui_action',
          payload: { uiAction: action, ...params, deviceId: targetDeviceId },
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
          message: `এটা আপনার অনুমতি ছাড়া করবো না — ${targetDeviceName}-এ করার জন্য একটা approval card পাঠিয়েছি, Boss।`,
        },
      }
    }

    // GREEN — a read. Run it now.
    const { id } = await enqueueCommand({
      deviceId: targetDeviceId,
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
      // One share story for every Mac screenshot (shared with
      // mac_desk_control): short /files link, never the base64 body.
      const shared = await shareScreenshot(outcome.stdout ?? '', id, appLabel(bundleId))
      if (shared.ok) {
        // P1-8: the link is for Boss. Read the capture too, so the HEAD has
        // seen the screen it is about to talk about — the audit caught it
        // narrating a save that never happened, from a URL it could not read.
        const { describeScreenshot, SCREENSHOT_UNREAD_NOTE } = await import('@/agent/lib/mac-agent/screenshot-vision')
        const seen = await describeScreenshot(outcome.stdout ?? '')
        return {
          success: true,
          data: {
            imageUrl: shared.imageUrl,
            device: targetDeviceName,
            app: appLabel(bundleId),
            instruction: shared.instruction,
            // Named `screenContents` and not `description` on purpose: this is
            // what the agent SAW, and it is a vision model's reading — not the
            // head's own eyes. When it is missing, the head is told so plainly
            // instead of being left to fill the gap.
            screenContents: seen ?? undefined,
            visionNote: seen ? undefined : SCREENSHOT_UNREAD_NOTE,
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
      // No data URI at all (unexpected daemon payload) — bounded passthrough.
      return {
        success: true,
        data: { screenshot: capTree(shared.boundedText), device: targetDeviceName, app: appLabel(bundleId) },
      }
    }
    return {
      success: true,
      data: {
        commandId: id,
        device: targetDeviceName,
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
      action: {
        type: 'string',
        enum: ['tree', 'screenshot', 'scroll', 'session', 'mirror'],
        description:
          'How to look. "session" answers WHICH conversation the window is showing (title, first message, whether the composer is empty) — read it BEFORE acting and pass it back as expectSession so you cannot write into the wrong chat. ' +
          '"mirror" streams that app\'s chat into Boss\'s live dock as text so he can WATCH it from his phone (mode="start" to begin, "stop" to end); only the Claude app publishes readable messages today, ChatGPT refuses honestly.',
      },
      app: APP_PARAM,
      scrollAmount: { type: 'number', description: 'For scroll: positive scrolls down, negative up. Default 3.' },
      mode: { type: 'string', description: 'For mirror: "start" (default), "stop", or "stop_all".' },
      maxSeconds: { type: 'number', description: 'For mirror: how long to watch, 30–600s.' },
      fullTree: {
        type: 'boolean',
        description:
          'For tree: true returns the FULL tree with conversation text (big, may truncate). Default is the compact actionable-elements view.',
      },
    },
    required: ['action', 'app'],
  },
  handler: (input) => handleUiAction(input, new Set(['ui_tree', 'ui_screenshot', 'ui_scroll', 'ui_session', 'app_mirror'])),
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
      action: {
        type: 'string',
        enum: ['click', 'type', 'key', 'new_chat'],
        description:
          'What to do in the app. Use "new_chat" — NOT a click you found yourself — whenever he wants a FRESH conversation: it presses the app\'s own new-chat button and then PROVES a new empty chat is open, and it returns that new session so you can pass it as expectSession on the type that follows.',
      },
      app: APP_PARAM,
      elementLabel: {
        type: 'string',
        description:
          'For click/type: the label of the target element EXACTLY as the tree reported it. Required — actions without a named element are refused.',
      },
      text: { type: 'string', description: 'For type: the literal text to type, verbatim.' },
      replace: {
        type: 'boolean',
        description:
          'For type: true ERASES what is already in the field before typing (the card warns the owner). Use ONLY after a field_not_empty refusal, and tell the owner his old draft will go.',
      },
      key: { type: 'string', description: 'For key: the combo, e.g. "enter" or "cmd+a".' },
      focusedLabel: {
        type: 'string',
        description: 'For key with Enter/Space: the label of the element that currently has focus, from the tree.',
      },
      reason: {
        type: 'string',
        description: 'One short Bangla line on WHY — shown to him on the approval card.',
      },
      expectSession: {
        type: 'object',
        description:
          'The chat this act belongs to, from look_mac_app action="session" (or the session new_chat returned). The Mac re-reads the live chat immediately before acting and REFUSES on a mismatch, so pass it whenever the owner named a specific chat or you just opened one.',
        properties: {
          sessionTitle: { type: 'string', description: 'The window/conversation title it must still be.' },
          sessionFirstText: { type: 'string', description: 'The first message text it must still start with.' },
          emptySession: { type: 'boolean', description: 'True when it must still be an empty, brand-new chat.' },
        },
      },
      conversationId: {
        type: 'string',
        description: 'Server-managed conversation id — omit; the server fills it automatically.',
      },
    },
    required: ['action', 'app'],
  },
  handler: (input) => handleUiAction(input, new Set(['ui_click', 'ui_type', 'ui_key', 'ui_new_chat'])),
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
