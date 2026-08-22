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

type CommandResult = {
  ok: boolean
  blocked?: boolean
  error?: string
}

function authorizationResponse(
  body: Record<string, unknown>,
  options: { ok?: boolean; status?: number } = {},
) {
  return {
    ok: options.ok ?? true,
    status: options.status ?? 200,
    json: async () => body,
  }
}

function dispatchFixture(options: {
  paused?: boolean[]
  currentToken?: () => string
  fetchImpl?: () => Promise<ReturnType<typeof authorizationResponse>>
} = {}) {
  const pauseStates = [...(options.paused ?? [false, false])]
  const storageGet = vi.fn(async (key: string) => {
    if (key === 'token') return { token: options.currentToken?.() ?? 'device-token' }
    return { paused: pauseStates.shift() ?? false }
  })
  const storageSet = vi.fn(async (_value: Record<string, unknown>) => undefined)
  const stopPreviewCapture = vi.fn()
  const executeCommand = vi.fn(async (
    _command: Record<string, unknown>,
    _isCurrent?: () => boolean,
    _authority?: Record<string, unknown>,
  ) => ({
    ok: true,
    data: { executed: true },
  }))
  const fetchMock = vi.fn(options.fetchImpl ?? (async () => authorizationResponse({ authorized: true })))
  const dispatchApi = runInNewContext(
    `(() => {
      ${sourceFunction('async function commandDispatchPaused', '\nasync function pollOnce')}
      return { dispatch: dispatchAuthorizedPolledCommand, revoke: revokeCommandDispatchAuthority }
    })()`,
    {
      chrome: { storage: { local: { get: storageGet, set: storageSet } } },
      stopPreviewCapture,
      fetch: fetchMock,
      withTimeout: async (promise: Promise<unknown>) => await promise,
      executeCommand,
      AUTHORIZE_PATH: '/api/assistant/live-browser/authorize',
      COMMAND_AUTHORIZATION_TIMEOUT_MS: 5_000,
      COMMAND_EXECUTION_TIMEOUT_MS: 35_000,
      Date,
      Number,
      Boolean,
      JSON,
      String,
    },
  ) as {
    dispatch: (
      baseUrl: string,
      token: string,
      command: Record<string, unknown>,
      isCurrent?: () => boolean,
    ) => Promise<CommandResult>
    revoke: () => Promise<boolean>
  }

  return {
    dispatch: dispatchApi.dispatch,
    revoke: dispatchApi.revoke,
    storageGet,
    storageSet,
    stopPreviewCapture,
    executeCommand,
    fetchMock,
  }
}

