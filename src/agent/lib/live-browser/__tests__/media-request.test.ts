import { describe, expect, it } from 'vitest'
import { parseDirectMediaOwnerRequest } from '../media-request'

const devices = [
  { id: 'dev-home', name: 'Home', online: true },
  { id: 'dev-office', name: 'Office Mac Chrome', online: true },
  { id: 'dev-mac', name: 'Mac', online: true },
  { id: 'dev-macbook', name: 'MacBook', online: true },
  { id: 'dev-my-mac', name: 'My Mac Chrome', online: true },
  { id: 'dev-youtube', name: 'YouTube', online: true },
]

describe('parseDirectMediaOwnerRequest', () => {
  it.each([
    ['Can you play Interstellar?', 'interstellar'],
    ['Play Interstellar for me', 'interstellar'],
    ['I want you to play Interstellar on YouTube', 'interstellar'],
    ['I need you to play Interstellar on YouTube', 'interstellar'],
    ["I'd like you to play Interstellar on YouTube", 'interstellar'],
    ['I would like you to play Interstellar on YouTube', 'interstellar'],
    ['Boss, now pls put on Interstellar on YouTube', 'interstellar'],
    ['Now boss please play Interstellar', 'interstellar'],
    ['Start playing Fix You on YouTube', 'fix you'],
    ['Get Fix You playing on YouTube', 'fix you'],
    ['Could you start playing Fix You on YouTube?', 'fix you'],
    ['Could you get Fix You playing on YouTube?', 'fix you'],
    ['Open YouTube and play Interstellar soundtrack', 'interstellar soundtrack'],
    ['Search YouTube and play ALMA', 'alma'],
  ])('extracts the title from the owner wrapper: %s', (request, mediaTitle) => {
    expect(parseDirectMediaOwnerRequest(request, devices)).toMatchObject({
      mediaTitle,
      deviceTarget: { state: 'none' },
    })
  })

  it.each([
    ['Play Me on YouTube', 'me'],
    ['Play You on YouTube', 'you'],
    ['Play Fix You on YouTube', 'fix you'],
  ])('preserves title-significant Me/You: %s', (request, mediaTitle) => {
    expect(parseDirectMediaOwnerRequest(request, devices).mediaTitle).toBe(mediaTitle)
  })

  it.each([
    ['Play Work from Home on YouTube', 'work from home'],
    ['Play Mac Miller on YouTube', 'mac miller'],
    ['Play MacBook Pro Theme on YouTube', 'macbook pro theme'],
    ['Play On My Way on YouTube', 'on my way'],
    ['Play Fix You with lyrics on YouTube', 'fix you with lyrics'],
    ['Play Dancing With Your Ghost on YouTube', 'dancing with your ghost'],
  ])('does not reinterpret title words as a device target: %s', (request, mediaTitle) => {
    expect(parseDirectMediaOwnerRequest(request, devices)).toMatchObject({
      mediaTitle,
      deviceTarget: { state: 'none' },
    })
  })

  it('treats YouTube as the platform, not a paired device with the same name', () => {
    expect(parseDirectMediaOwnerRequest('Play Fix You on YouTube', devices)).toMatchObject({
      mediaTitle: 'fix you',
      deviceTarget: { state: 'none' },
    })
    expect(parseDirectMediaOwnerRequest('Play Fix You on YouTube-e', devices)).toMatchObject({
      mediaTitle: 'fix you',
      deviceTarget: { state: 'none' },
    })
    expect(parseDirectMediaOwnerRequest('Play Fix You using YouTube device', devices)).toMatchObject({
      mediaTitle: 'fix you',
      deviceTarget: { state: 'selected', device: { id: 'dev-youtube' } },
    })
  })

  it.each([
    ['Use Office Mac Chrome to play Fix You on YouTube', 'fix you', 'dev-office'],
    ['Play Fix You on YouTube using Office', 'fix you', 'dev-office'],
    ['Play Fix You on YouTube using My Mac Chrome', 'fix you', 'dev-my-mac'],
    ['বস, Office Mac Chrome-এ Interstellar চালাও', 'interstellar', 'dev-office'],
    ['Office Mac Chrome diye Interstellar chalao pls', 'interstellar', 'dev-office'],
    ['Interstellar Office Mac Chrome-e chalao', 'interstellar', 'dev-office'],
    ['Boss ami Office Mac Chrome e Interstellar play koro', 'interstellar', 'dev-office'],
  ])('strips an explicit device clause from the media title: %s', (request, mediaTitle, deviceId) => {
    expect(parseDirectMediaOwnerRequest(request, devices)).toMatchObject({
      mediaTitle,
      deviceTarget: { state: 'selected', device: { id: deviceId } },
    })
  })

  it.each([
    ['আমি একটু ইউটিউবে Interstellar চালাও', 'interstellar'],
    ['Boss ami YouTube-e Interstellar chalao', 'interstellar'],
  ])('supports Bengali/Banglish platform-first ordering: %s', (request, mediaTitle) => {
    expect(parseDirectMediaOwnerRequest(request, devices)).toMatchObject({
      mediaTitle,
      deviceTarget: { state: 'none' },
    })
  })
})
