/**
 * Phase E — owner-facing tools for the LIVE browser companion (the agent driving the
 * owner's OWN Chrome, in his real logged-in session, while he watches).
 *
 *   • set_live_browser     — KV kill-switch ON/OFF (default OFF, no redeploy).
 *   • live_browser_pair    — mint a one-time code for the owner to paste into the
 *                            extension (pairing is his physical step; no password).
 *   • live_browser_status  — which of his Chromes are paired + online right now.
 *   • live_browser_look    — open/scroll/read the active tab and bring back what's on
 *                            screen (text, clickable elements, a screenshot link).
 *   • live_browser_act     — click / type / scroll in the active tab.
 *
 * Safety: this never handles credentials (the owner stays logged in himself), and the
 * agent must NEVER auto-press a final Send / Pay / Confirm / Submit-money / Delete —
 * it reads, fills and navigates, then hands the last irreversible click to the owner.
 * The companion also has its own verb whitelist + local pause switch.
 */
import type { AgentTool } from './registry'
import { agentStorageUpload, agentStorageSignedUrl } from '@/agent/lib/storage'
import {
  isLiveBrowserEnabled,
  setLiveBrowserEnabled,
  createPairingTicket,
  listOwnerDevices,
  pickActiveDevice,
  runCommand,
  type LiveBrowserAction,
} from '@/agent/lib/live-browser/companion'

/** Split a companion screenshot dataURL into raw base64 + media type for a vision block. */
function splitDataUrl(
  dataUrl: string | null | undefined,
): { data: string; mediaType: 'image/jpeg' | 'image/png' } | null {
  if (!dataUrl || !dataUrl.startsWith('data:image')) return null
  const comma = dataUrl.indexOf(',')
  if (comma < 0) return null
  const meta = dataUrl.slice(5, comma) // e.g. "image/jpeg;base64"
  const mediaType = meta.includes('png') ? 'image/png' : 'image/jpeg'
  const data = dataUrl.slice(comma + 1)
  if (!data) return null
  return { data, mediaType }
}

/** Persist a companion screenshot dataURL → signed URL the OWNER can open in chat. */
async function persistScreenshot(dataUrl: string | null | undefined): Promise<string | null> {
  if (!dataUrl || !dataUrl.startsWith('data:image')) return null
  try {
    const comma = dataUrl.indexOf(',')
    const meta = dataUrl.slice(5, comma) // e.g. "image/jpeg;base64"
    const ext = meta.includes('png') ? 'png' : 'jpg'
    const b64 = dataUrl.slice(comma + 1)
    const buf = Buffer.from(b64, 'base64')
    const path = `live-browser/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`
    await agentStorageUpload(path, buf, ext === 'png' ? 'image/png' : 'image/jpeg', { upsert: true })
    return await agentStorageSignedUrl(path, 3600)
  } catch {
    return null
  }
}

/** Resolve the device to drive, or a friendly Bangla reason why we can't. */
async function requireActiveDevice(): Promise<
  { ok: true; deviceId: string; name: string } | { ok: false; error: string }
> {
  if (!(await isLiveBrowserEnabled())) {
    return {
      ok: false,
      error:
        'লাইভ ব্রাউজার এখন বন্ধ আছে, Sir। আগে "live browser চালু করো" বলুন, তারপর আপনার Chrome-এর ' +
        'ALMA Companion এক্সটেনশনটা যুক্ত (pair) থাকতে হবে।',
    }
  }
  const dev = await pickActiveDevice()
  if (!dev) {
    return {
      ok: false,
      error:
        'আপনার কোনো Chrome এখন অনলাইনে যুক্ত নেই, Sir। Chrome খুলুন এবং ALMA Companion এক্সটেনশনে ' +
        '"থামান" করা থাকলে চালু করুন — তারপর আবার বলুন।',
    }
  }
  return { ok: true, deviceId: dev.id, name: dev.name }
}