describe('Companion two-phase command dispatch authorization', () => {
  it('does not execute a command denied after Stop', async () => {
    const fixture = dispatchFixture({
      paused: [false],
      fetchImpl: async () => authorizationResponse({
        authorized: false,
        reason: 'TURN_STOPPED',
      }),
    })

    await expect(fixture.dispatch(
      'https://alma.example',
      'device-token',
      { id: 'command-stop-1', action: 'click' },
    )).resolves.toMatchObject({
      ok: false,
      blocked: true,
      error: expect.stringContaining('command_authorization_denied'),
    })
    expect(fixture.executeCommand).not.toHaveBeenCalled()
  })

  it('executes an authorized command exactly once with device authentication', async () => {
    const fixture = dispatchFixture()
    const command = { id: 'command-ok-1', action: 'click', ref: 'e1' }

    await expect(fixture.dispatch(
      'https://alma.example',
      'device-token',
      command,
    )).resolves.toMatchObject({ ok: true })

    expect(fixture.fetchMock).toHaveBeenCalledOnce()
    expect(fixture.fetchMock).toHaveBeenCalledWith(
      'https://alma.example/api/assistant/live-browser/authorize',
      expect.objectContaining({
        method: 'POST',
        cache: 'no-store',
        credentials: 'omit',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer device-token',
        },
        body: JSON.stringify({ commandId: 'command-ok-1' }),
      }),
    )
    expect(fixture.executeCommand).toHaveBeenCalledOnce()
    expect(fixture.executeCommand.mock.calls[0]?.[0]).toEqual(command)
    const durableLease = fixture.storageSet.mock.calls.find(([value]) => (
      typeof value?.commandDispatchNonce === 'string' && Boolean(value.commandDispatchNonce)
    ))?.[0]
    expect(durableLease).toEqual(expect.objectContaining({
      commandDispatchGeneration: expect.any(Number),
      commandDispatchNonce: expect.any(String),
    }))
    expect(fixture.executeCommand.mock.calls[0]?.[2]).toEqual(expect.objectContaining({
      dispatchGeneration: durableLease?.commandDispatchGeneration,
      dispatchNonce: durableLease?.commandDispatchNonce,
      deadlineMs: expect.any(Number),
    }))
    expect(fixture.storageGet).toHaveBeenCalledTimes(4)
  })

  it('fails closed with zero effect when authorization has a network error', async () => {
    const fixture = dispatchFixture({
      paused: [false],
      fetchImpl: async () => { throw new Error('network unavailable') },
    })

    const result = await fixture.dispatch(
      'https://alma.example',
      'device-token',
      { id: 'command-network-1', action: 'type' },
    )
    expect(result).toMatchObject({
      ok: false,
      blocked: true,
      error: expect.stringContaining('command_authorization_failed'),
    })
    expect(fixture.executeCommand).not.toHaveBeenCalled()
  })

  it('rechecks Pause after authorization and before the first effect', async () => {
    const fixture = dispatchFixture({ paused: [false, true] })

    await expect(fixture.dispatch(
      'https://alma.example',
      'device-token',
      { id: 'command-pause-race-1', action: 'navigate' },
    )).resolves.toMatchObject({
      ok: false,
      blocked: true,
      error: expect.stringContaining('command_dispatch_paused'),
    })
    expect(fixture.fetchMock).toHaveBeenCalledOnce()
    expect(fixture.executeCommand).not.toHaveBeenCalled()
    expect(fixture.stopPreviewCapture).toHaveBeenCalledOnce()
  })

  it('blocks with zero effect when Unpair removes the captured token during authorization', async () => {
    let currentToken = 'device-token'
    let resolveAuthorization:
      | ((value: ReturnType<typeof authorizationResponse>) => void)
      | undefined
    const fixture = dispatchFixture({
      currentToken: () => currentToken,
      fetchImpl: () => new Promise((resolve) => {
        resolveAuthorization = resolve
      }),
    })

    const pendingDispatch = fixture.dispatch(
      'https://alma.example',
      'device-token',
      { id: 'command-unpair-race-1', action: 'click' },
    )
    await vi.waitFor(() => expect(fixture.fetchMock).toHaveBeenCalledOnce())

    currentToken = ''
    resolveAuthorization?.(authorizationResponse({ authorized: true }))

    await expect(pendingDispatch).resolves.toMatchObject({
      ok: false,
      blocked: true,
      error: expect.stringContaining('command_dispatch_unpaired'),
    })
    expect(fixture.executeCommand).not.toHaveBeenCalled()
  })

  it('rejects the captured command generation when Pause is observed during authorization', async () => {
    let resolveAuthorization:
      | ((value: ReturnType<typeof authorizationResponse>) => void)
      | undefined
    const fixture = dispatchFixture({
      fetchImpl: () => new Promise((resolve) => {
        resolveAuthorization = resolve
      }),
    })
    const pending = fixture.dispatch(
      'https://alma.example',
      'device-token',
      { id: 'command-generation-race-1', action: 'click' },
    )
    await vi.waitFor(() => expect(fixture.fetchMock).toHaveBeenCalledOnce())

    await fixture.revoke()
    resolveAuthorization?.(authorizationResponse({ authorized: true }))

    await expect(pending).resolves.toMatchObject({
      ok: false,
      blocked: true,
      error: expect.stringContaining('command_authorization_expired'),
    })
    expect(fixture.executeCommand).not.toHaveBeenCalled()
  })

  it('blocks a command when Pause lands while the long-poll response is delayed', async () => {
    let paused = false
    let resolvePoll: ((value: ReturnType<typeof authorizationResponse>) => void) | undefined
    const pollFetch = vi.fn(() => new Promise<ReturnType<typeof authorizationResponse>>((resolve) => {
      resolvePoll = resolve
    }))
    const executeCommand = vi.fn()
    const dispatchAuthorizedPolledCommand = vi.fn(async (
      _baseUrl: string,
      _token: string,
      command: Record<string, unknown>,
    ) => executeCommand(command))
    const postResult = vi.fn(async () => true)
    const stopPreviewCapture = vi.fn()
    const applyPreviewGrant = vi.fn()
    const pollOnce = runInNewContext(
      `(${sourceFunction('async function pollOnce', '\nasync function loop')})`,
      {
        getConfig: async () => ({
          baseUrl: 'https://alma.example',
          token: 'device-token',
          paused: false,
        }),
        flushPendingResult: async () => true,
        reloadPending: false,
        applyPendingReloadIfQuiescent: vi.fn(),
        fetch: pollFetch,
        POLL_PATH: '/api/assistant/live-browser/poll',
        COMPANION_PROTOCOL: 'authorize-v1',
        commandDispatchPaused: async () => paused,
        stopPreviewCapture,
        applyPreviewGrant,
        chrome: { storage: { local: { set: vi.fn(async () => undefined) } } },
        commandInFlight: false,
        setBadge: vi.fn(async () => undefined),
        dispatchAuthorizedPolledCommand,
        postResult,
        Date,
        String,
      },
    ) as () => Promise<string>

    const pendingPoll = pollOnce()
    await vi.waitFor(() => expect(pollFetch).toHaveBeenCalledOnce())
    expect(pollFetch).toHaveBeenCalledWith(
      'https://alma.example/api/assistant/live-browser/poll',
      expect.objectContaining({
        headers: {
          Authorization: 'Bearer device-token',
          'X-ALMA-Companion-Protocol': 'authorize-v1',
        },
      }),
    )
    paused = true
    resolvePoll?.(authorizationResponse({
      command: { id: 'command-delayed-pause-1', action: 'click' },
      preview: { active: true },
    }))

    await expect(pendingPoll).resolves.toBe('stop')
    expect(dispatchAuthorizedPolledCommand).not.toHaveBeenCalled()
    expect(executeCommand).not.toHaveBeenCalled()
    expect(applyPreviewGrant).not.toHaveBeenCalled()
    expect(stopPreviewCapture).toHaveBeenCalled()
    expect(postResult).toHaveBeenCalledWith(
      'https://alma.example',
      'device-token',
      'command-delayed-pause-1',
      expect.objectContaining({
        ok: false,
        blocked: true,
        error: expect.stringContaining('command_dispatch_paused'),
      }),
    )
  })

  function delayedOverlayExecutionFixture() {
    let resolveOverlay: (() => void) | undefined
    let now = 1_000
    const showOverlay = vi.fn(() => new Promise<void>((resolve) => {
      resolveOverlay = resolve
    }))
    const actWithRetry = vi.fn(async () => ({ ok: true }))
    const execute = runInNewContext(
      `(${sourceFunction('async function executeCommand', '\n// ---- poll loop')})`,
      {
        ALLOWED_ACTIONS: new Set(['click']),
        WRITE_VERBS: new Set(['click']),
        RECEIPT_REF_ACTIONS: new Set(['click']),
        getAgentTab: async () => ({ id: 7, active: true, url: 'https://example.com/' }),
        showOverlay,
        actWithRetry,
        pageClick: () => undefined,
        lockdownMatch: () => null,
        Date: { now: () => now },
        Number,
        String,
        Boolean,
      },
    ) as (
      command: Record<string, unknown>,
      isCurrent: () => boolean,
      authority: { dispatchGeneration: number; dispatchNonce: string; deadlineMs: number },
    ) => Promise<CommandResult>
    return {
      execute,
      showOverlay,
      actWithRetry,
      resolveOverlay: () => resolveOverlay?.(),
      setNow: (value: number) => { now = value },
    }
  }

  it('does not continue from a late overlay into pageClick after the effect deadline', async () => {
    const fixture = delayedOverlayExecutionFixture()
    const pending = fixture.execute(
      { id: 'command-overlay-timeout-1', action: 'click', text: 'Play' },
      () => true,
      { dispatchGeneration: 4, dispatchNonce: 'overlay-timeout-nonce', deadlineMs: 1_100 },
    )
    await vi.waitFor(() => expect(fixture.showOverlay).toHaveBeenCalledOnce())

    fixture.setNow(1_101)
    fixture.resolveOverlay()

    await expect(pending).resolves.toMatchObject({
      ok: false,
      blocked: true,
      error: expect.stringContaining('command_effect_expired'),
    })
    expect(fixture.actWithRetry).not.toHaveBeenCalled()
  })

  it('does not mutate when Pause revokes the generation during a pre-effect await', async () => {
    const fixture = delayedOverlayExecutionFixture()
    let liveGeneration = 5
    const capturedGeneration = liveGeneration
    const pending = fixture.execute(
      { id: 'command-overlay-pause-1', action: 'click', text: 'Play' },
      () => liveGeneration === capturedGeneration,
      { dispatchGeneration: capturedGeneration, dispatchNonce: 'overlay-pause-nonce', deadlineMs: 2_000 },
    )
    await vi.waitFor(() => expect(fixture.showOverlay).toHaveBeenCalledOnce())

    liveGeneration++
    fixture.resolveOverlay()

    await expect(pending).resolves.toMatchObject({
      ok: false,
      blocked: true,
      error: expect.stringContaining('command_effect_expired'),
    })
    expect(fixture.actWithRetry).not.toHaveBeenCalled()
  })
})

