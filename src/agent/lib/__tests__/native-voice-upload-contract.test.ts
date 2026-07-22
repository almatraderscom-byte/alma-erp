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
})