const set_live_browser: AgentTool = {
  name: 'set_live_browser',
  description:
    "Turn the LIVE browser companion ON or OFF (KV kill-switch, no redeploy, default OFF). " +
    'When ON, the agent can drive the owner\'s own Chrome (his logged-in tabs) through the ' +
    'ALMA Companion extension while he watches. Pass `enabled` true/false. Owner-facing — ' +
    'confirm in Bangla. Turning ON does nothing until the owner has paired his Chrome.',
  input_schema: {
    type: 'object' as const,
    properties: { enabled: { type: 'boolean', description: 'true = ON, false = OFF' } },
    required: ['enabled'],
  },
  handler: async (input) => {
    try {
      const enabled = Boolean(input.enabled)
      await setLiveBrowserEnabled(enabled)
      return {
        success: true,
        data: {
          enabled,
          message: enabled
            ? 'লাইভ ব্রাউজার চালু করলাম, Sir। এবার আপনার Chrome-এ ALMA Companion এক্সটেনশনটা যুক্ত থাকলে ' +
              'আমি আপনার নিজের লগইন দিয়ে কাজ করতে পারব, আপনি লাইভ দেখবেন। যুক্ত করা না থাকলে "pair code দাও" বলুন।'
            : 'লাইভ ব্রাউজার বন্ধ করলাম, Sir — এখন আমি আপনার Chrome-এ কিছু করতে পারব না।',
        },
      }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  },
}

const live_browser_pair: AgentTool = {
  name: 'live_browser_pair',
  description:
    'Generate a ONE-TIME pairing code for the owner to paste into the ALMA Companion Chrome ' +
    'extension. Use when he wants to connect (or reconnect) a Chrome. Returns a short code + ' +
    'how long it is valid. The owner types it himself (no password is ever involved). ' +
    'Optionally pass `deviceName` (e.g. "My Mac Chrome").',
  input_schema: {
    type: 'object' as const,
    properties: {
      deviceName: { type: 'string', description: 'A label for this Chrome, e.g. "My Mac Chrome".' },
    },
    required: [],
  },
  handler: async (input) => {
    try {
      if (!(await isLiveBrowserEnabled())) {
        return {
          success: false,
          error:
            'আগে লাইভ ব্রাউজার চালু করতে হবে, Sir — "live browser চালু করো" বলুন, তারপর কোড নিন।',
        }
      }
      const ticket = await createPairingTicket(String(input.deviceName ?? '') || undefined)
      const mins = Math.round((ticket.expiresAt.getTime() - Date.now()) / 60000)
      return {
        success: true,
        data: {
          code: ticket.code,
          expiresInMinutes: mins,
          message:
            `আপনার এক-বারের পেয়ারিং কোড: ${ticket.code} (প্রায় ${mins} মিনিট চলবে), Sir।\n` +
            'আপনার Chrome-এ ALMA Companion এক্সটেনশন খুলে কোডটা বসান — তাহলে শুধু আমি, আপনার নিজের ' +
            'লগইন দিয়ে, এই ব্রাউজারে কাজ করতে পারব আর আপনি সব লাইভ দেখবেন।',
        },
      }
    } catch (err) {
      const msg = String(err)
      return {
        success: false,
        error:
          msg.includes('owner_user_unresolved')
            ? 'মালিকের ইউজার আইডি বের করতে পারলাম না, Sir — agent_owner_user_id সেট করতে হতে পারে।'
            : msg,
      }
    }
  },
}

const live_browser_status: AgentTool = {
  name: 'live_browser_status',
  description:
    'Show which of the owner\'s Chromes are paired with the ALMA Companion and whether each is ' +
    'online right now (polling). Use before driving the browser, or when he asks if it is connected.',
  input_schema: { type: 'object' as const, properties: {}, required: [] },
  handler: async () => {
    try {
      const enabled = await isLiveBrowserEnabled()
      const devices = await listOwnerDevices()
      const online = devices.filter((d) => d.online).length
      return {
        success: true,
        data: {
          enabled,
          devices: devices.map((d) => ({ name: d.name, online: d.online, lastSeenAt: d.lastSeenAt })),
          summary: !enabled
            ? 'লাইভ ব্রাউজার বন্ধ আছে, Sir।'
            : devices.length === 0
              ? 'কোনো Chrome এখনো যুক্ত করা হয়নি, Sir — "pair code দাও" বললে কোড দিই।'
              : `${devices.length}টি Chrome যুক্ত, এখন অনলাইন ${online}টি, Sir।`,
        },
      }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  },
}

const live_browser_look: AgentTool = {
  name: 'live_browser_look',
  description:
    "Look at the owner's live Chrome tab and get back a REAL SCREENSHOT you can SEE (a vision " +
    'image), plus the page URL/title, visible text, and the clickable elements (links/buttons/' +
    'inputs with their text + ids). Read-only and safe.\n' +
    'WORK LIKE A HUMAN, not by guessing URLs:\n' +
    '• Start from the site\'s normal HOME (e.g. https://www.facebook.com , https://mail.google.com) ' +
    'using the owner\'s existing login — do NOT invent deep/guessed URLs like /SomePageName.\n' +
    '• LOOK first: read the screenshot + elements to see where you actually are.\n' +
    '• Then navigate using the on-page UI (menus, search box, profile/switch, tabs, buttons) with ' +
    'live_browser_act — the same way a person clicks around — and LOOK again after each step to ' +
    'confirm before the next.\n' +
    '• If something is not visible, scroll and look again; never assume a URL exists.\n' +
    'Params: `url` (optional http(s) to open first — use the real HOME, not a guessed path), ' +
    '`scrollBy` (optional pixels), `want` ("text" | "dom" | "both", default "both"), ' +
    '`screenshot` (default true — keep it on so you can SEE the page).',
  input_schema: {
    type: 'object' as const,
    properties: {
      url: { type: 'string', description: 'Optional http(s) URL to navigate to first.' },
      scrollBy: { type: 'number', description: 'Optional pixels to scroll down before reading.' },
      want: { type: 'string', enum: ['text', 'dom', 'both'], description: 'What to read back.' },
      screenshot: { type: 'boolean', description: 'Capture a screenshot (default true).' },
    },
    required: [],
  },
  handler: async (input) => {
    const dev = await requireActiveDevice()
    if (!dev.ok) return { success: false, error: dev.error }
    try {
      const steps: string[] = []
      if (typeof input.url === 'string' && /^https?:\/\//i.test(input.url)) {
        const nav = await runCommand(dev.deviceId, 'navigate', { url: input.url })
        if (!nav.ok) return { success: false, error: `নেভিগেট ব্যর্থ: ${nav.error ?? nav.status}` }
        steps.push(`navigated:${input.url}`)
      }
      if (typeof input.scrollBy === 'number' && input.scrollBy !== 0) {
        await runCommand(dev.deviceId, 'scroll', { by: input.scrollBy })
        steps.push(`scrolled:${input.scrollBy}`)
      }

      const want = (input.want as string) || 'both'
      const out: Record<string, unknown> = { device: dev.name, steps }

      if (want === 'text' || want === 'both') {
        const r = await runCommand(dev.deviceId, 'read_text')
        if (r.ok) out.page = r.data
        else out.textError = r.error ?? r.status
      }
      if (want === 'dom' || want === 'both') {
        const r = await runCommand(dev.deviceId, 'read_dom')
        if (r.ok) out.elements = (r.data as { elements?: unknown })?.elements ?? r.data
        else out.domError = r.error ?? r.status
      }
      let visionImage: { data: string; mediaType: 'image/jpeg' | 'image/png' } | null = null
      if (input.screenshot !== false) {
        const shot = await runCommand(dev.deviceId, 'screenshot')
        if (shot.ok) {
          out.screenshotUrl = await persistScreenshot(shot.screenshot)
          visionImage = splitDataUrl(shot.screenshot)
        }
      }

      return { success: true, data: out, ...(visionImage ? { image: visionImage } : {}) }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  },
}

const live_browser_act: AgentTool = {
  name: 'live_browser_act',
  description:
    "Perform ONE action in the owner's live Chrome tab: click, type, press (a keyboard key), " +
    'select_option, scroll, scroll_to, navigate, go_back, switch_tab, close_tab, or wait. After acting ' +
    'it returns a fresh REAL SCREENSHOT you can SEE, so you verify the effect with your own eyes before ' +
    'the next step.\n' +
    'HUMAN-LIKE OPERATION: prefer clicking the on-page UI (menus, search, buttons, tabs, links you can ' +
    'see in the screenshot/elements) over typing guessed URLs. Locate a target by its visible `text` ' +
    'when you can; use a CSS `selector` only when you actually see it in the elements list. On big / ' +
    'crowded pages, call live_browser_look (read_dom) first — each element comes back with a stable ' +
    '`ref` (e.g. "e12"); pass that `ref` to click/type/select_option/scroll_to for a precise hit. Use ' +
    'scroll_to to bring an element into view before clicking it. Always live_browser_look after acting ' +
    'to confirm what happened, then decide the next single step.\n' +
    'TYPING is React/modern-app safe (it uses the native value setter, so controlled inputs like ' +
    'Facebook / Gmail / Twitter composers actually keep the text). To submit a search or form, either ' +
    'pass `submit: true` on the type action (presses Enter after typing) OR do a separate ' +
    'action="press" with key="Enter". Use press for Enter / Tab / Escape / ArrowDown etc.\n' +
    'DROPDOWNS: for a native HTML <select>, use action="select_option" with `option` = the visible ' +
    'option text (find the select by `ref`/`selector`/`text`). For a custom/ARIA dropdown (a div that ' +
    'opens a menu), do NOT use select_option — click the trigger, then click the option by its text.\n' +
    'TABS/POPUPS: if a click opens a new tab or popup window, action="switch_tab" moves control to the ' +
    'newest tab so your next commands act there; action="close_tab" closes that popup and returns to ' +
    'the main tab. Acting also works inside iframes automatically (embedded forms / checkout widgets).\n' +
    'SAFETY: never use this to press a final Send / Post / Pay / Buy / Transfer / Confirm / Delete — ' +
    'fill the form and navigate, but leave that last irreversible click to the owner and ask him. ' +
    '(A plain Enter to run a Google/search query or move to the next field is fine; the ban is on ' +
    'the final irreversible submit of a message / money / deletion.)\n' +
    'Params by action: ' +
    'click → `selector`/`text`/`ref`; type → (`selector`/`text`/`ref` to find the field) + `value` ' +
    '(+ optional `submit`); press → `key` (e.g. "Enter", "Tab", "Escape"); select_option → ' +
    '(`selector`/`text`/`ref` to find the <select>) + `option` (visible option text); scroll → `by` ' +
    '(pixels, negative = up); scroll_to → `selector`/`text`/`ref`; navigate → `url` (http(s), use a ' +
    'real HOME URL not a guessed path); go_back / switch_tab / close_tab → (none); wait → `ms`.',
  input_schema: {
    type: 'object' as const,
    properties: {
      action: {
        type: 'string',
        enum: [
          'click',
          'type',
          'press',
          'select_option',
          'scroll',
          'scroll_to',
          'navigate',
          'go_back',
          'switch_tab',
          'close_tab',
          'wait',
        ],
        description: 'What to do.',
      },
      selector: { type: 'string', description: 'CSS selector of the target element.' },
      text: { type: 'string', description: 'Visible text to locate the element/field by.' },
      ref: {
        type: 'string',
        description:
          'Stable element ref from live_browser_look read_dom (e.g. "e12"); most precise target.',
      },
      value: { type: 'string', description: 'Text to type (for action=type).' },
      option: {
        type: 'string',
        description: 'For action=select_option: the visible option text to choose in a native <select>.',
      },
      submit: {
        type: 'boolean',
        description: 'For action=type: press Enter after typing (submit a search/form).',
      },
      key: {
        type: 'string',
        description:
          'For action=press: the key to send, e.g. "Enter", "Tab", "Escape", "ArrowDown", "Backspace".',
      },
      url: { type: 'string', description: 'http(s) URL (for action=navigate).' },
      by: { type: 'number', description: 'Pixels to scroll (for action=scroll; negative = up).' },
      ms: { type: 'number', description: 'Milliseconds to wait (for action=wait).' },
    },
    required: ['action'],
  },
  handler: async (input) => {
    const action = String(input.action ?? '') as LiveBrowserAction
    const allowed = new Set([
      'click',
      'type',
      'press',
      'select_option',
      'scroll',
      'scroll_to',
      'navigate',
      'go_back',
      'switch_tab',
      'close_tab',
      'wait',
    ])
    if (!allowed.has(action)) return { success: false, error: `unsupported action: ${action}` }

    if (action === 'navigate' && !/^https?:\/\//i.test(String(input.url ?? ''))) {
      return { success: false, error: 'navigate needs an http(s) url' }
    }
    if (action === 'press' && !String(input.key ?? '').trim()) {
      return { success: false, error: 'press needs a key (e.g. "Enter")' }
    }

    const dev = await requireActiveDevice()
    if (!dev.ok) return { success: false, error: dev.error }

    try {
      const params: Record<string, unknown> = {}
      if (input.selector) params.selector = input.selector
      if (input.text) params.text = input.text
      if (input.ref) params.ref = input.ref
      if (input.value !== undefined) params.value = input.value
      if (input.option !== undefined) params.option = input.option
      if (input.submit !== undefined) params.submit = Boolean(input.submit)
      if (input.key) params.key = input.key
      if (input.url) params.url = input.url
      if (input.by !== undefined) params.by = input.by
      if (input.ms !== undefined) params.ms = input.ms

      const res = await runCommand(dev.deviceId, action, params)
      const out: Record<string, unknown> = {
        device: dev.name,
        action,
        ok: res.ok,
        status: res.status,
      }
      if (!res.ok) out.error = res.error ?? res.status
      if (res.data) out.result = res.data

      // Follow-up screenshot so BOTH the owner (link) and the head model (vision
      // image) see the effect of the action (skip for plain waits).
      let visionImage: { data: string; mediaType: 'image/jpeg' | 'image/png' } | null = null
      if (res.ok && action !== 'wait') {
        const shot = await runCommand(dev.deviceId, 'screenshot')
        if (shot.ok) {
          out.screenshotUrl = await persistScreenshot(shot.screenshot)
          visionImage = splitDataUrl(shot.screenshot)
        }
      }

      return {
        success: res.ok,
        data: out,
        ...(res.ok ? {} : { error: out.error as string }),
        ...(visionImage ? { image: visionImage } : {}),
      }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  },
}

export const LIVE_BROWSER_TOOLS: AgentTool[] = [
  set_live_browser,
  live_browser_pair,
  live_browser_status,
  live_browser_look,
  live_browser_act,
]
