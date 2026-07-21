import { describe, expect, it } from 'vitest'
import {
  cameraCooldownKey,
  cameraRoomLabel,
  canonicalCameraRoom,
  declaredAudioTooLarge,
  matchCameraWake,
} from '../camera-voice-policy'

describe('camera voice policy', () => {
  it('canonicalizes aliases before room-scoped policy decisions', () => {
    expect(canonicalCameraRoom('গেট')).toBe('entrance')
    expect(canonicalCameraRoom('WORK')).toBe('workroom')
    expect(cameraRoomLabel('বস')).toBe('বস অফিস')
    expect(cameraCooldownKey('গেট')).toBe('camera_listen_last_forward_at:entrance')
    expect(cameraCooldownKey('বস')).not.toBe(cameraCooldownKey('গেট'))
  })

  it('matches wake phrases on Unicode word boundaries and preserves the request', () => {
    expect(matchCameraWake('হ্যালো, আলমা শোনো, গেটে একটু আসবেন', ['আলমা শোনো', 'alma']))
      .toBe('গেটে একটু আসবেন')
    expect(matchCameraWake('ALMA: package ready', ['alma'])).toBe('package ready')
  })

  it('never wakes from a name or larger word containing alma', () => {
    expect(matchCameraWake('Salma said the package is ready', ['alma'])).toBeNull()
    expect(matchCameraWake('আলমাবাবু এখন ব্যস্ত', ['আলমা'])).toBeNull()
  })

  it('only wakes when the wake word LEADS the utterance (kills mid-sentence false positives)', () => {
    // A short greeting before the wake word is fine.
    expect(matchCameraWake('হ্যালো, আলমা শোনো, গেটে আসবেন', ['আলমা শোনো']))
      .toBe('গেটে আসবেন')
    // A wake word buried deep in a long noisy chunk must NOT forward — this is the
    // hallucination / random-chatter case that spammed the owner all day.
    expect(
      matchCameraWake(
        'আজকে দোকানে অনেক ভিড় ছিল সারাদিন কাস্টমার আসছিল আলমা শোনো কিছু একটা',
        ['আলমা শোনো'],
      ),
    ).toBeNull()
  })

  it('rejects declared oversized audio before the body is buffered', () => {
    const max = 25 * 1024 * 1024
    expect(declaredAudioTooLarge(String(max + 1), max)).toBe(true)
    expect(declaredAudioTooLarge(String(max), max)).toBe(false)
    expect(declaredAudioTooLarge(null, max)).toBe(false)
  })
})
