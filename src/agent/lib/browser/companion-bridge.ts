/**
 * Running an approved browser task inside the owner's OWN Chrome.
 *
 * Two browser worlds grew up separately in this codebase: a step list
 * (`BrowserStep`) that the VPS Playwright service executes, and a command bus
 * (`LIVE_BROWSER_ACTIONS`) that the Mac Chrome extension executes. The driver
 * router now sends every business-login task to the companion, which made the gap
 * between them the thing standing between the owner and Facebook Ads. This module
 * is that gap closed: one translation, one execution loop, same result shape the
 * VPS runner already returns, so the rest of the pipeline cannot tell the
 * difference.
 *
 * What it deliberately does NOT do:
 *   • it never invents a step the extension cannot honour — an untranslatable
 *     step fails the task with a plain reason rather than being silently dropped,
 *     because a task that skipped a step and reported success is worse than one
 *     that stopped;
 *   • it never bypasses the final-submit ban. The extension enforces it in-page
 *     and this side refuses to even queue such a click, so the last irreversible
 *     press stays the owner's own.
 */
import type { BrowserStep, BrowserTaskPayload } from '@/agent/lib/browser/actions'
import { isFinalSubmitText } from '@/agent/lib/browser/final-submit'
import {
  isLiveBrowserEnabled,
  pickActiveDevice,
  runCommand,
  type BrowserActivityContext,
  type LiveBrowserAction,
} from '@/agent/lib/live-browser/companion'

/** The extension has no coordinate verbs — those belong to the Playwright runner. */
const UNSUPPORTED_HINT =
  'the owner\'s Chrome is driven by selectors and visible text, not screen coordinates'

export interface TranslatedCommand {
  action: LiveBrowserAction
  params: Record<string, unknown>
}

export type TranslateResult = { ok: true; command: TranslatedCommand } | { ok: false; error: string }

/** One BrowserStep → one extension command. */
export function translateStep(step: BrowserStep): TranslateResult {
  switch (step.action) {
    case 'goto':
      if (!step.url) return { ok: false, error: 'goto step has no url' }
      return { ok: true, command: { action: 'navigate', params: { url: step.url } } }

    case 'click': {
      const target = step.selector ?? step.text ?? ''
      // Defence in depth: the extension blocks the final irreversible click in-page,
      // and this side refuses to queue it in the first place.
      if (step.text && isFinalSubmitText(step.text)) {
        return { ok: false, error: `refusing to click "${step.text}" — the final send/pay/confirm press stays the owner's own` }
      }
      if (!target) return { ok: false, error: 'click step has no selector or text' }
      return {
        ok: true,
        command: { action: 'click', params: step.selector ? { selector: step.selector } : { text: step.text } },
      }
    }

    case 'type':
      if (step.value === undefined) return { ok: false, error: 'type step has no value' }
      if (!step.selector && !step.text) return { ok: false, error: 'type step has no selector or text' }
      return {
        ok: true,
        command: {
          action: 'type',
          params: { ...(step.selector ? { selector: step.selector } : { text: step.text }), value: step.value },
        },
      }

    case 'press':
      if (!step.key) return { ok: false, error: 'press step has no key' }
      return { ok: true, command: { action: 'press', params: { key: step.key } } }

    case 'extract':
      // 'html' asks for structure, which is read_dom; anything else is the text.
      return step.what === 'html'
        ? { ok: true, command: { action: 'read_dom', params: step.selector ? { selector: step.selector } : {} } }
        : { ok: true, command: { action: 'read_text', params: step.selector ? { selector: step.selector } : {} } }

    case 'screenshot':
      return { ok: true, command: { action: 'screenshot', params: {} } }

    case 'wait':
      return {
        ok: true,
        command: { action: 'wait', params: step.selector ? { selector: step.selector } : { ms: step.ms ?? 1000 } },
      }

    case 'scroll':
      return { ok: true, command: { action: 'scroll', params: { deltaY: step.deltaY ?? 0 } } }

    // Coordinate primitives exist for the headless runner, which can see a fixed
    // viewport. The owner's real window is a different size on every machine, so a
    // coordinate click there would land somewhere nobody chose.
    case 'click_xy':
    case 'double_click':
    case 'move':
    case 'drag':
    case 'zoom':
      return { ok: false, error: `"${step.action}" cannot run in the owner's own Chrome — ${UNSUPPORTED_HINT}` }

    default:
      return { ok: false, error: `unknown step action: ${String((step as BrowserStep).action)}` }
  }
}

export interface CompanionRunResult {
  ok: boolean
  goal: string
  log: string[]
  extracted: Array<{ step: number; what: string; text: string }>
  screenshots: Array<{ step: number; dataUrl?: string; note?: string }>
  error?: string
  /** Which of the owner's devices ran it, for the report. */
  device?: string
}

/**
 * Execute an approved task in the owner's Chrome, step by step, stopping at the
 * first failure. The shape mirrors the VPS runner's result so the job-result
 * pipeline, the claim verifier and the owner-facing report all keep working.
 */
export async function runBrowserTaskOnCompanion(
  payload: BrowserTaskPayload,
  activityContext: BrowserActivityContext,
): Promise<CompanionRunResult> {
  const result: CompanionRunResult = {
    ok: false,
    goal: payload.goal ?? '',
    log: [],
    extracted: [],
    screenshots: [],
  }

  if (!(await isLiveBrowserEnabled())) {
    result.error = 'live_browser_disabled'
    result.log.push('আপনার Chrome দিয়ে কাজ করার ক্ষমতা বন্ধ আছে (live_browser_enabled)।')
    return result
  }

  const device = await pickActiveDevice()
  if (!device) {
    result.error = 'companion_offline'
    result.log.push('আপনার Mac-এর Chrome এখন যুক্ত নেই — ALMA Companion চালু আছে কিনা দেখুন।')
    return result
  }
  result.device = device.name ?? device.id

  const steps = payload.steps ?? []
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i]
    const translated = translateStep(step)
    if (!translated.ok) {
      result.error = translated.error
      result.log.push(`#${i + 1} ${step.action} — ${translated.error}`)
      return result
    }

    const { action, params } = translated.command
    const run = await runCommand(device.id, action, params, undefined, activityContext)
    if (!run.ok) {
      result.error = run.error ?? `step ${i + 1} (${action}) failed`
      result.log.push(`#${i + 1} ${action} — ব্যর্থ: ${result.error}`)
      return result
    }

    result.log.push(`#${i + 1} ${action}`)

    // read_text / read_dom carry the payload the head actually asked for.
    if (action === 'read_text' || action === 'read_dom') {
      const text = typeof run.data === 'string' ? run.data : JSON.stringify(run.data ?? '')
      result.extracted.push({ step: i + 1, what: action === 'read_dom' ? 'html' : 'text', text })
    }
    if (run.screenshot) {
      result.screenshots.push({ step: i + 1, dataUrl: run.screenshot })
    }
  }

  result.ok = true
  return result
}
