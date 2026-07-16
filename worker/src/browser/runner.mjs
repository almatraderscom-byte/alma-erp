/**
 * Phase A browser-agent runner — executes one approved browser task with Playwright.
 *
 * Conservative foundation:
 *   • Headless Chromium, fresh ephemeral context per task (no credential persistence).
 *   • Hard per-task timeout; bounded steps (already validated server-side).
 *   • Returns extracted text + a step log + a capped JPEG screenshot (data URL).
 *
 * Playwright is imported lazily so the rest of the service can boot/report a clean
 * error even if the browser binary is missing on the host.
 */

import { summarizeConsole, summarizeNetwork, classifyFailure, evaluateSuccessCriteria } from './diagnostics.mjs'

const STEP_ACTIONS = new Set([
  'goto', 'click', 'type', 'press', 'extract', 'screenshot', 'wait',
  // Phase 48 coordinate/diagnostic primitives
  'click_xy', 'double_click', 'move', 'drag', 'scroll', 'zoom',
])
const TASK_TIMEOUT_MS = 90_000
const NAV_TIMEOUT_MS = 30_000
const MAX_SHOT_B64 = 350_000 // ~260KB image — keep the result JSON small.

function locator(page, step) {
  if (step.selector) return page.locator(step.selector).first()
  if (step.text) return page.getByText(step.text, { exact: false }).first()
  return null
}

/**
 * @param {object} payload  normalized BrowserTaskPayload ({ goal, steps, ... })
 * @returns {Promise<{ ok: boolean, goal: string, log: string[], extracted: Array<{step:number,what:string,text:string}>, screenshots: Array<{step:number,dataUrl?:string,note?:string}>, error?: string }>}
 */
