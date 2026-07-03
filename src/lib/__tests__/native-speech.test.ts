import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock the native App plugin + platform detector BEFORE importing the module under test.
const mockApp = vi.hoisted(() => ({ getInfo: vi.fn() }))
vi.mock('@capacitor/app', () => ({ App: mockApp }))

const mockNative = vi.hoisted(() => ({ isCapacitorNative: vi.fn() }))
vi.mock('@/lib/capacitor-native', () => mockNative)

import { maybeTranscribeOnDevice, isNativeSttEnabled, setNativeSttEnabled } from '@/lib/native-speech'

// The NativeSpeechBridge plugin is registered NATIVELY at runtime (no npm package)
// as window.Capacitor.Plugins.NativeSpeechBridge — stub it on a fake window.
const mockBridge = {
  availability: vi.fn().mockResolvedValue({ available: true }),
  transcribe: vi.fn().mockResolvedValue({ text: 'আমার অর্ডার কই', onDevice: true }),
}

// A tiny in-memory localStorage so the flag helpers work under node.
function installLocalStorage(initial: Record<string, string> = {}) {
  const store = new Map<string, string>(Object.entries(initial))
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  })
}

function installWindowWithBridge(bridge: unknown = mockBridge) {
  vi.stubGlobal('window', { Capacitor: { Plugins: { NativeSpeechBridge: bridge } }, btoa: (s: string) => Buffer.from(s, 'binary').toString('base64') })
  vi.stubGlobal('btoa', (s: string) => Buffer.from(s, 'binary').toString('base64'))
}

function installWindowWithoutBridge() {
  vi.stubGlobal('window', { Capacitor: { Plugins: {} } })
  vi.stubGlobal('btoa', (s: string) => Buffer.from(s, 'binary').toString('base64'))
}

function buildOk(build = 10) {
  mockApp.getInfo.mockResolvedValue({ build: String(build) })
}

/** A fake audio blob with a real arrayBuffer(). */
function fakeBlob(bytes = 2048): Blob {
  const data = new Uint8Array(bytes)
  return {
    size: bytes,
    type: 'audio/m4a',
    arrayBuffer: async () => data.buffer,
  } as unknown as Blob
}

describe('native-speech — native + build(≥10) + flag + availability gated, fail-open', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.unstubAllGlobals()
    mockNative.isCapacitorNative.mockReturnValue(true)
    buildOk(10)
    mockBridge.availability.mockResolvedValue({ available: true })
    mockBridge.transcribe.mockResolvedValue({ text: 'আমার অর্ডার কই', onDevice: true })
    installLocalStorage({ alma_native_stt: '1' }) // opted in
    installWindowWithBridge()
  })

  it('happy path — returns the on-device transcript', async () => {
    const text = await maybeTranscribeOnDevice(fakeBlob(), 'bn-BD')
    expect(text).toBe('আমার অর্ডার কই')
    expect(mockBridge.transcribe).toHaveBeenCalledTimes(1)
    expect(mockBridge.transcribe.mock.calls[0][0]).toMatchObject({ locale: 'bn-BD' })
    expect(typeof mockBridge.transcribe.mock.calls[0][0].audioBase64).toBe('string')
  })

  it('null (fall back to Whisper) when the flag is OFF — never probes the plugin', async () => {
    installLocalStorage({}) // not opted in
    const text = await maybeTranscribeOnDevice(fakeBlob())
    expect(text).toBeNull()
    expect(mockApp.getInfo).not.toHaveBeenCalled()
    expect(mockBridge.transcribe).not.toHaveBeenCalled()
  })

  it('null off native', async () => {
    mockNative.isCapacitorNative.mockReturnValue(false)
    expect(await maybeTranscribeOnDevice(fakeBlob())).toBeNull()
    expect(mockBridge.transcribe).not.toHaveBeenCalled()
  })

  it('null on an old binary (build < 10)', async () => {
    buildOk(9)
    expect(await maybeTranscribeOnDevice(fakeBlob())).toBeNull()
    expect(mockBridge.transcribe).not.toHaveBeenCalled()
  })

  it('null when the plugin is absent', async () => {
    installWindowWithoutBridge()
    expect(await maybeTranscribeOnDevice(fakeBlob())).toBeNull()
  })

  it('null when the recognizer reports unavailable', async () => {
    mockBridge.availability.mockResolvedValue({ available: false })
    expect(await maybeTranscribeOnDevice(fakeBlob())).toBeNull()
    expect(mockBridge.transcribe).not.toHaveBeenCalled()
  })

  it('null when on-device returns onDevice:false or empty text', async () => {
    mockBridge.transcribe.mockResolvedValue({ text: '', onDevice: false, reason: 'empty_output' })
    expect(await maybeTranscribeOnDevice(fakeBlob())).toBeNull()
  })

  it('null (never throws) when the plugin rejects', async () => {
    mockBridge.transcribe.mockRejectedValueOnce(new Error('recognizer blew up'))
    await expect(maybeTranscribeOnDevice(fakeBlob())).resolves.toBeNull()
  })
})

describe('native-speech flag helpers', () => {
  beforeEach(() => {
    vi.unstubAllGlobals()
    installLocalStorage({})
  })

  it('defaults OFF, and set/read round-trips', () => {
    expect(isNativeSttEnabled()).toBe(false)
    setNativeSttEnabled(true)
    expect(isNativeSttEnabled()).toBe(true)
    setNativeSttEnabled(false)
    expect(isNativeSttEnabled()).toBe(false)
  })
})
