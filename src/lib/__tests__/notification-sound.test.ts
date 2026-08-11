import { beforeEach, describe, expect, it, vi } from 'vitest'

const native = vi.hoisted(() => ({ value: false }))

vi.mock('@/lib/capacitor-native', () => ({
  isCapacitorNative: () => native.value,
}))

describe('notification sound native-shell boundary', () => {
  beforeEach(() => {
    native.value = false
    vi.resetModules()
  })

  it('never constructs HTMLAudio inside the retained Capacitor shell', async () => {
    native.value = true
    const Audio = vi.fn()
    vi.stubGlobal('window', { location: { origin: 'https://example.test' } })
    vi.stubGlobal('Audio', Audio)

    const { playAlmaNotificationSound, webNotificationAudioAllowed } = await import('@/lib/notification-sound')
    expect(webNotificationAudioAllowed()).toBe(false)
    playAlmaNotificationSound()

    expect(Audio).not.toHaveBeenCalled()
    vi.unstubAllGlobals()
  })

  it('keeps the browser/PWA sound path available outside native', async () => {
    const play = vi.fn().mockResolvedValue(undefined)
    const Audio = vi.fn(function AudioMock() {
      return { currentTime: 0, preload: '', play }
    })
    vi.stubGlobal('window', { location: { origin: 'https://example.test' } })
    vi.stubGlobal('Audio', Audio)

    const { playAlmaNotificationSound, webNotificationAudioAllowed } = await import('@/lib/notification-sound')
    expect(webNotificationAudioAllowed()).toBe(true)
    playAlmaNotificationSound()

    expect(Audio).toHaveBeenCalledWith('/sounds/alma-notification.mp3')
    expect(play).toHaveBeenCalledOnce()
    vi.unstubAllGlobals()
  })
})