export async function runBrowserTask(payload) {
  const result = {
    ok: false,
    goal: payload?.goal ?? '',
    log: [],
    extracted: [],
    screenshots: [],
  }

  let chromium
  try {
    ;({ chromium } = await import('playwright'))
  } catch {
    result.error = 'playwright_not_installed'
    result.log.push('Playwright is not installed on this host.')
    return result
  }

  const steps = Array.isArray(payload?.steps) ? payload.steps : []
  let browser
  const deadline = Date.now() + TASK_TIMEOUT_MS
  // Declared out here so the catch-path diagnostics never hit a TDZ reference.
  const consoleEntries = []
  const networkEntries = []

  try {
    browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] })
    const context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      userAgent:
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
    })
    const page = await context.newPage()
    page.setDefaultTimeout(NAV_TIMEOUT_MS)

    // Phase 48 — guarded diagnostics collection (read-only observers).
    page.on('console', (msg) => {
      if (consoleEntries.length < 200) consoleEntries.push({ type: msg.type(), text: msg.text() })
    })
    page.on('response', (res) => {
      if (networkEntries.length >= 300) return
      const status = res.status()
      if (status >= 300) {
        networkEntries.push({ url: res.url(), status, location: status < 400 ? res.headers()['location'] ?? null : null })
      }
    })
    page.on('requestfailed', (req) => {
      if (networkEntries.length < 300) networkEntries.push({ url: req.url(), failed: true, errorText: req.failure()?.errorText ?? null })
    })
    // The autonomous operator NEVER downloads files — cancel + log.
    page.on('download', (dl) => {
      result.log.push(`download BLOCKED: ${dl.suggestedFilename()} — operator does not download files`)
      dl.cancel().catch(() => {})
    })

    for (let i = 0; i < steps.length; i++) {
      if (Date.now() > deadline) throw new Error('task_timeout')
      const step = steps[i]
      const action = String(step?.action ?? '')
      if (!STEP_ACTIONS.has(action)) {
        result.log.push(`#${i + 1} skipped unknown action "${action}"`)
        continue
      }

      try {
        if (action === 'goto') {
          await page.goto(step.url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS })
          result.log.push(`#${i + 1} goto ${step.url}`)
        } else if (action === 'click') {
          const loc = locator(page, step)
          if (!loc) throw new Error('click needs selector or text')
          await loc.click({ timeout: NAV_TIMEOUT_MS })
          result.log.push(`#${i + 1} click ${step.selector || step.text}`)
        } else if (action === 'type') {
          const loc = locator(page, step)
          if (!loc) throw new Error('type needs selector or text')
          await loc.fill(String(step.value ?? ''))
          result.log.push(`#${i + 1} type into ${step.selector || step.text}`)
        } else if (action === 'press') {
          await page.keyboard.press(String(step.key ?? 'Enter'))
          result.log.push(`#${i + 1} press ${step.key}`)
        } else if (action === 'wait') {
          if (step.selector) {
            await page.locator(step.selector).first().waitFor({ timeout: NAV_TIMEOUT_MS })
            result.log.push(`#${i + 1} wait for ${step.selector}`)
          } else {
            const ms = Math.min(Number(step.ms ?? 1000), 30_000)
            await page.waitForTimeout(ms)
            result.log.push(`#${i + 1} wait ${ms}ms`)
          }
        } else if (action === 'extract') {
          let text = ''
          if (step.selector) {
            const loc = page.locator(step.selector).first()
            text = step.what === 'html' ? await loc.innerHTML() : await loc.innerText()
          } else {
            text = step.what === 'html' ? await page.content() : await page.locator('body').innerText()
          }
          text = (text || '').trim().slice(0, 8000)
          result.extracted.push({ step: i + 1, what: step.what === 'html' ? 'html' : 'text', text })
          result.log.push(`#${i + 1} extract (${text.length} chars)`)
        } else if (action === 'screenshot') {
          const buf = await page.screenshot({ type: 'jpeg', quality: 60, fullPage: false })
          const b64 = buf.toString('base64')
          if (b64.length <= MAX_SHOT_B64) {
            result.screenshots.push({ step: i + 1, dataUrl: `data:image/jpeg;base64,${b64}` })
          } else {
            result.screenshots.push({ step: i + 1, note: `screenshot too large (${b64.length} b64 chars), dropped` })
          }
          result.log.push(`#${i + 1} screenshot`)
        } else if (action === 'click_xy') {
          await page.mouse.click(Number(step.x), Number(step.y))
          result.log.push(`#${i + 1} click_xy (${step.x},${step.y})`)
        } else if (action === 'double_click') {
          if (step.x !== undefined && step.y !== undefined) {
            await page.mouse.dblclick(Number(step.x), Number(step.y))
            result.log.push(`#${i + 1} double_click (${step.x},${step.y})`)
          } else {
            const loc = locator(page, step)
            if (!loc) throw new Error('double_click needs x/y or selector/text')
            await loc.dblclick({ timeout: NAV_TIMEOUT_MS })
            result.log.push(`#${i + 1} double_click ${step.selector || step.text}`)
          }
        } else if (action === 'move') {
          await page.mouse.move(Number(step.x), Number(step.y))
          result.log.push(`#${i + 1} move (${step.x},${step.y})`)
        } else if (action === 'drag') {
          // Robust drag: move → down → stepped moves → up (some UIs need intermediate events).
          const { x, y, toX, toY } = step
          await page.mouse.move(Number(x), Number(y))
          await page.mouse.down()
          const steps = 8
          for (let k = 1; k <= steps; k++) {
            await page.mouse.move(
              Number(x) + ((Number(toX) - Number(x)) * k) / steps,
              Number(y) + ((Number(toY) - Number(y)) * k) / steps,
            )
          }
          await page.mouse.up()
          result.log.push(`#${i + 1} drag (${x},${y})→(${toX},${toY})`)
        } else if (action === 'scroll') {
          await page.mouse.wheel(0, Number(step.deltaY ?? 0))
          result.log.push(`#${i + 1} scroll ${step.deltaY}px`)
        } else if (action === 'zoom') {
          const r = step.region ?? {}
          const buf = await page.screenshot({
            type: 'jpeg',
            quality: 70,
            clip: { x: Number(r.x), y: Number(r.y), width: Number(r.width), height: Number(r.height) },
          })
          const b64 = buf.toString('base64')
          if (b64.length <= MAX_SHOT_B64) {
            result.screenshots.push({ step: i + 1, dataUrl: `data:image/jpeg;base64,${b64}`, note: `zoom ${JSON.stringify(r)}` })
          } else {
            result.screenshots.push({ step: i + 1, note: 'zoom screenshot too large, dropped' })
          }
          result.log.push(`#${i + 1} zoom ${JSON.stringify(r)}`)
        }
      } catch (stepErr) {
        const msg = stepErr instanceof Error ? stepErr.message : String(stepErr)
        result.log.push(`#${i + 1} ${action} FAILED: ${msg}`)
        throw new Error(`step ${i + 1} (${action}) failed: ${msg}`)
      }
    }

    // Phase 48 — independent final-state re-read + explicit success criteria.
    // A step log alone never proves success; we re-read where we ended up.
    try {
      const finalUrl = page.url()
      const visibleText = (await page.locator('body').innerText().catch(() => '')).slice(0, 20_000)
      const criteria = Array.isArray(payload?.successCriteria) ? payload.successCriteria : []
      const presentSelectors = []
      for (const c of criteria) {
        if (c?.kind === 'selector_exists' && c.selector) {
          const count = await page.locator(c.selector).count().catch(() => 0)
          if (count > 0) presentSelectors.push(c.selector)
        }
      }
      result.finalState = { url: finalUrl, textLength: visibleText.length }
      if (criteria.length > 0) {
        result.criteria = evaluateSuccessCriteria(criteria, { url: finalUrl, visibleText, presentSelectors })
        result.log.push(
          result.criteria.passed
            ? `success criteria: ${criteria.length}/${criteria.length} PASSED (final state re-read)`
            : `success criteria FAILED: ${result.criteria.results.filter((r) => !r.passed).map((r) => r.detail).join('; ')}`,
        )
      }
      result.diagnostics = {
        console: summarizeConsole(consoleEntries),
        network: summarizeNetwork(networkEntries),
      }
    } catch (verifyErr) {
      result.log.push(`final-state verification failed: ${verifyErr.message}`)
    }

    // ok = steps ran AND (no criteria, or criteria passed).
    result.ok = !result.criteria || result.criteria.passed === true
    if (!result.ok) result.error = 'success_criteria_failed'
    return result
  } catch (err) {
    result.error = err instanceof Error ? err.message : String(err)
    result.failureDiagnosis = classifyFailure(result.error)
    result.diagnostics = {
      console: summarizeConsole(consoleEntries),
      network: summarizeNetwork(networkEntries),
    }
    return result
  } finally {
    if (browser) await browser.close().catch(() => {})
  }
}
