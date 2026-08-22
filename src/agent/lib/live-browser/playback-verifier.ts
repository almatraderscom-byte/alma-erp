import {
  parseDirectMediaOwnerRequest,
  type PairedDeviceForOwnerRequest,
} from './media-request'

export interface BrowserMediaItem {
  index?: number
  kind?: string
  mediaId?: string
  primary?: boolean
  playing?: boolean
  paused?: boolean
  ended?: boolean
  muted?: boolean
  volume?: number
  currentTime?: number
  duration?: number | null
  readyState?: number
  visible?: boolean
  viewportWidth?: number
  viewportHeight?: number
  viewportArea?: number
  exposedPointCount?: number
  centerExposed?: boolean
  youtubeVideoId?: string
  youtubeTitle?: string
}

export interface BrowserMediaSnapshot {
  url?: string
  title?: string
  text?: string
  documentId?: string
  youtube?: {
    videoId?: string
    canonicalUrl?: string
    title?: string
  }
  media?: {
    count?: number
    playing?: boolean
    adPlaying?: boolean
    tabMuted?: boolean
    tabActive?: boolean
    windowFocused?: boolean
    items?: BrowserMediaItem[]
  }
}

export interface PlaybackVerification {
  verified: boolean
  expectedMedia: string
  expectedHost: string | null
  hostMatched: boolean
  canonicalMediaPage: boolean
  titleMatched: boolean
  mediaPageIdentityMatched: boolean
  mediaTitleMatched: boolean
  mediaVariantMatched: boolean
  selectedMediaIdentityMatched: boolean
  selectedMediaTitleMatched: boolean
  unrequestedMediaVariants: string[]
  matchedTitleTokens: string[]
  requiredTitleTokenMatches: number
  sameDocument: boolean
  sameMedia: boolean
  mediaVisible: boolean
  mediaPlaying: boolean
  mediaReady: boolean
  mediaAudible: boolean
  foregroundWitnessed: boolean
  timeAdvanced: boolean
  progressSeconds: number | null
  adPlaying: boolean
  reasons: string[]
}

// Query glue should not make an otherwise correct title fail. Keep this list
// deliberately small: content words still have to match the page title.
const QUERY_GLUE = new Set([
  'a', 'an', 'the', 'on', 'in', 'at', 'to', 'of', 'for', 'and', 'by',
  'play', 'watch', 'open', 'search', 'find', 'put', 'start', 'listen',
  'can', 'could', 'would', 'will', 'you', 'me', 'my', 'now',
  'music', 'song', 'video',
  'official', 'audio', 'lyrics', 'lyric', 'soundtrack', 'theme',
  'please', 'youtube',
  'একটা', 'একটি', 'টা', 'টি', 'গান', 'গানটা', 'মিউজিক', 'ভিডিও',
  'চালাও', 'চালান', 'বাজাও', 'বাজান', 'প্লে', 'করো', 'করুন', 'করবে', 'করবেন',
  'খুঁজে', 'দেখাও', 'দেখান', 'দাও', 'দিন', 'ইউটিউবে', 'ইউটিউবের',
  'koro', 'korun', 'kore', 'dao', 'diye', 'play', 'chalao', 'chalaw', 'bajao',
  'dekhao', 'youtube-e',
])

// Pronouns and variant qualifiers are title-significant ("Fix You — Official
// Audio" is not a karaoke remix; an Interstellar soundtrack is not a review).
// The loose owner-query normalizer historically dropped these, allowing a
// different media variant with one shared noun to pass. Playback proof keeps
// them while command/platform glue remains removable.
const TITLE_SIGNIFICANT_TOKENS = new Set([
  'you', 'me', 'my',
  'official', 'audio', 'lyrics', 'lyric', 'soundtrack', 'theme',
])
const MEDIA_TITLE_GLUE = new Set(
  [...QUERY_GLUE, 'some', 'any', 'anything', 'something'].filter((token) => (
    !TITLE_SIGNIFICANT_TOKENS.has(token)
  )),
)

