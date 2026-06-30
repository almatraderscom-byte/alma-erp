/**
 * Phase A (browser-agent foundation) — shared types + helpers for the
 * "agent uses a real browser to do tasks on the owner's behalf" capability.
 *
 * The agent never drives the browser inline. It records a BROWSER TASK as a
 * pending action (owner-approval gated), the VPS browser-service (separate PM2
 * process, Playwright) executes the steps, and the result flows back through the
 * normal job-result pipeline.
 *
 * Phase A is deliberately conservative:
 *   • EVERY browser task needs owner approval (no auto-fire yet).
 *   • A separate kill-switch (`browser_agent_enabled` KV, default OFF) must be ON.
 *   • No credential persistence here — that is later-phase work.
 */
import { prisma } from '@/lib/prisma'

export const BROWSER_ACTION_TYPE = 'browser_action'

/** KV flag (owner-tunable, no redeploy). Default OFF — capability is opt-in. */
export const BROWSER_AGENT_ENABLED_KEY = 'browser_agent_enabled'

export const BROWSER_STEP_ACTIONS = [
  'goto',
  'click',
  'type',
  'press',
  'extract',
  'screenshot',
  'wait',
] as const

export type BrowserStepAction = (typeof BROWSER_STEP_ACTIONS)[number]

export interface BrowserStep {
  action: BrowserStepAction
  /** goto: target URL. */
  url?: string
  /** click/type/extract/wait: CSS selector. */
  selector?: string
  /** click/wait: visible text to locate an element (fallback to selector). */
  text?: string
  /** type: text to enter into the field. */
  value?: string
  /** press: a single key name, e.g. "Enter". */
  key?: string
  /** wait: milliseconds to wait (when no selector). */
  ms?: number
  /** extract: what to pull — visible text (default) or raw html. */
  what?: 'text' | 'html'
}

export interface BrowserTaskPayload {
  /** One-line plain-language goal (what the owner asked for). */
  goal: string
  /** Ordered steps the browser-service will execute. */
  steps: BrowserStep[]
  /** Optional first URL (convenience — equivalent to a leading goto step). */
  startUrl?: string
  conversationId?: string | null
}

const MAX_STEPS = 40
const MAX_VALUE_LEN = 2000

/** KV: max browser tasks the agent may create per day (anti-runaway). */
export const BROWSER_DAILY_CAP_KEY = 'browser_daily_task_cap'
const DEFAULT_BROWSER_DAILY_CAP = 25

/**
 * Phase D hardening — SSRF guard. The VPS browser-service will `goto` whatever
 * URL we approve, so a task must never be pointed at loopback / private / cloud
 * metadata hosts (which could expose internal infra). Returns an error string for
 * an unsafe URL, or null when the URL is a safe public http(s) target.
 */
export function unsafeBrowserUrlReason(rawUrl: string): string | null {
  let host: string
  try {
    const u = new URL(rawUrl)
    if (u.protocol !== 'http:' && u.protocol !== 'https:') {
      return `unsupported URL scheme: ${u.protocol}`
    }
    host = u.hostname.toLowerCase().replace(/\.$/, '')
  } catch {
    return `invalid URL: ${rawUrl}`
  }
  if (!host) return 'URL has no host'

  // Loopback / internal hostnames.
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.internal') || host.endsWith('.local')) {
    return `internal host not allowed: ${host}`
  }
  // Cloud metadata endpoints.
  if (host === 'metadata.google.internal' || host === '169.254.169.254') {
    return `metadata endpoint not allowed: ${host}`
  }
  // Bare hostname with no dot and not an IP → almost certainly internal.
  const isIpv4 = /^\d{1,3}(\.\d{1,3}){3}$/.test(host)
  if (!host.includes('.') && !isIpv4 && !host.includes(':')) {
    return `non-public host not allowed: ${host}`
  }
  // Private / reserved IPv4 ranges.
  if (isIpv4) {
    const p = host.split('.').map(Number)
    if (p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return `invalid IP: ${host}`
    const [a, b] = p
    if (
      a === 0 || a === 127 || a === 10 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 169 && b === 254) || // link-local incl. metadata
      a >= 224 // multicast / reserved
    ) {
      return `private/reserved IP not allowed: ${host}`
    }
  }
  // IPv6 loopback / link-local / unique-local.
  if (host.includes(':')) {
    const h = host.replace(/^\[|\]$/g, '')
    if (h === '::1' || h === '::' || h.startsWith('fe80:') || h.startsWith('fc') || h.startsWith('fd')) {
      return `private/reserved IPv6 not allowed: ${host}`
    }
  }
  return null
}

