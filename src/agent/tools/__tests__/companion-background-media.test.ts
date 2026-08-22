import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { describe, expect, it } from 'vitest'

interface PageReadResult {
  url: string
  title: string
  documentId: string
  youtube?: { videoId: string; canonicalUrl: string; title: string }
  media: {
    items: Array<{
      mediaId: string
      currentTime: number
      visible: boolean
      primary: boolean
      youtubeVideoId?: string
      youtubeTitle?: string
    }>
  }
}

type PageReadText = (arg?: {
  from?: number
  expectedCurrentUrl?: string
  expectedDocumentId?: string
}) => PageReadResult

const source = readFileSync(new URL('../../../../extension/alma-companion/background.js', import.meta.url), 'utf8')
const start = source.indexOf('function pageReadText')
const end = source.indexOf('\nasync function pageReadDom', start)
if (start < 0 || end < 0) throw new Error('pageReadText source not found')
const pageReadTextSource = source.slice(start, end)
const postMuteStart = source.indexOf('async function readPageTextWithPostSampleMute')
const postMuteEnd = source.indexOf('\n// Wait until the tab finishes loading', postMuteStart)
if (postMuteStart < 0 || postMuteEnd < 0) throw new Error('post-sample mute helper source not found')
const postMuteSource = source.slice(postMuteStart, postMuteEnd)

function mediaFixture(options: {
  pageUrl?: string
  canonicalUrl?: string
  pageTitle?: string
  playerVideoId?: string
  playerTitle?: string
} = {}) {
  type Style = { display: string; visibility: string; opacity: string; contentVisibility: string }
  type Node = {
    parentElement: Node | null
    style: Style
    contains: (other: unknown) => boolean
  }
  const visibleStyle = (): Style => ({
    display: 'block', visibility: 'visible', opacity: '1', contentVisibility: 'visible',
  })
  const html = { parentElement: null, style: visibleStyle() } as unknown as Node
  const body = {
    parentElement: html,
    style: visibleStyle(),
    innerText: 'YouTube page',
    scrollHeight: 1200,
  } as unknown as Node & { innerText: string; scrollHeight: number }
  const pageUrl = options.pageUrl ?? 'https://www.youtube.com/watch?v=abc123XYZ_-'
  const canonicalUrl = options.canonicalUrl ?? 'https://www.youtube.com/watch?v=abc123XYZ_-'
  const pageTitle = options.pageTitle ?? 'Requested song - YouTube'
  const playerVideoId = options.playerVideoId ?? 'abc123XYZ_-'
  const playerTitle = options.playerTitle ?? 'Requested song'
  const playerHref = pageUrl.includes('/shorts/')
    ? `https://www.youtube.com/shorts/${playerVideoId}`
    : `https://www.youtube.com/watch?v=${playerVideoId}`
  const player = {
    parentElement: body,
    style: visibleStyle(),
    querySelector: (selector: string) => selector === '.ytp-title-link[href]'
      ? { href: playerHref, textContent: playerTitle, getAttribute: () => null }
      : null,
    getAttribute: () => null,
  } as unknown as Node & {
    querySelector: (selector: string) => {
      href: string
      textContent: string
      getAttribute: () => null
    } | null
    getAttribute: () => null
  }
  const attrs = new Map<string, string>()
  let videoRect = { width: 900, height: 506, top: 10, left: 10, bottom: 516, right: 910 }
  const video = {
    parentElement: player,
    style: visibleStyle(),
    tagName: 'VIDEO',
    duration: 180,
    currentTime: 12.34,
    paused: false,
    ended: false,
    readyState: 4,
    muted: false,
    volume: 0.8,
    getBoundingClientRect: () => videoRect,
    getAttribute: (name: string) => attrs.get(name) ?? null,
    setAttribute: (name: string, value: string) => attrs.set(name, value),
    closest: (selector: string) => selector === '.html5-video-player' ? player : null,
  } as unknown as Node & {
    tagName: string
    duration: number
    currentTime: number
    paused: boolean
    ended: boolean
    readyState: number
    muted: boolean
    volume: number
    getBoundingClientRect: () => Record<string, number>
    getAttribute: (name: string) => string | null
    setAttribute: (name: string, value: string) => void
    closest: (selector: string) => typeof player | null
  }
  const overlay = { parentElement: body, style: visibleStyle() } as unknown as Node
  html.contains = (other) => other === html || other === body || other === player || other === video || other === overlay
  body.contains = (other) => other === body || other === player || other === video || other === overlay
  player.contains = (other) => other === player || other === video
  video.contains = (other) => other === video
  overlay.contains = (other) => other === overlay
  let elementsFromPoint: (x: number, y: number) => Node[] = () => [video, body, html]
  const documentElement = Object.assign(html, { scrollHeight: 1200 })
  const document = {
    body,
    documentElement,
    title: pageTitle,
    querySelectorAll: () => [video],
    querySelector: (selector: string) => {
      if (selector === 'link[rel="canonical"]') return { href: canonicalUrl }
      if (selector.startsWith('meta[name="title"]')) return { content: pageTitle.replace(/ - YouTube$/, '') }
      if (selector.includes('.html5-video-player.ad-showing')) return { className: 'ad-showing' }
      return null
    },
    elementsFromPoint: (x: number, y: number) => elementsFromPoint(x, y),
  }
  const context = {
    document,
    location: { href: pageUrl },
    window: { innerHeight: 800, innerWidth: 1280, scrollY: 0 },
    performance: { timeOrigin: 123456.7 },
    crypto: { randomUUID: () => 'media-uuid' },
    getComputedStyle: (node: Node) => node.style,
    Math,
    Number,
    Array,
    String,
    Date,
    URL,
  }
  return {
    video,
    body,
    overlay,
    setElementsFromPoint: (fn: (x: number, y: number) => Node[]) => { elementsFromPoint = fn },
    setVideoRect: (rect: typeof videoRect) => { videoRect = rect },
    // No identity fields exercises the legacy/general read protocol. Direct
    // reads are covered separately with the exact renderer-boundary guard.
    pageReadText: runInNewContext(`(${pageReadTextSource})`, context) as PageReadText,
  }
}

