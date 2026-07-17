'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { emitWebOfficeCallEvent } from '@/agent/lib/office-call-client-events'
import { acquireWebCallLease } from '@/agent/lib/office-call-web-lease'
import {
  connectionStateForAgora,
  isExpectedAgoraPeer,
  webCallErrorCode,
  type WebAgoraConnectionState,
} from '@/agent/lib/office-call-web-policy'

type AnyRemoteAudioTrack = {
  play: () => void
  stop: () => void
  setPlaybackDevice?: (deviceId: string) => Promise<void>
}
type AnyRemoteUser = { uid: string | number; audioTrack?: AnyRemoteAudioTrack }
type AnyClient = {
  join: (appId: string, channel: string, token: string | null, uid: string | number | null) => Promise<string | number>
  leave: () => Promise<void>
  publish: (tracks: unknown) => Promise<void>
  subscribe: (user: unknown, mediaType: string) => Promise<void>
  renewToken: (token: string) => Promise<void>
  on: (event: string, cb: (...args: unknown[]) => void) => void
  removeAllListeners: () => void
}
type AnyLocalAudioTrack = {
  setMuted: (muted: boolean) => Promise<void>
  setDevice?: (deviceId: string) => Promise<void>
  stop: () => void
  close: () => void
}
type AnyAgoraRtc = {
  createClient: (config: { mode: string; codec: string }) => AnyClient
  createMicrophoneAudioTrack: (config: Record<string, unknown>) => Promise<AnyLocalAudioTrack>
  getMicrophones: (skipPermissionCheck?: boolean) => Promise<MediaDeviceInfo[]>
  getPlaybackDevices: (skipPermissionCheck?: boolean) => Promise<MediaDeviceInfo[]>
  on?: (event: string, cb: (...args: unknown[]) => void) => void
  off?: (event: string, cb: (...args: unknown[]) => void) => void
}

export type AgoraCallState = WebAgoraConnectionState
export type AgoraDevice = { deviceId: string; label: string }
export type AgoraNetworkQuality = { uplink: number; downlink: number }

export type UseAgoraCall = {
  state: AgoraCallState
  join: (channel: string) => Promise<void>
  leave: () => Promise<void>
  muted: boolean
  toggleMute: () => Promise<void>
  remoteJoined: boolean
  error: string | null
  callSeconds: number
  networkQuality: AgoraNetworkQuality
  microphones: AgoraDevice[]
  outputs: AgoraDevice[]
  selectedMicrophone: string
  selectedOutput: string
  selectMicrophone: (deviceId: string) => Promise<void>
  selectOutput: (deviceId: string) => Promise<void>
}

const REMOTE_LEFT_GRACE_MS = 15_000

function deviceRows(rows: MediaDeviceInfo[]): AgoraDevice[] {
  return rows.map((row, index) => ({
    deviceId: row.deviceId,
    label: row.label || `Audio device ${index + 1}`,
  }))
}