/**
 * Words that signal a high-risk / money / irreversible browser action. Phase A
 * already gates EVERY task behind owner approval, so this is an extra warning
 * flag the approval card surfaces — never a silent auto-path.
 */
const CRITICAL_HINTS = [
  'pay',
  'payment',
  'checkout',
  'buy',
  'order now',
  'place order',
  'purchase',
  'transfer',
  'send money',
  'delete',
  'remove account',
  'confirm order',
  'subscribe',
]

export function isCriticalBrowserTask(payload: BrowserTaskPayload): boolean {
  const haystack = [
    payload.goal,
    payload.startUrl ?? '',
    ...payload.steps.flatMap((s) => [s.url ?? '', s.text ?? '', s.value ?? '', s.selector ?? '']),
  ]
    .join(' ')
    .toLowerCase()
  return CRITICAL_HINTS.some((h) => haystack.includes(h))
}

export interface NormalizedTask {
  ok: true
  payload: BrowserTaskPayload
}
export interface InvalidTask {
  ok: false
  error: string
}

/** Validate + normalize raw tool input into a safe BrowserTaskPayload. */
export function normalizeBrowserTask(input: Record<string, unknown>): NormalizedTask | InvalidTask {
  const goal = String(input.goal ?? '').trim()
  if (!goal) return { ok: false, error: 'goal is required' }

  const startUrl = input.startUrl ? String(input.startUrl).trim() : undefined
  if (startUrl && !/^https?:\/\//i.test(startUrl)) {
    return { ok: false, error: 'startUrl must be an http(s) URL' }
  }
  if (startUrl) {
    const bad = unsafeBrowserUrlReason(startUrl)
    if (bad) return { ok: false, error: `startUrl blocked — ${bad}` }
  }

  const rawSteps = Array.isArray(input.steps) ? input.steps : []
  const steps: BrowserStep[] = []

  // A leading startUrl is sugar for a goto step.
  if (startUrl) steps.push({ action: 'goto', url: startUrl })

  for (const raw of rawSteps) {
    if (!raw || typeof raw !== 'object') continue
    const r = raw as Record<string, unknown>
    const action = String(r.action ?? '') as BrowserStepAction
    if (!(BROWSER_STEP_ACTIONS as readonly string[]).includes(action)) {
      return { ok: false, error: `invalid step action: ${String(r.action)}` }
    }

    const step: BrowserStep = { action }
    if (r.url !== undefined) {
      const url = String(r.url).trim()
      if (action === 'goto' && !/^https?:\/\//i.test(url)) {
        return { ok: false, error: `goto step needs an http(s) url, got: ${url}` }
      }
      if (action === 'goto') {
        const bad = unsafeBrowserUrlReason(url)
        if (bad) return { ok: false, error: `goto blocked — ${bad}` }
      }
      step.url = url
    }
    if (r.selector !== undefined) step.selector = String(r.selector)
    if (r.text !== undefined) step.text = String(r.text)
    if (r.value !== undefined) {
      const v = String(r.value)
      step.value = v.length > MAX_VALUE_LEN ? v.slice(0, MAX_VALUE_LEN) : v
    }
    if (r.key !== undefined) step.key = String(r.key)
    if (r.ms !== undefined) {
      const ms = Number(r.ms)
      if (Number.isFinite(ms) && ms >= 0) step.ms = Math.min(ms, 30_000)
    }
    if (r.what !== undefined) step.what = String(r.what) === 'html' ? 'html' : 'text'

    if (action === 'goto' && !step.url) return { ok: false, error: 'goto step requires url' }
    if (action === 'type' && step.value === undefined) {
      return { ok: false, error: 'type step requires value' }
    }
    if ((action === 'click' || action === 'type') && !step.selector && !step.text) {
      return { ok: false, error: `${action} step requires selector or text` }
    }

    steps.push(step)
  }

  if (steps.length === 0) return { ok: false, error: 'at least one step (or startUrl) is required' }
  if (steps.length > MAX_STEPS) return { ok: false, error: `too many steps (max ${MAX_STEPS})` }
  if (!steps.some((s) => s.action === 'goto')) {
    return { ok: false, error: 'a browser task must start by navigating (goto / startUrl)' }
  }

  const conversationId = input.conversationId ? String(input.conversationId) : null
  return { ok: true, payload: { goal, steps, startUrl, conversationId } }
}

