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

const STEP_ACTIONS = new Set(['goto', 'click', 'type', 'press', 'extract', 'screenshot', 'wait'])
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

  try {
    browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] })
    const context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      userAgent:
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
    })
    const page = await context.newPage()
    page.setDefaultTimeout(NAV_TIMEOUT_MS)

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
        }
      } catch (stepErr) {
        const msg = stepErr instanceof Error ? stepErr.message : String(stepErr)
        result.log.push(`#${i + 1} ${action} FAILED: ${msg}`)
        throw new Error(`step ${i + 1} (${action}) failed: ${msg}`)
      }
    }

    result.ok = true
    return result
  } catch (err) {
    result.error = err instanceof Error ? err.message : String(err)
    return result
  } finally {
    if (browser) await browser.close().catch(() => {})
  }
}