const OWNER_REQUEST_GLUE = new Set([
  'i', 'we', 'us', 'want', 'need',
  'আমি', 'আমরা', 'আমার', 'আমাকে', 'আমাদের', 'এর', 'জন্য', 'এই', 'ওই', 'একটু', 'দয়া', 'দয়া',
  'করে', 'তুমি', 'আপনি', 'চাই', 'শুনতে', 'দেখতে',
  'amar', 'amake', 'amader', 'jonno', 'ektu', 'doya', 'tumi', 'apni', 'chai',
])

// These words materially change the requested recording/content. A base-title
// subset match ("Fix You") must not silently authorize a karaoke, remix,
// reaction, cover, trailer, or other variant the owner did not request.
const CONFLICTING_MEDIA_VARIANTS = new Set([
  'karaoke', 'remix', 'cover', 'reaction', 'review', 'trailer', 'instrumental',
  'acoustic', 'live', 'concert', 'performance', 'slowed', 'reverb', 'sped',
  'nightcore', 'fanmade', 'unofficial', 'parody',
  'কারাওকে', 'রিমিক্স', 'কভার', 'রিঅ্যাকশন', 'রিয়্যাকশন', 'রিভিউ', 'ট্রেলার',
  'ইন্সট্রুমেন্টাল', 'লাইভ', 'কনসার্ট', 'প্যারোডি',
])

// Result titles may add presentation metadata, but not new semantic content.
// This positive allowlist is intentionally small: unknown extras such as
// "piano tutorial" fail even though no finite denylist named them.
const BENIGN_RESULT_METADATA = new Set([
  'official', 'audio', 'video', 'lyrics', 'lyric', 'hd', '4k', 'mv', 'music',
])

const NON_ATTRIBUTION_CONTENT = new Set([
  ...CONFLICTING_MEDIA_VARIANTS,
  'tutorial', 'lesson', 'guide', 'howto', 'piano', 'guitar', 'drums', 'bass',
  'practice', 'lesson', 'version', 'edit', 'session', 'analysis', 'explained',
  'টিউটোরিয়াল', 'টিউটোরিয়াল', 'লেসন', 'গাইড', 'পিয়ানো', 'পিয়ানো', 'গিটার',
])

function normalizedMediaTitleTokens(value: string): string[] {
  return normalizedTokensWithGlue(value, MEDIA_TITLE_GLUE)
}

function normalizedTokensWithGlue(value: string, glue: Set<string>): string[] {
  const tokens = value
    .toLocaleLowerCase()
    .normalize('NFKC')
    // Combining marks are part of Bengali and many other scripts. Treating
    // only Unicode letters as word characters split “গানটা” into fragments.
    .replace(/[^\p{L}\p{M}\p{N}]+/gu, ' ')
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 2 && !glue.has(token))
  return [...new Set(tokens)]
}

function hostMatches(urlValue: string | undefined, expectedHost: string | undefined): boolean {
  if (!expectedHost) return false
  try {
    const actual = new URL(urlValue ?? '').hostname.toLowerCase().replace(/^www\./, '')
    const expected = expectedHost.toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, '')
    return actual === expected || actual.endsWith(`.${expected}`)
  } catch {
    return false
  }
}

function expectedYouTubeHost(expectedHost: string | undefined): boolean {
  if (!expectedHost) return false
  const normalized = expectedHost
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .replace(/\/.*$/, '')
  return normalized === 'youtube.com'
}

