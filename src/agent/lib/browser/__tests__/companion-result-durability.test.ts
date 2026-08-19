import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

describe('Chrome companion durable result delivery', () => {
  it('persists the executed result and blocks another poll until it is acknowledged', () => {
    const source = readFileSync(join(
      process.cwd(),
      'extension/alma-companion/background.js',
    ), 'utf8')

    expect(source).toContain("const PENDING_RESULT_KEY = 'pendingCommandResult'")
    expect(source).toContain('await chrome.storage.local.set({ [PENDING_RESULT_KEY]: pending })')
    expect(source).toContain('if (!(await flushPendingResult(baseUrl, token))) return \'retry\'')
    expect(source).toContain('const delivered = await postResult(baseUrl, token, cmd.id, result)')
    expect(source).toContain("if (!delivered) return 'retry'")
    expect(source).toMatch(/if \(response\.ok \|\| response\.status === 404\)/)
    expect(source.indexOf('if (!(await flushPendingResult(baseUrl, token)))'))
      .toBeLessThan(source.indexOf('fetch(`${baseUrl}${POLL_PATH}`'))
  })

  it('defers updater reload until no command effect or durable receipt is in flight', () => {
    const source = readFileSync(join(
      process.cwd(),
      'extension/alma-companion/background.js',
    ), 'utf8')

    expect(source).toContain('let commandInFlight = false')
    expect(source).toContain('let reloadPending = false')
    expect(source).toContain('if (!reloadPending || commandInFlight) return false')
    expect(source).toContain('if (commandInFlight || stored[PENDING_RESULT_KEY] != null) return false')
    expect(source).toContain('commandInFlight = true')
    expect(source).toMatch(/finally \{\s*commandInFlight = false\s*if \(reloadPending\)/)
    expect(source).toMatch(/disk\?\.version[\s\S]*?reloadPending = true[\s\S]*?applyPendingReloadIfQuiescent/)
    expect(source).not.toMatch(/disk\?\.version[\s\S]{0,180}chrome\.runtime\.reload\(\)/)
    expect(source.indexOf('if (reloadPending) {\n    await applyPendingReloadIfQuiescent()'))
      .toBeLessThan(source.indexOf('fetch(`${baseUrl}${POLL_PATH}`'))
  })

  it('never labels an unrelated foreground tab as the agent preview fallback', () => {
    const source = readFileSync(join(
      process.cwd(),
      'extension/alma-companion/background.js',
    ), 'utf8')
    const fallbackStart = source.indexOf('// 2) Fallback — visible-tab capture')
    const fallbackEnd = source.indexOf('\n  } catch {', fallbackStart)
    const fallback = source.slice(fallbackStart, fallbackEnd)

    expect(fallback).toContain(
      'chrome.tabs.query({ active: true, windowId: tab.windowId })',
    )
    expect(fallback).toContain(
      'if (!activeTabs.some((activeTab) => activeTab.id === tab.id)) return null',
    )
    expect(fallback.indexOf('activeTab.id === tab.id'))
      .toBeLessThan(fallback.indexOf('chrome.tabs.captureVisibleTab'))
    expect(fallback).not.toContain('chrome.tabs.update')
  })
})
