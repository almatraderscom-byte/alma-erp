import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { describe, expect, it, vi } from 'vitest'

const source = readFileSync(
  new URL('../../../../extension/alma-companion/background.js', import.meta.url),
  'utf8',
)

function sourceFunction(startMarker: string, endMarker: string): string {
  const start = source.indexOf(startMarker)
  const end = source.indexOf(endMarker, start)
  if (start < 0 || end < 0) throw new Error(`Companion function not found: ${startMarker}`)
  return source.slice(start, end)
}

class FakeElement {
  readonly attrs = new Map<string, string>()
  tagName: string
  innerText: string
  textContent: string
  value = ''
  placeholder = ''
  id = ''
  options: unknown[] = []
  isContentEditable = false
  style = { outline: '', outlineOffset: '' }
  scrollIntoView = vi.fn()
  focus = vi.fn()
  click = vi.fn()
  dispatchEvent = vi.fn()

  constructor(tagName: string, text: string) {
    this.tagName = tagName
    this.innerText = text
    this.textContent = text
  }

  getAttribute(name: string) { return this.attrs.get(name) ?? null }
  setAttribute(name: string, value: string) { this.attrs.set(name, String(value)) }
  removeAttribute(name: string) { this.attrs.delete(name) }
  getBoundingClientRect() {
    return { width: 120, height: 40, top: 20, left: 20, bottom: 60, right: 140 }
  }
}

function fingerprintOf(node: FakeElement): string {
  return JSON.stringify([
    node.tagName.toLowerCase(),
    node.getAttribute('type') || (node.tagName === 'SELECT' ? 'select' : ''),
    node.getAttribute('role') || '',
    node.getAttribute('name') || '',
    node.getAttribute('aria-label') || '',
    (
      node.tagName === 'INPUT' || node.tagName === 'TEXTAREA' || node.isContentEditable
        ? (node.placeholder || '')
        : (node.innerText || node.value || '')
    ).trim().replace(/\s+/g, ' ').slice(0, 120),
    node.getAttribute('href') || '',
  ])
}

function activeRendererAuthority() {
  return {
    __almaDispatchGeneration: 1,
    __almaDispatchNonce: 'test-command-nonce',
    __almaEffectDeadlineMs: Date.now() + 60_000,
  }
}

function activeRendererChrome(
  generation = 1,
  nonce = 'test-command-nonce',
  overrides: { paused?: boolean; token?: string } = {},
) {
  return {
    storage: {
      local: {
        get: vi.fn(async () => ({
          paused: overrides.paused ?? false,
          token: overrides.token ?? 'device-token',
          commandDispatchGeneration: generation,
          commandDispatchNonce: nonce,
        })),
      },
    },
  }
}

