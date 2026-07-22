import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = process.cwd()

describe('native voice upload contract', () => {
  it('uses the same multipart field name on every iOS transcribe path and the server', () => {
    const chat = readFileSync(join(ROOT, 'ios/App/App/AssistantSwiftUI.swift'), 'utf8')
    const voice = readFileSync(join(ROOT, 'ios/App/App/AssistantVoiceSwiftUI.swift'), 'utf8')
    const route = readFileSync(join(ROOT, 'src/app/api/assistant/transcribe/route.ts'), 'utf8')

    const nativeTranscribeCalls = [...chat.matchAll(/path:\s*"\/api\/assistant\/transcribe",\s*fileField:\s*"([^"]+)"/g),
      ...voice.matchAll(/path:\s*"\/api\/assistant\/transcribe",\s*fileField:\s*"([^"]+)"/g)]

    expect(nativeTranscribeCalls).toHaveLength(3)
    expect(nativeTranscribeCalls.map((match) => match[1])).toEqual(['audio', 'audio', 'audio'])
    expect(route).toContain("formData.get('audio')")
    expect(route).not.toContain("formData.get('file')")
  })

  it('never labels the native console LIVE before the realtime socket is connected', () => {
    const voice = readFileSync(join(ROOT, 'ios/App/App/AssistantVoiceSwiftUI.swift'), 'utf8')

    expect(voice).toContain('if liveActive { return "রিয়েলটাইম" }')
    expect(voice).toContain('if sessionReady { return "সাধারণ ভয়েস" }')
    expect(voice).toContain('return "সংযোগ হচ্ছে…"')
    expect(voice).not.toContain('Text("LIVE")')
  })

  it('allows only the one-time same-resource Vercel preview redirect in debug builds', () => {
    const transport = readFileSync(join(ROOT, 'ios/App/App/AssistantTransport.swift'), 'utf8')

    expect(transport).toContain('#if DEBUG')
    expect(transport).toContain('original.host == redirect.host')
    expect(transport).toContain('original.path == redirect.path')
    expect(transport).toContain('$0.name == "_vercel_share"')
    expect(transport).toContain('completionHandler(nil)')
  })

  it('waits for the live socket to open before sending setup and accepts binary JSON frames', () => {
    const voice = readFileSync(join(ROOT, 'ios/App/App/AssistantVoiceSwiftUI.swift'), 'utf8')
    const connectBody = voice.slice(voice.indexOf('private func connect('), voice.indexOf('private func setupMessage('))
    const didOpenBody = voice.slice(voice.indexOf('didOpenWithProtocol'), voice.indexOf('didCloseWith'))

    expect(connectBody).not.toContain('sendJSON(setupMessage')
    expect(didOpenBody).toContain('sendJSON(setupMessage')
    expect(voice).toContain('case .data(let data):')
    expect(voice).toContain('String(data: data, encoding: .utf8)')
    expect(voice).toContain('ALMA-VOICE websocket send failed')
    expect(voice).toContain('completionCallbackType: .dataPlayedBack')
    expect(voice).toContain('playbackDeadline = max(now, playbackDeadline).addingTimeInterval(duration)')
    expect(voice).toContain('let shouldFinish = self.playbackGeneration == generation')
  })
})
