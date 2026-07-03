import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock the native App plugin + platform detector BEFORE importing the module under test.
const mockApp = vi.hoisted(() => ({ getInfo: vi.fn() }))
vi.mock('@capacitor/app', () => ({ App: mockApp }))

const mockNative = vi.hoisted(() => ({ isCapacitorNative: vi.fn() }))
vi.mock('@/lib/capacitor-native', () => mockNative)

import { summarizeText, classifyText, nativeIntelligenceAvailable } from '@/lib/native-intelligence'

// The NativeIntelligenceBridge plugin is registered NATIVELY at runtime (no npm
// package) as window.Capacitor.Plugins.NativeIntelligenceBridge — so we stub it on
// a fake window/Capacitor rather than mocking a module.
const mockBridge = {
  availability: vi.fn().mockResolvedValue({ available: true, reason: 'available' }),
  summarize: vi.fn().mockResolvedValue({ summary: 'on-device summary', onDevice: true }),
  classify: vi.fn().mockResolvedValue({ label: 'urgent', onDevice: true }),
}

function installWindowWithBridge(bridge: unknown = mockBridge) {
  vi.stubGlobal('window', {
    Capacitor: { Plugins: { NativeIntelligenceBridge: bridge } },
  })
}

/** Install a window whose Capacitor.Plugins does NOT include the bridge. */
function installWindowWithoutBridge() {
  vi.stubGlobal('window', { Capacitor: { Plugins: {} } })
}

function buildOk(build = 9) {
  mockApp.getInfo.mockResolvedValue({ build: String(build) })
}

const serverSummary = () => Promise.resolve('server summary')
const serverLabel = () => Promise.resolve('normal')

describe('native-intelligence — native-only, build-gated (≥9), plugin-detected, fail-open', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.unstubAllGlobals()
    mockNative.isCapacitorNative.mockReturnValue(true)
    buildOk(9)
    mockBridge.availability.mockResolvedValue({ available: true, reason: 'available' })
    mockBridge.summarize.mockResolvedValue({ summary: 'on-device summary', onDevice: true })
    mockBridge.classify.mockResolvedValue({ label: 'urgent', onDevice: true })
    installWindowWithBridge()
  })

  describe('summarizeText', () => {
    it('happy path — runs on-device, never calls the server fallback', async () => {
      const fallback = vi.fn(serverSummary)
      const res = await summarizeText('long order note', { maxWords: 20, serverFallback: fallback })
      expect(res).toEqual({ summary: 'on-device summary', onDevice: true })
      expect(mockBridge.summarize).toHaveBeenCalledWith({ text: 'long order note', maxWords: 20 })
      expect(fallback).not.toHaveBeenCalled()
    })

    it('defaults maxWords to 40 when not provided', async () => {
      await summarizeText('note', { serverFallback: serverSummary })
      expect(mockBridge.summarize).toHaveBeenCalledWith({ text: 'note', maxWords: 40 })
    })

    it('falls back to server off native', async () => {
      mockNative.isCapacitorNative.mockReturnValue(false)
      const fallback = vi.fn(serverSummary)
      const res = await summarizeText('note', { serverFallback: fallback })
      expect(res).toEqual({ summary: 'server summary', onDevice: false })
      expect(mockApp.getInfo).not.toHaveBeenCalled()
      expect(mockBridge.summarize).not.toHaveBeenCalled()
      expect(fallback).toHaveBeenCalledTimes(1)
    })

    it('falls back to server on an old binary (build < 9)', async () => {
      buildOk(8)
      const res = await summarizeText('note', { serverFallback: serverSummary })
      expect(res.onDevice).toBe(false)
      expect(res.summary).toBe('server summary')
      expect(mockBridge.summarize).not.toHaveBeenCalled()
    })

    it('falls back when the plugin is absent', async () => {
      installWindowWithoutBridge()
      const res = await summarizeText('note', { serverFallback: serverSummary })
      expect(res.onDevice).toBe(false)
      expect(mockBridge.summarize).not.toHaveBeenCalled()
    })

    it('falls back when the model reports unavailable', async () => {
      mockBridge.availability.mockResolvedValue({ available: false, reason: 'model_not_ready' })
      const res = await summarizeText('note', { serverFallback: serverSummary })
      expect(res).toEqual({ summary: 'server summary', onDevice: false })
      expect(mockBridge.summarize).not.toHaveBeenCalled()
    })

    it('falls back when on-device returns onDevice:false or empty', async () => {
      mockBridge.summarize.mockResolvedValue({ summary: '', onDevice: false, reason: 'empty_output' })
      const res = await summarizeText('note', { serverFallback: serverSummary })
      expect(res).toEqual({ summary: 'server summary', onDevice: false })
    })

    it('falls back (never throws) when the plugin rejects', async () => {
      mockBridge.summarize.mockRejectedValueOnce(new Error('model exploded'))
      const res = await summarizeText('note', { serverFallback: serverSummary })
      expect(res).toEqual({ summary: 'server summary', onDevice: false })
    })
  })

  describe('classifyText', () => {
    it('happy path — on-device label that is in the list', async () => {
      const fallback = vi.fn(serverLabel)
      const res = await classifyText('help my order is late!', ['urgent', 'normal'], {
        serverFallback: fallback,
      })
      expect(res).toEqual({ label: 'urgent', onDevice: true })
      expect(fallback).not.toHaveBeenCalled()
    })

    it('falls back when the model returns an off-list label', async () => {
      mockBridge.classify.mockResolvedValue({ label: 'somethingelse', onDevice: true })
      const res = await classifyText('text', ['urgent', 'normal'], { serverFallback: serverLabel })
      expect(res).toEqual({ label: 'normal', onDevice: false })
    })

    it('falls back (no native call) when labels is empty', async () => {
      const res = await classifyText('text', [], { serverFallback: serverLabel })
      expect(res).toEqual({ label: 'normal', onDevice: false })
      expect(mockBridge.classify).not.toHaveBeenCalled()
    })

    it('falls back (never throws) when the plugin rejects', async () => {
      mockBridge.classify.mockRejectedValueOnce(new Error('boom'))
      const res = await classifyText('text', ['urgent', 'normal'], { serverFallback: serverLabel })
      expect(res).toEqual({ label: 'normal', onDevice: false })
    })
  })

  describe('nativeIntelligenceAvailable', () => {
    it('true when native, gated, plugin present, model available', async () => {
      expect(await nativeIntelligenceAvailable()).toBe(true)
    })

    it('false off native', async () => {
      mockNative.isCapacitorNative.mockReturnValue(false)
      expect(await nativeIntelligenceAvailable()).toBe(false)
    })

    it('false when getInfo build is unreadable', async () => {
      mockApp.getInfo.mockResolvedValue({ build: 'not-a-number' })
      expect(await nativeIntelligenceAvailable()).toBe(false)
    })

    it('false when availability() rejects (fail-open)', async () => {
      mockBridge.availability.mockRejectedValueOnce(new Error('bridge error'))
      expect(await nativeIntelligenceAvailable()).toBe(false)
    })
  })
})