describe('Companion local Pause/Unpair preview revocation', () => {
  it('classifies Pause-on and Unpair as synchronous preview revocations', () => {
    const predicate = runInNewContext(
      `(${sourceFunction('function localMessageRevokesPreview', '\nfunction handleLocalStorageAuthorityChange')})`,
      { Boolean },
    ) as (message: Record<string, unknown>) => boolean

    expect(predicate({ type: 'setPaused', paused: true })).toBe(true)
    expect(predicate({ type: 'unpair' })).toBe(true)
    expect(predicate({ type: 'setPaused', paused: false })).toBe(false)
  })

  it('stops an active preview when storage records Pause or token removal', () => {
    const stopPreviewCapture = vi.fn()
    const revokeCommandDispatchAuthority = vi.fn(async () => true)
    const loop = vi.fn()
    const handler = runInNewContext(
      `(${sourceFunction('function handleLocalStorageAuthorityChange', '\n\nchrome.storage.onChanged')})`,
      { stopPreviewCapture, revokeCommandDispatchAuthority, loop, Boolean },
    ) as (changes: Record<string, { newValue?: unknown }>) => void

    handler({ paused: { newValue: true } })
    handler({ token: { newValue: '' } })

    expect(stopPreviewCapture).toHaveBeenCalledTimes(2)
    expect(revokeCommandDispatchAuthority).toHaveBeenCalledTimes(2)
    expect(loop).toHaveBeenCalledTimes(2)
  })

  function unpairFixture(response: ReturnType<typeof authorizationResponse>) {
    const set = vi.fn(async () => undefined)
    const remove = vi.fn(async () => undefined)
    const fetchMock = vi.fn(async () => response)
    const revokeCommandDispatchAuthority = vi.fn()
    const unpair = runInNewContext(
      `(${sourceFunction('async function unpairFromServer', '\n\n// If the owner closes')})`,
      {
        getConfig: async () => ({
          baseUrl: 'https://alma.example',
          token: 'device-token',
        }),
        chrome: { storage: { local: { set, remove } } },
        setBadge: vi.fn(async () => undefined),
        withTimeout: async (promise: Promise<unknown>) => await promise,
        fetch: fetchMock,
        UNPAIR_PATH: '/api/assistant/live-browser/unpair',
        PENDING_RESULT_KEY: 'pendingCommandResult',
        COMMAND_AUTHORIZATION_TIMEOUT_MS: 5_000,
        revokeCommandDispatchAuthority,
        commandDispatchGeneration: 7,
        String,
      },
    ) as () => Promise<{ ok: boolean; revoked?: boolean; stopping?: boolean }>
    return { unpair, set, remove, fetchMock, revokeCommandDispatchAuthority }
  }

  it('clears the local token only after the server confirms bearer revocation', async () => {
    const fixture = unpairFixture(authorizationResponse({ ok: true, revoked: true }))

    await expect(fixture.unpair()).resolves.toEqual({ ok: true, revoked: true })
    expect(fixture.revokeCommandDispatchAuthority).toHaveBeenCalledOnce()
    expect(fixture.set).toHaveBeenCalledWith(expect.objectContaining({
      paused: true,
      commandDispatchGeneration: 7,
      commandDispatchNonce: '',
    }))
    expect(fixture.fetchMock).toHaveBeenCalledWith(
      'https://alma.example/api/assistant/live-browser/unpair',
      expect.objectContaining({
        credentials: 'omit',
        headers: { Authorization: 'Bearer device-token' },
      }),
    )
    expect(fixture.set).toHaveBeenLastCalledWith({ token: '', paused: true, lastError: '' })
    expect(fixture.remove).toHaveBeenCalledWith('pendingCommandResult')
  })

  it('stays paired but paused when an authorized step makes Unpair pending', async () => {
    const fixture = unpairFixture(authorizationResponse(
      { ok: false, stopping: true, inFlightEffects: 1 },
      { ok: true, status: 202 },
    ))

    await expect(fixture.unpair()).resolves.toMatchObject({ ok: false, stopping: true })
    expect(fixture.set).not.toHaveBeenCalledWith(expect.objectContaining({ token: '' }))
    expect(fixture.set).toHaveBeenCalledWith(expect.objectContaining({ lastError: expect.any(String) }))
  })
})