export function useAgoraCall(): UseAgoraCall {
  const [state, setState] = useState<AgoraCallState>('idle')
  const [muted, setMuted] = useState(false)
  const [remoteJoined, setRemoteJoined] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [callSeconds, setCallSeconds] = useState(0)
  const [networkQuality, setNetworkQuality] = useState<AgoraNetworkQuality>({ uplink: 0, downlink: 0 })
  const [microphones, setMicrophones] = useState<AgoraDevice[]>([])
  const [outputs, setOutputs] = useState<AgoraDevice[]>([])
  const [selectedMicrophone, setSelectedMicrophone] = useState('')
  const [selectedOutput, setSelectedOutput] = useState('')

  const clientRef = useRef<AnyClient | null>(null)
  const localTrackRef = useRef<AnyLocalAudioTrack | null>(null)
  const remoteTracksRef = useRef<Map<string, AnyRemoteAudioTrack>>(new Map())
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const remoteGraceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const channelRef = useRef<string | null>(null)
  const generationRef = useRef(0)
  const requestAbortRef = useRef<AbortController | null>(null)
  const mountedRef = useRef(true)
  const stateRef = useRef<AgoraCallState>('idle')
  const remoteJoinedRef = useRef(false)
  const expectedPeerUidRef = useRef<string | number | null>(null)
  const establishedPeerUidRef = useRef<string | number | null>(null)
  const selectedMicrophoneRef = useRef('')
  const selectedOutputRef = useRef('')
  const sdkDeviceCleanupRef = useRef<(() => void) | null>(null)
  const renewingRef = useRef(false)
  const leaseReleaseRef = useRef<(() => void) | null>(null)

  const updateState = useCallback((next: AgoraCallState) => {
    stateRef.current = next
    if (mountedRef.current) setState(next)
  }, [])
  const updateRemoteJoined = useCallback((next: boolean) => {
    remoteJoinedRef.current = next
    if (mountedRef.current) setRemoteJoined(next)
  }, [])
  const clearTimer = useCallback(() => {
    if (timerRef.current) clearInterval(timerRef.current)
    timerRef.current = null
  }, [])
  const clearRemoteGrace = useCallback(() => {
    if (remoteGraceRef.current) clearTimeout(remoteGraceRef.current)
    remoteGraceRef.current = null
  }, [])

  const refreshDevices = useCallback(async (sdk?: AnyAgoraRtc) => {
    try {
      const runtime = sdk ?? ((await import('agora-rtc-sdk-ng')).default as unknown as AnyAgoraRtc)
      const [mics, speakers] = await Promise.all([
        runtime.getMicrophones(true).catch(() => []),
        runtime.getPlaybackDevices(true).catch(() => []),
      ])
      if (!mountedRef.current) return
      setMicrophones(deviceRows(mics))
      setOutputs(deviceRows(speakers))
    } catch {
      // Device labels/listing can be unavailable until microphone permission.
    }
  }, [])

  const teardown = useCallback(async () => {
    requestAbortRef.current?.abort()
    requestAbortRef.current = null
    clearTimer()
    clearRemoteGrace()
    sdkDeviceCleanupRef.current?.()
    sdkDeviceCleanupRef.current = null
    renewingRef.current = false
    leaseReleaseRef.current?.()
    leaseReleaseRef.current = null
    expectedPeerUidRef.current = null
    establishedPeerUidRef.current = null
    for (const track of remoteTracksRef.current.values()) {
      try { track.stop() } catch { /* already stopped */ }
    }
    remoteTracksRef.current.clear()
    const client = clientRef.current
    const localTrack = localTrackRef.current
    clientRef.current = null
    localTrackRef.current = null
    if (localTrack) {
      try { localTrack.stop(); localTrack.close() } catch { /* already closed */ }
    }
    if (client) {
      try { client.removeAllListeners() } catch { /* already removed */ }
      try { await client.leave() } catch { /* never joined/already left */ }
    }
  }, [clearRemoteGrace, clearTimer])

  const leave = useCallback(async () => {
    const channel = channelRef.current
    generationRef.current += 1
    if (channel) emitWebOfficeCallEvent({ channel, event: 'client.leave_started', state: 'leaving' })
    await teardown()
    if (channel) emitWebOfficeCallEvent({ channel, event: 'client.local_left', state: 'ended' })
    channelRef.current = null
    updateRemoteJoined(false)
    if (mountedRef.current) {
      setMuted(false)
      setCallSeconds(0)
      setNetworkQuality({ uplink: 0, downlink: 0 })
    }
    updateState('ended')
  }, [teardown, updateRemoteJoined, updateState])

  const join = useCallback(async (channel: string) => {
    const ch = channel.trim()
    if (!ch) {
      if (mountedRef.current) setError('channel_required')
      updateState('error')
      return
    }
    if (channelRef.current === ch && !['idle', 'ended', 'error'].includes(stateRef.current)) return

    const generation = generationRef.current + 1
    generationRef.current = generation
    await teardown()
    if (!mountedRef.current || generationRef.current !== generation) return
    channelRef.current = ch
    updateState('connecting')
    updateRemoteJoined(false)
    if (mountedRef.current) {
      setError(null)
      setMuted(false)
      setCallSeconds(0)
      setNetworkQuality({ uplink: 0, downlink: 0 })
    }
    emitWebOfficeCallEvent({ channel: ch, event: 'client.join_started', state: 'connecting' })

    const stillCurrent = () => mountedRef.current && generationRef.current === generation && channelRef.current === ch
    let localClient: AnyClient | null = null
    let localTrack: AnyLocalAudioTrack | null = null
    try {
      const callId = ch.startsWith('itc_') ? ch.slice(4) : ch
      const releaseLease = await acquireWebCallLease(callId, () => {
        if (!stillCurrent()) return
        setError('call_active_in_another_tab')
        emitWebOfficeCallEvent({ channel: ch, event: 'client.tab_lease_lost', state: stateRef.current })
        void leave().then(() => updateState('error'))
      })
      if (!releaseLease) throw new Error('call_active_in_another_tab')
      if (!stillCurrent()) {
        releaseLease()
        return
      }
      leaseReleaseRef.current = releaseLease

      const controller = new AbortController()
      requestAbortRef.current = controller
      const response = await fetch('/api/assistant/office/intercom/call-token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ channel: ch }),
        signal: controller.signal,
      })
      requestAbortRef.current = null
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { error?: string } | null
        throw new Error(body?.error ?? `http_${response.status}`)
      }
      const credentials = (await response.json()) as {
        appId: string
        token: string
        uid: number
        peerUid?: number | null
      }
      if (!stillCurrent()) return
      expectedPeerUidRef.current = credentials.peerUid ?? null

      const AgoraRTC = (await import('agora-rtc-sdk-ng')).default as unknown as AnyAgoraRtc
      if (!stillCurrent()) return
      localClient = AgoraRTC.createClient({ mode: 'rtc', codec: 'vp8' })
      clientRef.current = localClient

      const accepts = (user: AnyRemoteUser): boolean => {
        const accepted = isExpectedAgoraPeer({
          candidate: user.uid,
          expected: expectedPeerUidRef.current,
          established: establishedPeerUidRef.current,
        })
        if (!accepted) {
          emitWebOfficeCallEvent({
            channel: ch,
            event: 'client.unexpected_peer_rejected',
            state: stateRef.current,
            metadata: { remoteUid: String(user.uid) },
          })
          return false
        }
        establishedPeerUidRef.current = user.uid
        return true
      }

      localClient.on('user-joined', (...args) => {
        if (!stillCurrent()) return
        const user = args[0] as AnyRemoteUser
        if (!accepts(user)) return
        clearRemoteGrace()
        updateRemoteJoined(true)
        updateState('in-call')
        emitWebOfficeCallEvent({ channel: ch, event: 'client.peer_joined', state: 'in-call' })
      })
      localClient.on('user-left', (...args) => {
        if (!stillCurrent()) return
        const user = args[0] as AnyRemoteUser
        if (establishedPeerUidRef.current !== null && String(user.uid) !== String(establishedPeerUidRef.current)) return
        const track = remoteTracksRef.current.get(String(user.uid))
        try { track?.stop() } catch { /* already stopped */ }
        remoteTracksRef.current.delete(String(user.uid))
        clearRemoteGrace()
        updateState('reconnecting')
        remoteGraceRef.current = setTimeout(() => {
          if (!stillCurrent()) return
          remoteGraceRef.current = null
          updateRemoteJoined(false)
          emitWebOfficeCallEvent({ channel: ch, event: 'client.peer_left', state: 'reconnecting' })
        }, REMOTE_LEFT_GRACE_MS)
      })
      localClient.on('user-published', async (...args) => {
        if (!stillCurrent() || args[1] !== 'audio') return
        const user = args[0] as AnyRemoteUser
        if (!accepts(user)) return
        try {
          await localClient?.subscribe(user, 'audio')
          if (!stillCurrent() || !user.audioTrack) return
          remoteTracksRef.current.set(String(user.uid), user.audioTrack)
          if (selectedOutputRef.current && user.audioTrack.setPlaybackDevice) {
            await user.audioTrack.setPlaybackDevice(selectedOutputRef.current).catch(() => {})
          }
          user.audioTrack.play()
          clearRemoteGrace()
          updateRemoteJoined(true)
          updateState('in-call')
        } catch {
          // A publish/leave race is reconciled by canonical state and the SDK.
        }
      })
      localClient.on('user-unpublished', (...args) => {
        if (!stillCurrent() || args[1] !== 'audio') return
        const user = args[0] as AnyRemoteUser
        const track = remoteTracksRef.current.get(String(user.uid))
        try { track?.stop() } catch { /* already stopped */ }
        remoteTracksRef.current.delete(String(user.uid))
        // Muting/unpublishing is not a hang-up; membership events own presence.
      })
      localClient.on('connection-state-change', (...args) => {
        if (!stillCurrent()) return
        const current = String(args[0] ?? '')
        const next = connectionStateForAgora(current, remoteJoinedRef.current)
        if (next) updateState(next)
        emitWebOfficeCallEvent({
          channel: ch,
          event: 'client.connection_state',
          state: next ?? stateRef.current,
          metadata: { current, previous: String(args[1] ?? ''), reason: String(args[2] ?? '') },
        })
      })
      localClient.on('network-quality', (...args) => {
        const quality = args[0] as { uplinkNetworkQuality?: number; downlinkNetworkQuality?: number }
        if (stillCurrent()) setNetworkQuality({
          uplink: Number(quality.uplinkNetworkQuality ?? 0),
          downlink: Number(quality.downlinkNetworkQuality ?? 0),
        })
      })
      localClient.on('token-privilege-will-expire', () => {
        if (!stillCurrent() || renewingRef.current) return
        renewingRef.current = true
        void (async () => {
          try {
            const renewal = await fetch('/api/assistant/office/intercom/call-token', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ channel: ch, renewal: true }),
            })
            const body = (await renewal.json().catch(() => null)) as { token?: string; error?: string } | null
            if (!renewal.ok || !body?.token) throw new Error(body?.error ?? `http_${renewal.status}`)
            if (!stillCurrent()) return
            await localClient?.renewToken(body.token)
            emitWebOfficeCallEvent({ channel: ch, event: 'client.token_renewed', state: stateRef.current })
          } catch (renewalError) {
            if (!stillCurrent()) return
            const code = renewalError instanceof Error ? renewalError.message : 'token_renew_failed'
            setError(code)
            emitWebOfficeCallEvent({ channel: ch, event: 'client.token_renew_failed', state: stateRef.current, metadata: { code } })
          } finally {
            renewingRef.current = false
          }
        })()
      })

      await localClient.join(credentials.appId, ch, credentials.token, credentials.uid)
      if (!stillCurrent()) {
        try { await localClient.leave() } catch { /* stale join */ }
        return
      }
      emitWebOfficeCallEvent({ channel: ch, event: 'client.local_joined', state: 'connecting' })

      localTrack = await AgoraRTC.createMicrophoneAudioTrack({
        encoderConfig: 'high_quality',
        AEC: true,
        ANS: true,
        AGC: true,
        ...(selectedMicrophoneRef.current ? { microphoneId: selectedMicrophoneRef.current } : {}),
      })
      if (!stillCurrent()) {
        localTrack.stop(); localTrack.close()
        try { await localClient.leave() } catch { /* stale permission prompt */ }
        return
      }
      localTrackRef.current = localTrack
      await localClient.publish(localTrack)
      if (!stillCurrent()) return

      const onDeviceChange = () => { void refreshDevices(AgoraRTC) }
      AgoraRTC.on?.('microphone-changed', onDeviceChange)
      AgoraRTC.on?.('playback-device-changed', onDeviceChange)
      sdkDeviceCleanupRef.current = () => {
        AgoraRTC.off?.('microphone-changed', onDeviceChange)
        AgoraRTC.off?.('playback-device-changed', onDeviceChange)
      }
      await refreshDevices(AgoraRTC)
    } catch (caught) {
      if (!stillCurrent()) return
      const code = webCallErrorCode(caught)
      await teardown()
      if (!stillCurrent()) return
      setError(code)
      updateState('error')
      emitWebOfficeCallEvent({ channel: ch, event: 'client.media_error', state: 'error', metadata: { code } })
    }
  }, [clearRemoteGrace, leave, refreshDevices, teardown, updateRemoteJoined, updateState])

  const toggleMute = useCallback(async () => {
    const track = localTrackRef.current
    if (!track) return
    const next = !muted
    try {
      await track.setMuted(next)
      if (mountedRef.current) setMuted(next)
    } catch {
      if (mountedRef.current) setError('microphone_toggle_failed')
    }
  }, [muted])

  const selectMicrophone = useCallback(async (deviceId: string) => {
    if (!deviceId) return
    try {
      await localTrackRef.current?.setDevice?.(deviceId)
      selectedMicrophoneRef.current = deviceId
      if (mountedRef.current) setSelectedMicrophone(deviceId)
    } catch {
      if (mountedRef.current) setError('microphone_switch_failed')
    }
  }, [])

  const selectOutput = useCallback(async (deviceId: string) => {
    if (!deviceId) return
    try {
      await Promise.all([...remoteTracksRef.current.values()].map((track) => track.setPlaybackDevice?.(deviceId)))
      selectedOutputRef.current = deviceId
      if (mountedRef.current) setSelectedOutput(deviceId)
    } catch {
      if (mountedRef.current) setError('output_switch_failed')
    }
  }, [])

  useEffect(() => {
    if (remoteJoined) {
      clearTimer()
      timerRef.current = setInterval(() => {
        if (mountedRef.current) setCallSeconds((seconds) => seconds + 1)
      }, 1000)
    } else clearTimer()
    return clearTimer
  }, [clearTimer, remoteJoined])

  useEffect(() => {
    mountedRef.current = true
    const onDeviceChange = () => { if (channelRef.current) void refreshDevices() }
    navigator.mediaDevices?.addEventListener?.('devicechange', onDeviceChange)
    return () => {
      mountedRef.current = false
      generationRef.current += 1
      navigator.mediaDevices?.removeEventListener?.('devicechange', onDeviceChange)
      void teardown()
    }
  }, [refreshDevices, teardown])

  useEffect(() => {
    const onVisibility = () => {
      const channel = channelRef.current
      if (!channel) return
      emitWebOfficeCallEvent({
        channel,
        event: document.hidden ? 'client.app_backgrounded' : 'client.app_foregrounded',
        state: stateRef.current,
      })
    }
    const onOffline = () => {
      const channel = channelRef.current
      if (!channel) return
      updateState('reconnecting')
      emitWebOfficeCallEvent({ channel, event: 'client.network_offline', state: 'reconnecting' })
    }
    const onOnline = () => {
      const channel = channelRef.current
      if (channel) emitWebOfficeCallEvent({ channel, event: 'client.network_online', state: stateRef.current })
    }
    const onPageHide = () => {
      const channel = channelRef.current
      if (channel) emitWebOfficeCallEvent({ channel, event: 'client.page_unloaded', state: stateRef.current })
    }
    document.addEventListener('visibilitychange', onVisibility)
    window.addEventListener('offline', onOffline)
    window.addEventListener('online', onOnline)
    window.addEventListener('pagehide', onPageHide)
    return () => {
      document.removeEventListener('visibilitychange', onVisibility)
      window.removeEventListener('offline', onOffline)
      window.removeEventListener('online', onOnline)
      window.removeEventListener('pagehide', onPageHide)
    }
  }, [updateState])

  return {
    state,
    join,
    leave,
    muted,
    toggleMute,
    remoteJoined,
    error,
    callSeconds,
    networkQuality,
    microphones,
    outputs,
    selectedMicrophone,
    selectedOutput,
    selectMicrophone,
    selectOutput,
  }
}