describe('Companion DOM observation generation', () => {
  it('treats the required consumer host as exact and returns no Studio DOM', async () => {
    const querySelectorAll = vi.fn(() => [])
    const root = new FakeElement('HTML', '')
    const document = {
      documentElement: root,
      body: { scrollHeight: 900 },
      title: 'Private channel analytics',
      querySelectorAll,
    }
    const readDom = runInNewContext(
      `(${sourceFunction('async function pageReadDom', '\nfunction pageObservationIdentity')})`,
      {
        document,
        window: { innerHeight: 800, innerWidth: 1200 },
        location: {
          href: 'https://studio.youtube.com/channel/private/analytics',
          hostname: 'studio.youtube.com',
        },
        performance: { timeOrigin: 1234.4 },
        crypto: { randomUUID: () => 'must-not-be-used' },
        Math,
        Date,
      },
    ) as (arg: {
      requiredHost: string
      expectedCurrentUrl: string
      expectedDocumentId: string
    }) => Promise<{ __almaHostBlocked?: boolean }>
    const readText = runInNewContext(
      `(${sourceFunction('function pageReadText', '\nasync function pageReadDom')})`,
      {
        location: {
          href: 'https://studio.youtube.com/channel/private/analytics',
          hostname: 'studio.youtube.com',
        },
        performance: { timeOrigin: 1234.4 },
      },
    ) as (arg: {
      requiredHost: string
      expectedCurrentUrl: string
      expectedDocumentId: string
    }) => { __almaHostBlocked?: boolean }

    const exactIdentity = {
      expectedCurrentUrl: 'https://studio.youtube.com/channel/private/analytics',
      expectedDocumentId: '1234',
    }
    expect(readText({ requiredHost: 'youtube.com', ...exactIdentity })).toEqual({
      __almaHostBlocked: true,
    })
    await expect(readDom({ requiredHost: 'youtube.com', ...exactIdentity })).resolves.toEqual({
      __almaHostBlocked: true,
    })
    expect(querySelectorAll).not.toHaveBeenCalled()
    expect(root.getAttribute('data-alma-observation-id')).toBeNull()
  })

  it('requires the exact URL and document inside each text/DOM renderer task', async () => {
    let textTouched = false
    const readText = runInNewContext(
      `(${sourceFunction('function pageReadText', '\nasync function pageReadDom')})`,
      {
        document: {
          get body() {
            textTouched = true
            return { innerText: 'must not escape' }
          },
        },
        location: { href: 'https://www.youtube.com/watch?v=abcDEF_1234' },
        performance: { timeOrigin: 4000.2 },
        Math,
        String,
      },
    ) as (arg?: Record<string, unknown>) => Record<string, unknown>

    expect(readText({
      expectedCurrentUrl: 'https://www.youtube.com/watch?v=abcDEF_1234',
    })).toEqual({ __almaObservationBlocked: true })
    expect(readText({
      expectedCurrentUrl: 'https://www.youtube.com/watch?v=different01',
      expectedDocumentId: '4000',
    })).toEqual({ __almaObservationBlocked: true })
    expect(readText({
      expectedCurrentUrl: 'https://www.youtube.com/watch?v=abcDEF_1234',
      expectedDocumentId: '4001',
    })).toEqual({ __almaObservationBlocked: true })
    expect(textTouched).toBe(false)

    const querySelectorAll = vi.fn(() => [])
    const root = new FakeElement('HTML', '')
    const readDom = runInNewContext(
      `(${sourceFunction('async function pageReadDom', '\nfunction pageObservationIdentity')})`,
      {
        document: { documentElement: root, querySelectorAll },
        location: { href: 'https://www.youtube.com/results?search_query=song' },
        performance: { timeOrigin: 5000.2 },
        Math,
        String,
      },
    ) as (arg?: Record<string, unknown>) => Promise<Record<string, unknown>>

    await expect(readDom({
      expectedCurrentUrl: 'https://www.youtube.com/results?search_query=song',
    })).resolves.toEqual({ __almaObservationBlocked: true })
    await expect(readDom({
      expectedCurrentUrl: 'https://www.youtube.com/results?search_query=song',
      expectedDocumentId: 'different-document',
    })).resolves.toEqual({ __almaObservationBlocked: true })
    expect(querySelectorAll).not.toHaveBeenCalled()
    expect(root.getAttribute('data-alma-observation-id')).toBeNull()
  })

  it('rebinds every ref and the document root to a fresh generation on each DOM read', async () => {
    const root = new FakeElement('HTML', '')
    const first = new FakeElement('BUTTON', 'First')
    first.setAttribute('role', 'button')
    const second = new FakeElement('A', 'Second')
    second.setAttribute('href', '/second')
    let candidates = [first, second]
    const generations = ['dom-generation-1', 'dom-generation-2']
    const document = {
      documentElement: root,
      body: { scrollHeight: 900 },
      title: 'Example',
      querySelectorAll: (selector: string) => selector === '[data-alma-ref]'
        ? candidates.filter((node) => node.getAttribute('data-alma-ref'))
        : candidates,
    }
    const context = {
      document,
      window: { innerHeight: 800, innerWidth: 1200 },
      location: { href: 'https://example.com/current' },
      performance: { timeOrigin: 1234.4 },
      crypto: { randomUUID: () => generations.shift() },
      Math,
      Date,
      chrome: activeRendererChrome(),
    }
    const readDom = runInNewContext(
      `(${sourceFunction('async function pageReadDom', '\nfunction pageObservationIdentity')})`,
      context,
    ) as (arg?: {
      expectedCurrentUrl?: string
      expectedDocumentId?: string
      __almaDispatchGeneration?: number
      __almaDispatchNonce?: string
      __almaEffectDeadlineMs?: number
    }) => Promise<{ domObservationId: string; elements: Array<{ ref: string; fingerprint: string }> }>
    const identity = runInNewContext(
      `(${sourceFunction('function pageObservationIdentity', '\n// Live status banner')})`,
      context,
    ) as () => { domObservationId: string }

    const observationIdentity = {
      expectedCurrentUrl: 'https://example.com/current',
      expectedDocumentId: '1234',
    }
    // Neither identity field is the legacy/general protocol and remains
    // readable. Supplying either field switches to the exact-bound protocol.
    const one = await readDom(activeRendererAuthority())
    expect(one.domObservationId).toBe('dom-generation-1')
    expect(one.elements[0]).toMatchObject({ ref: 'e1', fingerprint: fingerprintOf(first) })
    expect(first.getAttribute('data-alma-observation-id')).toBe('dom-generation-1')

    candidates = [second, first]
    const two = await readDom({ ...observationIdentity, ...activeRendererAuthority() })
    expect(two.domObservationId).toBe('dom-generation-2')
    expect(root.getAttribute('data-alma-observation-id')).toBe('dom-generation-2')
    expect(second.getAttribute('data-alma-ref')).toBe('e1')
    expect(first.getAttribute('data-alma-ref')).toBe('e2')
    expect(first.getAttribute('data-alma-observation-id')).toBe('dom-generation-2')
    expect(identity()).toMatchObject({ domObservationId: 'dom-generation-2' })
  })

  it('fails the page precondition when a ref action lacks or mismatches the DOM generation', async () => {
    let liveIdentity = {
      url: 'https://example.com/current',
      documentId: 'document-1',
      domObservationId: 'dom-generation-2',
    }
    const verify = runInNewContext(
      `(${sourceFunction('async function verifyObservationPrecondition', '\n// Stamp mute + foreground state')})`,
      {
        chrome: { tabs: { get: async () => ({ url: liveIdentity.url }) } },
        runInPage: async () => liveIdentity,
        pageObservationIdentity: () => liveIdentity,
        String,
      },
    ) as (
      tabId: number,
      precondition: Record<string, unknown>,
      requireDomObservationId?: boolean,
    ) => Promise<{ ok: boolean; blocked?: boolean; error?: string }>

    await expect(verify(1, {
      currentUrl: liveIdentity.url,
      documentId: liveIdentity.documentId,
    }, true)).resolves.toMatchObject({ ok: false, blocked: true })
    await expect(verify(1, {
      currentUrl: liveIdentity.url,
      documentId: liveIdentity.documentId,
      domObservationId: 'dom-generation-1',
    }, true)).resolves.toMatchObject({ ok: false, blocked: true })
    await expect(verify(1, {
      currentUrl: liveIdentity.url,
      documentId: liveIdentity.documentId,
      domObservationId: 'dom-generation-2',
    }, true)).resolves.toEqual({ ok: true })

    liveIdentity = { ...liveIdentity, domObservationId: 'dom-generation-3' }
    await expect(verify(1, {
      currentUrl: liveIdentity.url,
      documentId: liveIdentity.documentId,
      domObservationId: 'dom-generation-2',
    }, true)).resolves.toMatchObject({ ok: false, blocked: true })
  })

  it('rejects a same-node semantic mutation even when ref and generation attributes still match', async () => {
    const root = new FakeElement('HTML', '')
    root.setAttribute('data-alma-observation-id', 'dom-generation-1')
    const target = new FakeElement('BUTTON', 'Play requested song')
    target.setAttribute('role', 'button')
    target.setAttribute('data-alma-ref', 'e1')
    target.setAttribute('data-alma-observation-id', 'dom-generation-1')
    const observedFingerprint = fingerprintOf(target)
    const document = {
      documentElement: root,
      querySelector: (selector: string) => (
        selector.includes('data-alma-ref="e1"')
        && selector.includes('data-alma-observation-id="dom-generation-1"')
          ? target
          : null
      ),
      querySelectorAll: () => [],
    }
    const scrollTo = runInNewContext(
      `(${sourceFunction('async function pageScrollTo', '\nasync function pageScroll')})`,
      { document, chrome: activeRendererChrome(), String, JSON },
    ) as (arg: Record<string, unknown>) => Promise<{ ok: boolean; blocked?: boolean; error?: string }>
    const arg = {
      ref: 'e1',
      domObservationId: 'dom-generation-1',
      refFingerprint: observedFingerprint,
      ...activeRendererAuthority(),
    }

    await expect(scrollTo(arg)).resolves.toMatchObject({ ok: true })
    expect(target.scrollIntoView).toHaveBeenCalledOnce()

    target.innerText = 'Delete account'
    target.textContent = 'Delete account'
    await expect(scrollTo(arg)).resolves.toMatchObject({ ok: false, blocked: true })
    expect(target.scrollIntoView).toHaveBeenCalledOnce()
  })

  it('rechecks generation after async settles before typing or opening a dropdown', async () => {
    const root = new FakeElement('HTML', '')
    root.setAttribute('data-alma-observation-id', 'dom-generation-1')
    const input = new FakeElement('INPUT', '')
    input.placeholder = 'Search'
    input.setAttribute('type', 'text')
    input.setAttribute('data-alma-ref', 'e1')
    input.setAttribute('data-alma-observation-id', 'dom-generation-1')
    const inputFingerprint = fingerprintOf(input)
    const inputDocument = {
      documentElement: root,
      querySelector: () => input,
      querySelectorAll: () => [],
      activeElement: null,
    }
    const pageType = runInNewContext(
      `(${sourceFunction('async function pageType', '\nasync function pageKey')})`,
      {
        document: inputDocument,
        window: {},
        String,
        JSON,
        Object,
        Math,
        chrome: activeRendererChrome(),
        setTimeout: (resolve: () => void) => {
          root.setAttribute('data-alma-observation-id', 'dom-generation-2')
          resolve()
        },
      },
    ) as (arg: Record<string, unknown>) => Promise<{ ok: boolean; blocked?: boolean }>
    await expect(pageType({
      ref: 'e1',
      value: 'requested song',
      domObservationId: 'dom-generation-1',
      refFingerprint: inputFingerprint,
      ...activeRendererAuthority(),
    })).resolves.toMatchObject({ ok: false, blocked: true })
    expect(input.value).toBe('')

    root.setAttribute('data-alma-observation-id', 'dom-generation-1')
    const trigger = new FakeElement('BUTTON', 'Choose song')
    trigger.setAttribute('role', 'combobox')
    trigger.setAttribute('data-alma-ref', 'e2')
    trigger.setAttribute('data-alma-observation-id', 'dom-generation-1')
    const pickOption = runInNewContext(
      `(${sourceFunction('async function pagePickOption', '\n// Put a real File')})`,
      {
        document: { documentElement: root, querySelector: () => trigger, querySelectorAll: () => [] },
        window: {},
        String,
        JSON,
        Math,
        chrome: activeRendererChrome(),
        setTimeout: (resolve: () => void) => {
          root.setAttribute('data-alma-observation-id', 'dom-generation-2')
          resolve()
        },
      },
    ) as (arg: Record<string, unknown>) => Promise<{ ok: boolean; blocked?: boolean }>
    await expect(pickOption({
      ref: 'e2',
      option: 'Requested result',
      domObservationId: 'dom-generation-1',
      refFingerprint: fingerprintOf(trigger),
      ...activeRendererAuthority(),
    })).resolves.toMatchObject({ ok: false, blocked: true })
    expect(trigger.click).not.toHaveBeenCalled()
  })

  it('blocks inside the click injection when navigation lands after the outer precheck', async () => {
    const root = new FakeElement('HTML', '')
    root.setAttribute('data-alma-observation-id', 'dom-generation-1')
    const button = new FakeElement('BUTTON', 'Play')
    button.setAttribute('role', 'button')
    button.setAttribute('data-alma-ref', 'e1')
    button.setAttribute('data-alma-observation-id', 'dom-generation-1')
    const pageClick = runInNewContext(
      `(${sourceFunction('async function pageClick', '\nasync function pageType')})`,
      {
        document: {
          documentElement: root,
          querySelector: () => button,
        },
        // The outer precheck observed /before; navigation lands before this
        // executeScript begins while the SPA preserves the stamped DOM node.
        location: { href: 'https://example.com/after' },
        performance: { timeOrigin: 1000 },
        String,
        JSON,
        Math,
        Promise,
        setTimeout,
        chrome: activeRendererChrome(),
      },
    ) as (arg: Record<string, unknown>) => Promise<{ ok: boolean; blocked?: boolean; error?: string }>

    await expect(pageClick({
      ref: 'e1',
      domObservationId: 'dom-generation-1',
      refFingerprint: fingerprintOf(button),
      expectedCurrentUrl: 'https://example.com/before',
      expectedDocumentId: '1000',
      ...activeRendererAuthority(),
    })).resolves.toMatchObject({
      ok: false,
      blocked: true,
      error: expect.stringContaining('observation_document_changed'),
    })
    expect(button.scrollIntoView).not.toHaveBeenCalled()
    expect(button.click).not.toHaveBeenCalled()
    expect(button.dispatchEvent).not.toHaveBeenCalled()
  })

  it('makes a pageClick injection that begins after its absolute deadline inert', async () => {
    const root = new FakeElement('HTML', '')
    root.setAttribute('data-alma-observation-id', 'dom-generation-1')
    const button = new FakeElement('BUTTON', 'Play')
    button.setAttribute('data-alma-ref', 'e1')
    button.setAttribute('data-alma-observation-id', 'dom-generation-1')
    const pageClick = runInNewContext(
      `(${sourceFunction('async function pageClick', '\nasync function pageType')})`,
      {
        document: { documentElement: root, querySelector: () => button },
        location: { href: 'https://example.com/current' },
        performance: { timeOrigin: 1000 },
        Date: { now: () => 5_001 },
        String,
        JSON,
        Math,
        Promise,
        setTimeout,
      },
    ) as (arg: Record<string, unknown>) => Promise<{ ok: boolean; blocked?: boolean; error?: string }>

    await expect(pageClick({
      ref: 'e1',
      domObservationId: 'dom-generation-1',
      refFingerprint: fingerprintOf(button),
      expectedCurrentUrl: 'https://example.com/current',
      expectedDocumentId: '1000',
      __almaDispatchGeneration: 7,
      __almaDispatchNonce: 'expired-command-nonce',
      __almaEffectDeadlineMs: 5_000,
    })).resolves.toMatchObject({
      ok: false,
      blocked: true,
      error: expect.stringContaining('command_effect_expired'),
    })
    expect(button.scrollIntoView).not.toHaveBeenCalled()
    expect(button.focus).not.toHaveBeenCalled()
    expect(button.click).not.toHaveBeenCalled()
    expect(button.dispatchEvent).not.toHaveBeenCalled()
  })

  it('makes a queued pageClick inert when it begins after Pause is acknowledged', async () => {
    const root = new FakeElement('HTML', '')
    root.setAttribute('data-alma-observation-id', 'dom-generation-1')
    const button = new FakeElement('BUTTON', 'Play')
    button.setAttribute('data-alma-ref', 'e1')
    button.setAttribute('data-alma-observation-id', 'dom-generation-1')
    const pageClick = runInNewContext(
      `(${sourceFunction('async function pageClick', '\nasync function pageType')})`,
      {
        document: { documentElement: root, querySelector: () => button },
        location: { href: 'https://example.com/current' },
        performance: { timeOrigin: 1000 },
        chrome: activeRendererChrome(7, 'queued-command-nonce', { paused: true }),
        Date: { now: () => 5_000 },
        String,
        JSON,
        Math,
        Promise,
        setTimeout,
      },
    ) as (arg: Record<string, unknown>) => Promise<{ ok: boolean; blocked?: boolean; error?: string }>

    await expect(pageClick({
      ref: 'e1',
      domObservationId: 'dom-generation-1',
      refFingerprint: fingerprintOf(button),
      expectedCurrentUrl: 'https://example.com/current',
      expectedDocumentId: '1000',
      __almaDispatchGeneration: 7,
      __almaDispatchNonce: 'queued-command-nonce',
      __almaEffectDeadlineMs: 40_000,
    })).resolves.toMatchObject({
      ok: false,
      blocked: true,
      error: expect.stringContaining('command_effect_expired'),
    })
    expect(button.scrollIntoView).not.toHaveBeenCalled()
    expect(button.focus).not.toHaveBeenCalled()
    expect(button.click).not.toHaveBeenCalled()
    expect(button.dispatchEvent).not.toHaveBeenCalled()
  })

  it('validates and starts receipt-bound navigation in one renderer task', async () => {
    const root = new FakeElement('HTML', '')
    root.setAttribute('data-alma-observation-id', 'dom-generation-1')
    const assign = vi.fn()
    const context = {
      document: { documentElement: root },
      location: { href: 'https://www.youtube.com/after', assign },
      performance: { timeOrigin: 1000 },
      String,
      Math,
      chrome: activeRendererChrome(),
    }
    const navigate = runInNewContext(
      `(${sourceFunction('async function pageNavigateAtomic', '\n// ---- command execution')})`,
      context,
    ) as (arg: Record<string, unknown>) => Promise<{ ok: boolean; blocked?: boolean }>

    // The outer precheck saw /before, but the renderer has since moved to
    // /after. The atomic page task must not overwrite the newer page.
    await expect(navigate({
      targetUrl: 'https://www.youtube.com/',
      expectedCurrentUrl: 'https://www.youtube.com/before',
      expectedDocumentId: '1000',
      domObservationId: 'dom-generation-1',
      ...activeRendererAuthority(),
    })).resolves.toMatchObject({ ok: false, blocked: true })
    expect(assign).not.toHaveBeenCalled()

    context.location.href = 'https://www.youtube.com/before'
    await expect(navigate({
      targetUrl: 'https://www.youtube.com/',
      expectedCurrentUrl: 'https://www.youtube.com/before',
      expectedDocumentId: '1000',
      domObservationId: 'dom-generation-1',
      ...activeRendererAuthority(),
    })).resolves.toMatchObject({ ok: true })
    expect(assign).toHaveBeenCalledOnce()
    expect(assign).toHaveBeenCalledWith('https://www.youtube.com/')
  })

  it('passes the URL and document identity into the page action arguments', async () => {
    let received: Record<string, unknown> | null = null
    const actWithRetry = runInNewContext(
      `(${sourceFunction('async function actWithRetry', '\nasync function verifyObservationPrecondition')})`,
      {
        runInPage: async (_tabId: number, _func: unknown, arg: Record<string, unknown>) => {
          received = arg
          return { ok: false, blocked: true, error: 'stop after capture' }
        },
        runInAllFrames: vi.fn(),
        verifyObservationPrecondition: async () => ({ ok: true }),
        Boolean,
        String,
        setTimeout,
      },
    ) as (
      tabId: number,
      func: () => unknown,
      arg: Record<string, unknown>,
      precondition: Record<string, unknown>,
      isCurrent: () => boolean,
      authority: { dispatchGeneration: number; dispatchNonce: string; deadlineMs: number },
    ) => Promise<{ ok: boolean }>

    await actWithRetry(7, () => undefined, { ref: 'e1' }, {
      currentUrl: 'https://example.com/before',
      documentId: '1000',
      domObservationId: 'dom-generation-1',
      refFingerprints: { e1: 'fingerprint-1' },
    }, () => true, {
      dispatchGeneration: 1,
      dispatchNonce: 'test-command-nonce',
      deadlineMs: Date.now() + 60_000,
    })
    expect(received).toMatchObject({
      expectedCurrentUrl: 'https://example.com/before',
      expectedDocumentId: '1000',
      domObservationId: 'dom-generation-1',
      refFingerprint: 'fingerprint-1',
    })
  })

  it('never retries a click whose page dispatch times out after a possible effect', async () => {
    const runInPage = vi.fn(async () => ({
      ok: false,
      error: 'step_timeout: page script (15000ms)',
    }))
    const runInAllFrames = vi.fn()
    const actWithRetry = runInNewContext(
      `(${sourceFunction('async function actWithRetry', '\nasync function verifyObservationPrecondition')})`,
      {
        runInPage,
        runInAllFrames,
        verifyObservationPrecondition: vi.fn(),
        Boolean,
        String,
        setTimeout,
      },
    ) as (
      tabId: number,
      func: () => unknown,
      arg: Record<string, unknown>,
      precondition: null,
      isCurrent: () => boolean,
      authority: { dispatchGeneration: number; dispatchNonce: string; deadlineMs: number },
    ) => Promise<{ ok: boolean; error: string }>

    await expect(actWithRetry(7, () => undefined, { ref: 'e1' }, null, () => true, {
      dispatchGeneration: 1,
      dispatchNonce: 'test-command-nonce',
      deadlineMs: Date.now() + 60_000,
    })).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining('step_timeout'),
    })
    expect(runInPage).toHaveBeenCalledOnce()
    expect(runInAllFrames).not.toHaveBeenCalled()
  })

  it('brackets screenshots with the exact URL/document and discards changed captures', async () => {
    type Identity = { url: string; documentId: string }
    type Result = { ok: boolean; blocked?: boolean; error?: string; screenshot?: string }
    const expected: Identity = {
      url: 'https://www.youtube.com/watch?v=abcDEF_1234',
      documentId: '9000',
    }
    const makeCapture = (identities: Array<Identity | null>) => {
      const runInPage = vi.fn(async () => identities.shift() ?? null)
      const captureAgentTab = vi.fn(async () => 'data:image/jpeg;base64,secret-page-bytes')
      const capture = runInNewContext(
        `(${sourceFunction(
          'async function captureExactObservedScreenshot',
          '\nfunction poisonDebuggerAndReload',
        )})`,
        {
          runInPage,
          pageObservationIdentity: () => undefined,
          captureAgentTab,
          COMMAND_CAPTURE_CALL_TIMEOUT_MS: 15_000,
          URL,
          String,
          Boolean,
        },
      ) as (
        tab: { id: number },
        cmd: Record<string, unknown>,
        isCurrent?: () => boolean,
      ) => Promise<Result>
      return { capture, runInPage, captureAgentTab }
    }

    const partial = makeCapture([expected])
    await expect(partial.capture({ id: 7 }, {
      expectedCurrentUrl: expected.url,
    })).resolves.toMatchObject({
      ok: false,
      blocked: true,
      error: expect.stringContaining('precondition_missing'),
    })
    expect(partial.runInPage).not.toHaveBeenCalled()
    expect(partial.captureAgentTab).not.toHaveBeenCalled()

    const legacy = makeCapture([])
    await expect(legacy.capture({ id: 7 }, {})).resolves.toEqual({
      ok: true,
      screenshot: 'data:image/jpeg;base64,secret-page-bytes',
    })
    expect(legacy.runInPage).not.toHaveBeenCalled()
    expect(legacy.captureAgentTab).toHaveBeenCalledOnce()

    const changedBefore = makeCapture([{ ...expected, documentId: 'new-document' }])
    const beforeResult = await changedBefore.capture({ id: 7 }, {
      expectedCurrentUrl: expected.url,
      expectedDocumentId: expected.documentId,
      requiredHost: 'youtube.com',
    })
    expect(beforeResult).toMatchObject({ ok: false, blocked: true })
    expect(beforeResult).not.toHaveProperty('screenshot')
    expect(changedBefore.captureAgentTab).not.toHaveBeenCalled()

    const changedAfter = makeCapture([
      expected,
      { url: 'https://www.youtube.com/watch?v=otherVID001', documentId: '9001' },
    ])
    const afterResult = await changedAfter.capture({ id: 7 }, {
      expectedCurrentUrl: expected.url,
      expectedDocumentId: expected.documentId,
      requiredHost: 'youtube.com',
    })
    expect(afterResult).toMatchObject({
      ok: false,
      blocked: true,
      error: expect.stringContaining('discarded'),
    })
    expect(afterResult).not.toHaveProperty('screenshot')
    expect(changedAfter.captureAgentTab).toHaveBeenCalledOnce()

    const exact = makeCapture([expected, expected])
    await expect(exact.capture({ id: 7 }, {
      expectedCurrentUrl: expected.url,
      expectedDocumentId: expected.documentId,
      requiredHost: 'youtube.com',
    })).resolves.toEqual({
      ok: true,
      screenshot: 'data:image/jpeg;base64,secret-page-bytes',
    })
    expect(exact.runInPage).toHaveBeenCalledTimes(2)
    expect(exact.captureAgentTab).toHaveBeenCalledOnce()
  })
})