function youtubeVideoIdentity(urlValue: string | undefined): { videoId: string; canonicalUrl: string } | null {
  try {
    const url = new URL(urlValue ?? '')
    const host = url.hostname.toLowerCase().replace(/^www\./, '')
    if (url.protocol !== 'https:' || host !== 'youtube.com') return null
    if (url.pathname === '/watch') {
      const videoId = url.searchParams.get('v')?.trim() ?? ''
      if (!/^[A-Za-z0-9_-]{11}$/.test(videoId)) return null
      return {
        videoId,
        canonicalUrl: `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`,
      }
    }
    const shortsMatch = url.pathname.match(/^\/shorts\/([^/]+)\/?$/)
    if (!shortsMatch?.[1]) return null
    const videoId = decodeURIComponent(shortsMatch[1]).trim()
    if (!/^[A-Za-z0-9_-]{11}$/.test(videoId)) return null
    return {
      videoId,
      canonicalUrl: `https://www.youtube.com/shorts/${encodeURIComponent(videoId)}`,
    }
  } catch {
    return null
  }
}

function allExpectedTokensMatch(expectedTokens: string[], value: string | undefined): boolean {
  if (expectedTokens.length === 0) return false
  const actual = new Set(normalizedMediaTitleTokens(value ?? ''))
  return expectedTokens.every((token) => actual.has(token))
}

function ownerExplicitlyAskedForGenericMedia(ownerText: string): boolean {
  const normalized = ownerText.toLocaleLowerCase().normalize('NFKC').replace(/\s+/g, ' ').trim()
  return (
    /\b(?:play|watch|listen(?: to)?|put on)?\s*(?:(?:a|some|any)\s+)?(?:music|song|video|anything|something)\b/.test(normalized)
    || /(?:একটা|একটি|যেকোনো|কোনো)?\s*(?:মিউজিক|গান|ভিডিও)(?:টা|টি)?\s*(?:চালাও|চালান|বাজাও|বাজান|প্লে)?/.test(normalized)
    || /\b(?:ekta|jekono|kono)?\s*(?:music|gan|gaan|video)\s*(?:chalao|chalaw|bajao|play)?\b/.test(normalized)
  )
}

function matchingMediaPair(
  before: BrowserMediaSnapshot,
  after: BrowserMediaSnapshot,
): { before: BrowserMediaItem; after: BrowserMediaItem } | null {
  const first = before.media?.items ?? []
  const second = after.media?.items ?? []
  for (const afterItem of second) {
    if (
      !afterItem.playing
      || afterItem.ended
      || Number(afterItem.readyState ?? 0) < 2
      || !meaningfullyVisibleMedia(afterItem)
    ) continue
    if (!afterItem.mediaId) continue
    const beforeItem = first.find((item) =>
      item.mediaId === afterItem.mediaId
      && item.index === afterItem.index
      && (item.kind ?? '') === (afterItem.kind ?? '')
      && meaningfullyVisibleMedia(item),
    )
    if (beforeItem) return { before: beforeItem, after: afterItem }
  }
  return null
}

function meaningfullyVisibleMedia(item: BrowserMediaItem): boolean {
  return Boolean(
    item.visible === true
    && item.primary === true
    && Number(item.viewportWidth) >= 160
    && Number(item.viewportHeight) >= 90
    && Number(item.viewportArea) >= 14_400
    && item.centerExposed === true
    && Number(item.exposedPointCount) >= 3,
  )
}

/** Bind a model-supplied expectation back to the owner's actual media request. */
export function playbackExpectationMatchesRequest(ownerText: string, expectedMedia: string): boolean {
  return mediaSelectionMatchesOwnerRequest(ownerText, expectedMedia)
}