describe('Companion pageReadText media evidence', () => {
  it('extracts stable visible primary media identity, document identity, and ad state', () => {
    const { pageReadText, video } = mediaFixture()

    const first = pageReadText({})
    video.currentTime = 13.4
    const second = pageReadText({})

    expect(first).toMatchObject({
      url: 'https://www.youtube.com/watch?v=abc123XYZ_-',
      title: 'Requested song - YouTube',
      documentId: '123457',
      youtube: {
        videoId: 'abc123XYZ_-',
        canonicalUrl: 'https://www.youtube.com/watch?v=abc123XYZ_-',
        title: 'Requested song',
      },
      media: {
        count: 1,
        playing: true,
        adPlaying: true,
        items: [{
          mediaId: 'media-uuid',
          primary: true,
          visible: true,
          muted: false,
          volume: 0.8,
          viewportWidth: 900,
          viewportHeight: 506,
          viewportArea: 455400,
          exposedPointCount: 5,
          centerExposed: true,
          youtubeVideoId: 'abc123XYZ_-',
          youtubeTitle: 'Requested song',
        }],
      },
    })
    expect(second.media.items[0].mediaId).toBe('media-uuid')
    expect(second.media.items[0].currentTime).toBe(13.4)
  })

  it('does not assign a search-results page the identity of an unrelated miniplayer', () => {
    const { pageReadText } = mediaFixture({
      pageUrl: 'https://www.youtube.com/results?search_query=requested+song',
      canonicalUrl: 'https://www.youtube.com/results?search_query=requested+song',
      pageTitle: 'requested song - YouTube',
      playerVideoId: 'wrongVID001',
      playerTitle: 'Unrelated miniplayer song',
    })

    const result = pageReadText({})
    expect(result.youtube).toBeUndefined()
    expect(result.media.items[0]).toMatchObject({
      youtubeVideoId: 'wrongVID001',
      youtubeTitle: 'Unrelated miniplayer song',
    })
  })

  it('extracts a canonical Shorts identity through the player title-link DOM fallback', () => {
    const shortsUrl = 'https://www.youtube.com/shorts/shortsID001'
    const { pageReadText } = mediaFixture({
      pageUrl: shortsUrl,
      canonicalUrl: shortsUrl,
      pageTitle: 'Requested Short - YouTube',
      playerVideoId: 'shortsID001',
      playerTitle: 'Requested Short',
    })

    expect(pageReadText({})).toMatchObject({
      youtube: { videoId: 'shortsID001', canonicalUrl: shortsUrl, title: 'Requested Short' },
      media: {
        items: [{ youtubeVideoId: 'shortsID001', youtubeTitle: 'Requested Short' }],
      },
    })
  })

  it('rejects media hidden by an ancestor even when its own style and geometry are visible', () => {
    const { pageReadText, body } = mediaFixture()
    body.style.opacity = '0'
    expect(pageReadText({}).media.items[0]).toMatchObject({ visible: false, primary: false })
  })

  it('rejects fully occluded media even when the media remains lower in the hit stack', () => {
    const { pageReadText, overlay, video, body, setElementsFromPoint } = mediaFixture()
    setElementsFromPoint(() => [overlay, video, body])
    expect(pageReadText({}).media.items[0]).toMatchObject({ visible: false, primary: false })
  })

  it('accepts partially exposed media after probing center and four clipped corners', () => {
    const { pageReadText, overlay, video, body, setElementsFromPoint } = mediaFixture()
    let probes = 0
    setElementsFromPoint(() => {
      probes++
      return probes === 2 || probes === 3 ? [overlay, video, body] : [video, body]
    })
    expect(pageReadText({}).media.items[0]).toMatchObject({
      visible: true, primary: true, exposedPointCount: 3, centerExposed: true,
    })
    expect(probes).toBe(5)
  })

  it('rejects a tiny 1x1 player even when every sampled point is exposed', () => {
    const { pageReadText, setVideoRect } = mediaFixture()
    setVideoRect({ width: 1, height: 1, top: 10, left: 10, bottom: 11, right: 11 })
    expect(pageReadText({}).media.items[0]).toMatchObject({
      visible: false, primary: false, viewportArea: 1, exposedPointCount: 5,
    })
  })

  it('rejects a 99%-covered player when only one of five coverage probes is exposed', () => {
    const { pageReadText, overlay, video, body, setElementsFromPoint } = mediaFixture()
    let probes = 0
    setElementsFromPoint(() => {
      probes++
      return probes === 1 ? [video, body] : [overlay, video, body]
    })
    expect(pageReadText({}).media.items[0]).toMatchObject({
      visible: false, primary: false, exposedPointCount: 1, centerExposed: true,
    })
    expect(probes).toBe(5)
  })

  it('stamps mute state after the media read and fails closed when the post-sample tab is unavailable', async () => {
    const expectedUrl = 'https://www.youtube.com/watch?v=abc123XYZ_-'
    let muted = false
    let tabActive = false
    let windowFocused = false
    const data = {
      url: expectedUrl,
      documentId: '123457',
      media: { count: 1, tabMuted: false },
    }
    const readWithPostMute = runInNewContext(`(${postMuteSource})`, {
      runInPage: async () => {
        muted = true // tab mute flips while the injected page sample is in flight
        return data
      },
      pageReadText: () => data,
      chrome: {
        tabs: {
          get: async () => ({
            url: expectedUrl,
            mutedInfo: { muted },
            active: tabActive,
            windowId: 4,
          }),
          update: async () => { tabActive = true },
        },
        windows: {
          get: async () => ({ focused: windowFocused }),
          update: async () => { windowFocused = true },
        },
      },
      Boolean,
      Number,
    }) as (
      tabId: number,
      from?: number,
      requireForeground?: boolean,
      requiredHost?: string,
      expectedCurrentUrl?: string,
      expectedDocumentId?: string,
    ) => Promise<{ ok: boolean; data?: typeof data; error?: string }>

    await expect(readWithPostMute(7, 0, true, undefined, expectedUrl, '123457')).resolves.toMatchObject({
      ok: true,
      data: { media: { tabMuted: true, tabActive: true, windowFocused: true } },
    })
    await expect(readWithPostMute(7, 0, false)).resolves.toMatchObject({
      ok: true,
      data: { url: expectedUrl, documentId: '123457' },
    })
    const partialIdentity = await readWithPostMute(7, 0, false, undefined, expectedUrl)
    expect(partialIdentity).toMatchObject({
      ok: false,
      blocked: true,
      error: expect.stringContaining('precondition_missing'),
    })
    expect(partialIdentity).not.toHaveProperty('data')

    const unavailable = runInNewContext(`(${postMuteSource})`, {
      runInPage: async () => ({ url: expectedUrl, documentId: '123457', media: { count: 1 } }),
      pageReadText: () => null,
      chrome: {
        tabs: { get: async () => { throw new Error('tab closed') } },
        windows: { get: async () => null },
      },
      Boolean,
      Number,
    }) as (
      tabId: number,
      from?: number,
      requireForeground?: boolean,
      requiredHost?: string,
      expectedCurrentUrl?: string,
      expectedDocumentId?: string,
    ) => Promise<{ ok: boolean; error?: string }>
    await expect(unavailable(7, 0, false, undefined, expectedUrl, '123457')).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining('post_sample_browser_state_unavailable'),
    })
  })

  it('fails a required foreground witness when focus is lost during the sample', async () => {
    const expectedUrl = 'https://www.youtube.com/watch?v=abc123XYZ_-'
    let focused = false
    const read = runInNewContext(`(${postMuteSource})`, {
      runInPage: async () => {
        focused = false
        return { url: expectedUrl, documentId: '123457', media: { count: 1 } }
      },
      pageReadText: () => null,
      chrome: {
        tabs: {
          get: async () => ({
            url: expectedUrl,
            mutedInfo: { muted: false },
            active: true,
            windowId: 4,
          }),
          update: async () => undefined,
        },
        windows: {
          get: async () => ({ focused }),
          update: async () => { focused = true },
        },
      },
      Boolean,
      Number,
    }) as (
      tabId: number,
      from?: number,
      requireForeground?: boolean,
      requiredHost?: string,
      expectedCurrentUrl?: string,
      expectedDocumentId?: string,
    ) => Promise<{ ok: boolean; error?: string }>

    await expect(read(7, 0, true, undefined, expectedUrl, '123457')).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining('foreground_witness_failed'),
    })
  })

  it('returns no sampled text when the renderer reports a different observation identity', async () => {
    const expectedUrl = 'https://www.youtube.com/watch?v=abc123XYZ_-'
    const read = runInNewContext(`(${postMuteSource})`, {
      runInPage: async () => ({
        url: expectedUrl,
        documentId: 'replacement-document',
        text: 'private replacement page content',
      }),
      pageReadText: () => null,
      chrome: {
        tabs: { get: async () => ({ url: expectedUrl, active: true, windowId: 4 }) },
        windows: { get: async () => ({ focused: true }) },
      },
      Boolean,
      Number,
      String,
    }) as (
      tabId: number,
      from?: number,
      requireForeground?: boolean,
      requiredHost?: string,
      expectedCurrentUrl?: string,
      expectedDocumentId?: string,
    ) => Promise<{ ok: boolean; blocked?: boolean; error?: string; data?: unknown }>

    const result = await read(7, 0, false, undefined, expectedUrl, '123457')
    expect(result).toMatchObject({ ok: false, blocked: true })
    expect(result).not.toHaveProperty('data')
    expect(JSON.stringify(result)).not.toContain('private replacement page content')
  })
})