/** Owner-facing Bangla summary for the approval card. */
export function summarizeBrowserTask(payload: BrowserTaskPayload): string {
  const lines: string[] = []
  lines.push(`🌐 ব্রাউজার টাস্ক: ${payload.goal}`)
  const stepLabels: Record<BrowserStepAction, string> = {
    goto: 'খুলবে',
    click: 'ক্লিক করবে',
    type: 'টাইপ করবে',
    press: 'কী চাপবে',
    extract: 'তথ্য নেবে',
    screenshot: 'স্ক্রিনশট নেবে',
    wait: 'অপেক্ষা করবে',
  }
  payload.steps.slice(0, 12).forEach((s, i) => {
    const detail =
      s.action === 'goto'
        ? s.url
        : s.action === 'type'
          ? `${s.selector ?? s.text ?? ''} ← "${(s.value ?? '').slice(0, 30)}"`
          : s.selector || s.text || s.key || (s.ms ? `${s.ms}ms` : '')
    lines.push(`${i + 1}. ${stepLabels[s.action]}${detail ? `: ${detail}` : ''}`)
  })
  if (payload.steps.length > 12) lines.push(`… আরও ${payload.steps.length - 12}টি ধাপ`)
  if (isCriticalBrowserTask(payload)) {
    lines.push('')
    lines.push('⚠️ এই টাস্কে টাকা/অপরিবর্তনীয় কিছু থাকতে পারে — অনুমতি দেওয়ার আগে ভালো করে দেখুন, Sir।')
  }
  return lines.join('\n')
}

export interface CreatedBrowserTask {
  pendingActionId: string
  critical: boolean
  stepCount: number
  summary: string
}

/**
 * Shared create-path: turn a validated BrowserTaskPayload into an owner-approval
 * pending action. Used by both run_browser_task (free-form) and run_browser_recipe
 * (Phase B) so the gating, summary and critical-flag logic stay identical.
 */
export async function createBrowserTaskPendingAction(
  payload: BrowserTaskPayload,
): Promise<CreatedBrowserTask> {
  const summary = summarizeBrowserTask(payload)
  const critical = isCriticalBrowserTask(payload)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const action = await (prisma as any).agentPendingAction.create({
    data: {
      conversationId: payload.conversationId ?? null,
      type: BROWSER_ACTION_TYPE,
      payload: { ...payload, critical },
      summary,
      costEstimate: null,
      status: 'pending',
    },
  })
  return { pendingActionId: action.id as string, critical, stepCount: payload.steps.length, summary }
}

/**
 * Phase D hardening — anti-runaway daily cap. Counts browser tasks created since
 * local midnight and refuses new ones past the (KV-tunable) cap, so a head-model
 * loop can't flood the owner's approval queue. Fail-OPEN on any error (never block
 * a legitimate task because the count read failed).
 */
export async function checkBrowserDailyCap(): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    let cap = DEFAULT_BROWSER_DAILY_CAP
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const row = await (prisma as any).agentKvSetting.findUnique({
      where: { key: BROWSER_DAILY_CAP_KEY },
      select: { value: true },
    })
    const parsed = Number(row?.value)
    if (Number.isFinite(parsed) && parsed > 0) cap = Math.floor(parsed)

    const since = new Date()
    since.setHours(0, 0, 0, 0)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const count = await (prisma as any).agentPendingAction.count({
      where: { type: BROWSER_ACTION_TYPE, createdAt: { gte: since } },
    })
    if (count >= cap) {
      return { ok: false, error: `daily browser-task limit reached (${count}/${cap}) — try again tomorrow or raise '${BROWSER_DAILY_CAP_KEY}'` }
    }
    return { ok: true }
  } catch {
    return { ok: true } // fail-open
  }
}

/** Reads the browser-agent kill-switch (KV). Default OFF. */
export async function isBrowserAgentEnabled(): Promise<boolean> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const row = await (prisma as any).agentKvSetting.findUnique({
      where: { key: BROWSER_AGENT_ENABLED_KEY },
      select: { value: true },
    })
    return row?.value === 'true'
  } catch {
    return false
  }
}