/** Strict owner-title gate for the exact observed result selected before click. */
export function mediaSelectionMatchesOwnerRequest(
  ownerText: string,
  selectedTitle: string,
  ownerDevices: PairedDeviceForOwnerRequest[] = [],
): boolean {
  const ownerMediaTitle = parseDirectMediaOwnerRequest(ownerText, ownerDevices).mediaTitle
  const selectedTokens = normalizedMediaTitleTokens(selectedTitle)
  if (selectedTokens.length === 0) return false
  const ownerTokens = normalizedMediaTitleTokens(ownerMediaTitle)
    .filter((token) => !OWNER_REQUEST_GLUE.has(token))
  // Only explicit finite generic requests may delegate the concrete choice to
  // the agent. An empty token set caused by normalization is not itself proof
  // that "Play Me" or another short title was generic.
  if (ownerTokens.length === 0) return ownerExplicitlyAskedForGenericMedia(ownerText)
  const selected = new Set(selectedTokens)
  const owner = new Set(ownerTokens)
  if (!ownerTokens.every((token) => selected.has(token))) return false
  const addedConflictingVariant = selectedTokens.some(
    (token) => CONFLICTING_MEDIA_VARIANTS.has(token) && !owner.has(token),
  )
  if (addedConflictingVariant) return false
  const semanticExtras = selectedTokens.filter(
    (token) => !owner.has(token) && !BENIGN_RESULT_METADATA.has(token),
  )
  if (semanticExtras.length === 0) return true

  // YouTube commonly prefixes an exact title with a creator attribution:
  // "Coldplay - Fix You (Official Video)". Permit only a short leading
  // delimiter-separated attribution; unknown content beside/after the title
  // remains blocked, so "Fix You piano tutorial" cannot become authorized.
  const segments = selectedTitle
    .split(/\s+(?:[-–—:])\s+|\s*\|\s*/u)
    .map((segment) => normalizedMediaTitleTokens(segment))
    .filter((segment) => segment.length > 0)
  const ownerSegmentIndex = segments.findIndex(
    (segment) => ownerTokens.every((token) => segment.includes(token)),
  )
  if (ownerSegmentIndex <= 0) return false
  const titleSegmentExtras = segments[ownerSegmentIndex].filter(
    (token) => !owner.has(token) && !BENIGN_RESULT_METADATA.has(token),
  )
  const trailingExtras = segments.slice(ownerSegmentIndex + 1)
    .flat()
    .filter((token) => !BENIGN_RESULT_METADATA.has(token))
  const attributionTokens = [...new Set(segments.slice(0, ownerSegmentIndex).flat())]
  if (
    titleSegmentExtras.length
    || trailingExtras.length
    || attributionTokens.length < 1
    || attributionTokens.length > 4
    || attributionTokens.some((token) => NON_ATTRIBUTION_CONTENT.has(token))
  ) return false
  const attribution = new Set(attributionTokens)
  return semanticExtras.every((token) => attribution.has(token))
}

/**
 * Playback is an end state, not a successful click. Prove it from two DOM
 * samples: the requested title is on the expected host, a ready media element
 * remains playing, its clock advances, and the page is not currently an ad.
 */
export function verifyBrowserPlayback(input: {
  expectedMedia: string
  expectedHost?: string
  /** Durable original owner request; model-authored expectedMedia is not authority. */
  ownerRequest?: string
  /** Exact owner-bound device lets the shared parser remove its explicit clause. */
  ownerDevice?: PairedDeviceForOwnerRequest
  /** Exact server-bound observed result identity; model expectedMedia cannot replace it. */
  selectedMedia?: { videoId: string; title: string }
  before: BrowserMediaSnapshot
  after: BrowserMediaSnapshot
}): PlaybackVerification {
  const ownerRequest = input.ownerRequest?.trim() || input.expectedMedia
  const ownerMediaTitle = parseDirectMediaOwnerRequest(
    ownerRequest,
    input.ownerDevice ? [input.ownerDevice] : [],
  ).mediaTitle
  const parsedOwnerTokens = normalizedMediaTitleTokens(ownerMediaTitle)
    .filter((token) => !OWNER_REQUEST_GLUE.has(token))
  const genericOwnerRequest = parsedOwnerTokens.length === 0
    && ownerExplicitlyAskedForGenericMedia(ownerRequest)
  // For a concrete request, proof always consumes the server-extracted owner
  // title—not the model-authored expectedMedia. A genuinely generic request may
  // bind the concrete observed selection instead.
  const authoritativeExpectedMedia = genericOwnerRequest
    ? input.selectedMedia?.title || input.expectedMedia
    : ownerMediaTitle
  const expectedTokens = normalizedMediaTitleTokens(authoritativeExpectedMedia)
  const youtubeExpected = expectedYouTubeHost(input.expectedHost)
  const beforeRoute = youtubeExpected ? youtubeVideoIdentity(input.before.url) : null
  const afterRoute = youtubeExpected ? youtubeVideoIdentity(input.after.url) : null
  const canonicalIdentity = youtubeExpected ? youtubeVideoIdentity(input.after.youtube?.canonicalUrl) : null
  const pageTitle = youtubeExpected ? input.after.youtube?.title : input.after.title
  const titleTokens = new Set(normalizedMediaTitleTokens(pageTitle ?? ''))
  const matchedTitleTokens = expectedTokens.filter((token) => titleTokens.has(token))
  // Artist-only overlap is not enough: "Taylor Swift – Blank Space" must not
  // satisfy "Taylor Swift Love Story". Every meaningful requested token must
  // occur in the final page title; false negatives are safer than a wrong song.
  const requiredTitleTokenMatches = expectedTokens.length
  const titleMatched = requiredTitleTokenMatches > 0 && matchedTitleTokens.length === requiredTitleTokenMatches
  const hostMatched = hostMatches(input.after.url, input.expectedHost)
  const pair = matchingMediaPair(input.before, input.after)
  const canonicalMediaPage = !youtubeExpected || Boolean(
    beforeRoute
    && afterRoute
    && beforeRoute.videoId === afterRoute.videoId
    && canonicalIdentity
    && canonicalIdentity.videoId === afterRoute.videoId
    && input.before.youtube?.videoId === afterRoute.videoId
    && input.after.youtube?.videoId === afterRoute.videoId,
  )
  const mediaPageIdentityMatched = !youtubeExpected || Boolean(
    pair
    && afterRoute
    && pair.before.youtubeVideoId === afterRoute.videoId
    && pair.after.youtubeVideoId === afterRoute.videoId,
  )
  const mediaTitleMatched = !youtubeExpected || Boolean(
    pair
    && allExpectedTokensMatch(expectedTokens, pair.before.youtubeTitle)
    && allExpectedTokensMatch(expectedTokens, pair.after.youtubeTitle),
  )
  const selectedMediaIdentityMatched = !input.selectedMedia || Boolean(
    beforeRoute
    && afterRoute
    && beforeRoute.videoId === input.selectedMedia.videoId
    && afterRoute.videoId === input.selectedMedia.videoId
    && canonicalIdentity?.videoId === input.selectedMedia.videoId
    && input.before.youtube?.videoId === input.selectedMedia.videoId
    && input.after.youtube?.videoId === input.selectedMedia.videoId
    && pair?.before.youtubeVideoId === input.selectedMedia.videoId
    && pair.after.youtubeVideoId === input.selectedMedia.videoId,
  )
  const selectedTitleTokens = normalizedMediaTitleTokens(input.selectedMedia?.title ?? '')
  const selectedMediaTitleMatched = !input.selectedMedia || Boolean(
    selectedTitleTokens.length
    && mediaSelectionMatchesOwnerRequest(input.selectedMedia.title, pageTitle ?? '')
    && mediaSelectionMatchesOwnerRequest(input.selectedMedia.title, pair?.before.youtubeTitle ?? '')
    && mediaSelectionMatchesOwnerRequest(input.selectedMedia.title, pair?.after.youtubeTitle ?? ''),
  )
  const ownerTitleTokens = new Set(
    parsedOwnerTokens,
  )
  const observedTitleTokens = new Set([
    ...normalizedMediaTitleTokens(pageTitle ?? ''),
    ...normalizedMediaTitleTokens(pair?.before.youtubeTitle ?? ''),
    ...normalizedMediaTitleTokens(pair?.after.youtubeTitle ?? ''),
  ])
  const unrequestedMediaVariants = [...observedTitleTokens].filter(
    (token) => CONFLICTING_MEDIA_VARIANTS.has(token) && !ownerTitleTokens.has(token),
  )
  const mediaVariantMatched = unrequestedMediaVariants.length === 0
  const sameDocument = Boolean(
    input.before.documentId
    && input.after.documentId
    && input.before.documentId === input.after.documentId
    && input.before.url
    && input.before.url === input.after.url,
  )
  const sameMedia = Boolean(pair)
  const mediaVisible = Boolean(pair?.after.visible === true && pair.after.primary === true)
  const beforeTime = Number(pair?.before.currentTime)
  const afterTime = Number(pair?.after.currentTime)
  const progressSeconds = Number.isFinite(beforeTime) && Number.isFinite(afterTime)
    ? Math.round((afterTime - beforeTime) * 1000) / 1000
    : null
  const mediaPlaying = Boolean(input.after.media?.playing && pair?.after.playing && !pair.after.ended)
  const mediaReady = Boolean(pair && Number(pair.after.readyState ?? 0) >= 2)
  // Missing audio fields are UNKNOWN, never evidence. This proves the HTML
  // player and Chrome tab are unmuted; macOS output volume remains outside DOM.
  const mediaAudible = Boolean(
    pair
    && typeof pair.after.muted === 'boolean'
    && typeof pair.after.volume === 'number'
    && typeof input.after.media?.tabMuted === 'boolean'
    && pair.after.muted === false
    && pair.after.volume > 0
    && input.after.media.tabMuted === false,
  )
  const foregroundWitnessed = Boolean(
    input.before.media?.tabActive === true
    && input.before.media?.windowFocused === true
    && input.after.media?.tabActive === true
    && input.after.media?.windowFocused === true,
  )
  const timeAdvanced = progressSeconds !== null && progressSeconds >= 0.25
  const adPlaying = Boolean(input.before.media?.adPlaying || input.after.media?.adPlaying)
  const reasons: string[] = []
  if (!input.expectedHost) reasons.push('expected_host_missing')
  else if (!hostMatched) reasons.push('wrong_host')
  if (!canonicalMediaPage) reasons.push('youtube_final_url_or_page_identity_mismatch')
  if (!titleMatched) reasons.push('title_mismatch')
  if (!mediaPageIdentityMatched) reasons.push('youtube_media_page_identity_mismatch')
  if (!mediaTitleMatched) reasons.push('youtube_media_title_mismatch')
  if (!selectedMediaIdentityMatched) reasons.push('selected_media_identity_mismatch')
  if (!selectedMediaTitleMatched) reasons.push('selected_media_title_mismatch')
  if (!mediaVariantMatched) reasons.push('unrequested_media_variant')
  if (!sameDocument) reasons.push('document_changed')
  if (!sameMedia) reasons.push('media_identity_changed')
  if (!mediaVisible) reasons.push('media_not_visible')
  if (!mediaPlaying) reasons.push('media_not_playing')
  if (!mediaReady) reasons.push('media_not_ready')
  if (!mediaAudible) reasons.push('media_muted')
  if (!foregroundWitnessed) reasons.push('media_not_foreground_witnessed')
  if (!timeAdvanced) reasons.push('time_not_advancing')
  if (adPlaying) reasons.push('ad_playing')

  return {
    verified: reasons.length === 0,
    expectedMedia: authoritativeExpectedMedia,
    expectedHost: input.expectedHost ?? null,
    hostMatched,
    canonicalMediaPage,
    titleMatched,
    mediaPageIdentityMatched,
    mediaTitleMatched,
    mediaVariantMatched,
    selectedMediaIdentityMatched,
    selectedMediaTitleMatched,
    unrequestedMediaVariants,
    matchedTitleTokens,
    requiredTitleTokenMatches,
    sameDocument,
    sameMedia,
    mediaVisible,
    mediaPlaying,
    mediaReady,
    mediaAudible,
    foregroundWitnessed,
    timeAdvanced,
    progressSeconds,
    adPlaying,
    reasons,
  }
}
