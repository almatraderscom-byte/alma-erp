import type { BusinessId } from '@/lib/businesses'
import {
  AGENT_REFERENCE_VERSION,
  DEFAULT_REFERENCE_ROLES,
  type AgentReferenceContext,
  type AgentReferenceEntityV1,
  type AgentReferenceKind,
  type AgentReferencePurpose,
  type AgentReferenceSource,
  type AgentReferenceV1,
} from './types'
import {
  cleanReferenceLabel,
  deterministicReferenceId,
  normalizeReferenceEntityId,
  uniqueReferenceAliases,
} from './internal-registry'
import { shouldCollectAgentReferences } from './flags'

export const MAX_VERIFIED_URL_LENGTH = 4_096
const UNSAFE_URL_CHAR = /[\u0000-\u001f\u007f\\]/
const SENSITIVE_QUERY_KEY = /(?:^|[_-])(?:(?:access|refresh|id)[_-]?)?token(?:$|[_-])|(?:^|[_-])(?:auth(?:orization)?|oauth|session|sid|secret|password|passwd|api[_-]?key|client[_-]?secret|signature|signed|sig|code|state)(?:$|[_-])/i
const TRACKING_QUERY_KEY = /^(?:fbclid|gclid|dclid|msclkid|mc_[ce]id|utm_(?:source|medium|campaign|term|content|id))$/i
const REDIRECT_QUERY_KEY = /^(?:redirect|redirect_uri|return|return_to|return_url|continue|next|dest|destination)$/i
const SAFE_TIMESTAMP = /^(?:\d{1,7}|(?:\d{1,4}h)?(?:\d{1,4}m)?(?:\d{1,7}s)?)$/i

export type VerifiedExternalProvider =
  | 'youtube'
  | 'facebook'
  | 'instagram'
  | 'meta'
  | 'google_maps'
  | 'web'

export interface SanitizedExternalUrl {
  url: string
  hostname: string
  provider: VerifiedExternalProvider
  strippedQueryKeys: string[]
}

export type ExternalUrlValidation =
  | { ok: true; value: SanitizedExternalUrl }
  | { ok: false; reason: string }

function parseIpv4(hostname: string): number[] | null {
  const pieces = hostname.split('.')
  if (pieces.length !== 4) return null
  const values = pieces.map((part) => Number(part))
  return values.every((value) => Number.isInteger(value) && value >= 0 && value <= 255)
    ? values
    : null
}

function isPrivateIpv4(parts: number[]): boolean {
  const [a, b] = parts
  return a === 0
    || a === 10
    || a === 127
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 0)
    || (a === 192 && b === 168)
    || (a === 198 && (b === 18 || b === 19))
    || a >= 224
}

function parseIpv6Bytes(hostname: string): number[] | null {
  let host = hostname.toLowerCase().replace(/^\[|\]$/g, '')
  if (!host.includes(':') || host.includes('%')) return null
  const dottedMatch = /(?:^|:)(\d{1,3}(?:\.\d{1,3}){3})$/.exec(host)
  if (dottedMatch) {
    const ipv4 = parseIpv4(dottedMatch[1])
    if (!ipv4) return null
    const hexTail = `${((ipv4[0] << 8) | ipv4[1]).toString(16)}:${((ipv4[2] << 8) | ipv4[3]).toString(16)}`
    host = host.slice(0, -dottedMatch[1].length) + hexTail
  }
  if ((host.match(/::/g) ?? []).length > 1) return null
  const [leftRaw, rightRaw] = host.split('::')
  const left = leftRaw ? leftRaw.split(':') : []
  const right = rightRaw ? rightRaw.split(':') : []
  if ([...left, ...right].some((group) => !/^[0-9a-f]{1,4}$/.test(group))) return null
  const missing = host.includes('::') ? 8 - left.length - right.length : 0
  if (missing < 0 || (!host.includes('::') && left.length !== 8)) return null
  const groups = [...left, ...Array.from({ length: missing }, () => '0'), ...right]
  if (groups.length !== 8) return null
  return groups.flatMap((group) => {
    const value = Number.parseInt(group, 16)
    return [value >>> 8, value & 0xff]
  })
}

function isUnsafeIpv6(bytes: number[]): boolean {
  const allZero = bytes.every((byte) => byte === 0)
  const loopback = bytes.slice(0, 15).every((byte) => byte === 0) && bytes[15] === 1
  if (allZero || loopback) return true
  if ((bytes[0] & 0xfe) === 0xfc) return true // fc00::/7 unique-local
  if (bytes[0] === 0xfe && (bytes[1] & 0xc0) === 0x80) return true // fe80::/10 link-local
  if (bytes[0] === 0xfe && (bytes[1] & 0xc0) === 0xc0) return true // fec0::/10 site-local
  if (bytes[0] === 0xff) return true // multicast

  const firstTenZero = bytes.slice(0, 10).every((byte) => byte === 0)
  if (firstTenZero && bytes[10] === 0xff && bytes[11] === 0xff) {
    return isPrivateIpv4(bytes.slice(12)) // ::ffff:IPv4
  }
  // Deprecated IPv4-compatible ::/96 is ambiguous across URL/network stacks.
  if (bytes.slice(0, 12).every((byte) => byte === 0)) return true
  // NAT64 well-known prefix and 6to4 both embed an IPv4 destination. Refuse
  // private/reserved embeddings so an apparently public IPv6 URL cannot bounce
  // a server-side fetch toward local infrastructure.
  if (bytes.slice(0, 12).join('.') === '0.100.255.155.0.0.0.0.0.0.0.0'
    && isPrivateIpv4(bytes.slice(12))) return true // 64:ff9b::/96
  if (bytes[0] === 0x20 && bytes[1] === 0x02
    && isPrivateIpv4(bytes.slice(2, 6))) return true // 2002:V4ADDR::/48
  return false
}

function isUnsafeHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '')
  if (!host || host.length > 253) return true
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) return true
  // Public external references must use a fully-qualified host. This also blocks
  // common intranet/service names such as `redis`, `db`, and `metadata`.
  if (!host.includes('.') && !host.includes(':')) return true
  // URL converts Unicode IDNs to punycode. Rejecting xn-- prevents a visually
  // confusable hostname from being presented as a trusted provider domain.
  if (host.split('.').some((label) => label.startsWith('xn--'))) return true
  const ipv4 = parseIpv4(host)
  if (ipv4) return isPrivateIpv4(ipv4)
  if (host.includes(':')) {
    const ipv6 = parseIpv6Bytes(host)
    return !ipv6 || isUnsafeIpv6(ipv6)
  }
  return false
}

function providerForHostname(hostname: string): VerifiedExternalProvider {
  const host = hostname.toLowerCase()
  if (host === 'youtu.be' || host === 'youtube.com' || host.endsWith('.youtube.com')) return 'youtube'
  if (host === 'instagram.com' || host.endsWith('.instagram.com')) return 'instagram'
  if (host === 'facebook.com' || host.endsWith('.facebook.com') || host === 'fb.com' || host.endsWith('.fb.com')) return 'facebook'
  if (host === 'meta.com' || host.endsWith('.meta.com')) return 'meta'
  if (host === 'maps.google.com' || host === 'maps.google.co.uk' || host === 'goo.gl') return 'google_maps'
  return 'web'
}

const META_LEVEL_QUERY_KEYS: Record<
  'campaign' | 'ad_set' | 'ad' | 'creative' | 'commerce_order',
  readonly string[]
> = {
  campaign: ['campaign_id', 'selected_campaign_ids'],
  ad_set: ['adset_id', 'ad_set_id', 'selected_adset_ids', 'selected_ad_set_ids'],
  ad: ['ad_id', 'selected_ad_ids'],
  creative: ['creative_id', 'selected_creative_ids'],
  commerce_order: ['order_id', 'commerce_order_id', 'selected_order_ids'],
}

function normalizedMetaId(value: string): string {
  return value.toLowerCase().startsWith('act_') ? value.slice(4) : value
}

function queryContainsExactId(url: URL, keys: readonly string[], expected: string): boolean {
  const wanted = normalizedMetaId(expected)
  return keys.some((key) => url.searchParams.getAll(key).some((raw) =>
    raw.split(',').map((value) => normalizedMetaId(value.trim())).includes(wanted)))
}

function pathContainsExactId(url: URL, expected: string): boolean {
  const wanted = normalizedMetaId(expected)
  return url.pathname.split('/').filter(Boolean).some((raw) => {
    try {
      return normalizedMetaId(decodeURIComponent(raw)) === wanted
    } catch {
      return false
    }
  })
}

/**
 * Meta object links are accepted only when the provider-returned URL itself
 * proves the same account, level and object identity carried by the tool row.
 * A Facebook homepage paired with plausible IDs is deliberately insufficient.
 */
export function isCanonicalMetaObjectUrl(input: {
  rawUrl: unknown
  adAccountId: string
  level: 'campaign' | 'ad_set' | 'ad' | 'creative' | 'commerce_order'
  objectId: string
}): boolean {
  const checked = validateAndSanitizeExternalUrl(input.rawUrl)
  if (!checked.ok || !['facebook', 'instagram', 'meta'].includes(checked.value.provider)) return false
  const url = new URL(checked.value.url)
  const isCommerce = input.level === 'commerce_order'
  if (!isCommerce && checked.value.provider !== 'facebook') return false
  if (!isCommerce && !url.pathname.toLowerCase().includes('/adsmanager/')) return false

  const accountKeys = ['act', 'account_id', 'ad_account_id', 'commerce_account_id', 'business_id']
  const hasAccount = queryContainsExactId(url, accountKeys, input.adAccountId)
    || (isCommerce && pathContainsExactId(url, input.adAccountId))
  const hasObject = queryContainsExactId(url, META_LEVEL_QUERY_KEYS[input.level], input.objectId)
    || pathContainsExactId(url, input.objectId)
  if (!hasAccount || !hasObject) return false

  if (!isCommerce) {
    const expectedSurface = input.level === 'campaign'
      ? 'campaigns'
      : input.level === 'ad_set'
        ? 'adsets'
        : input.level === 'ad'
          ? 'ads'
          : 'creatives'
    const path = url.pathname.toLowerCase()
    if (!path.includes(`/${expectedSurface}`)
      && !queryContainsExactId(url, META_LEVEL_QUERY_KEYS[input.level], input.objectId)) return false
  }
  return true
}

function normalizePort(url: URL): void {
  if ((url.protocol === 'https:' && url.port === '443') || (url.protocol === 'http:' && url.port === '80')) {
    url.port = ''
  }
}

/** Canonical security boundary for every external destination. */
export function validateAndSanitizeExternalUrl(rawValue: unknown): ExternalUrlValidation {
  if (typeof rawValue !== 'string') return { ok: false, reason: 'not_string' }
  const raw = rawValue.trim()
  if (!raw || raw.length > MAX_VERIFIED_URL_LENGTH) return { ok: false, reason: 'empty_or_too_long' }
  if (UNSAFE_URL_CHAR.test(raw) || raw.startsWith('//')) return { ok: false, reason: 'unsafe_char_or_protocol_relative' }

  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return { ok: false, reason: 'malformed' }
  }
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || !url.hostname) {
    return { ok: false, reason: 'unsafe_scheme' }
  }
  if (url.username || url.password) return { ok: false, reason: 'credentials' }
  if (isUnsafeHostname(url.hostname)) return { ok: false, reason: 'private_or_spoofed_host' }

  const strippedQueryKeys: string[] = []
  for (const key of [...url.searchParams.keys()]) {
    if (SENSITIVE_QUERY_KEY.test(key)) {
      strippedQueryKeys.push(key)
      url.searchParams.delete(key)
      continue
    }
    if (REDIRECT_QUERY_KEY.test(key)) {
      return { ok: false, reason: 'unsafe_redirect' }
    }
    if (TRACKING_QUERY_KEY.test(key)) {
      strippedQueryKeys.push(key)
      url.searchParams.delete(key)
    }
  }
  // Fragments frequently carry OAuth bearer tokens. YouTube timestamps are the
  // only fragment semantics retained, and are normalized to a query parameter.
  if (url.hash) {
    const match = /^#t=(.+)$/i.exec(url.hash)
    if (providerForHostname(url.hostname) === 'youtube' && match && SAFE_TIMESTAMP.test(match[1])) {
      if (!url.searchParams.has('t')) url.searchParams.set('t', match[1])
    }
    url.hash = ''
  }
  normalizePort(url)
  const serialized = url.toString()
  if (serialized.length > MAX_VERIFIED_URL_LENGTH) return { ok: false, reason: 'canonical_too_long' }
  return {
    ok: true,
    value: {
      url: serialized,
      hostname: url.hostname.toLowerCase(),
      provider: providerForHostname(url.hostname),
      strippedQueryKeys,
    },
  }
}

export interface NormalizedYouTubeUrl extends SanitizedExternalUrl {
  objectType: 'video' | 'channel' | 'playlist' | 'search_result'
  objectId?: string
  timestamp?: string
}

export function normalizeYouTubeUrl(rawValue: unknown): NormalizedYouTubeUrl | null {
  const checked = validateAndSanitizeExternalUrl(rawValue)
  if (!checked.ok || checked.value.provider !== 'youtube') return null
  const parsed = new URL(checked.value.url)
  const host = parsed.hostname.toLowerCase()
  let objectType: NormalizedYouTubeUrl['objectType']
  let objectId: string | undefined

  if (host === 'youtu.be') {
    objectType = 'video'
    objectId = parsed.pathname.split('/').filter(Boolean)[0]
  } else if (parsed.pathname === '/watch') {
    objectType = 'video'
    objectId = parsed.searchParams.get('v') ?? undefined
  } else if (parsed.pathname.startsWith('/shorts/')) {
    objectType = 'video'
    objectId = parsed.pathname.split('/')[2]
  } else if (parsed.pathname === '/playlist') {
    objectType = 'playlist'
    objectId = parsed.searchParams.get('list') ?? undefined
  } else if (parsed.pathname === '/results') {
    objectType = 'search_result'
  } else if (parsed.pathname.startsWith('/channel/') || /^\/@[^/]+/.test(parsed.pathname)) {
    objectType = 'channel'
    objectId = parsed.pathname.split('/').filter(Boolean)[0]
    if (objectId === 'channel') objectId = parsed.pathname.split('/').filter(Boolean)[1]
  } else {
    return null
  }

  if (objectType !== 'search_result' && !objectId) return null
  if (objectType === 'video' && objectId && !/^[A-Za-z0-9_-]{11}$/.test(objectId)) return null
  if (objectType === 'playlist' && objectId && !/^[A-Za-z0-9_-]{10,128}$/.test(objectId)) return null
  if (objectType === 'channel' && objectId
    && !/^(?:UC[A-Za-z0-9_-]{20,30}|@[A-Za-z0-9_.-]{3,100})$/.test(objectId)) return null
  const timestamp = parsed.searchParams.get('t') ?? parsed.searchParams.get('start') ?? undefined
  if (timestamp && !SAFE_TIMESTAMP.test(timestamp)) return null

  if (objectType === 'video' && objectId) {
    const canonical = new URL('https://www.youtube.com/watch')
    canonical.searchParams.set('v', objectId)
    const list = parsed.searchParams.get('list')
    if (list && /^[A-Za-z0-9_-]{3,128}$/.test(list)) canonical.searchParams.set('list', list)
    if (timestamp) canonical.searchParams.set('t', timestamp)
    parsed.href = canonical.href
  } else if (objectType === 'playlist' && objectId) {
    const canonical = new URL('https://www.youtube.com/playlist')
    canonical.searchParams.set('list', objectId)
    parsed.href = canonical.href
  }

  return {
    ...checked.value,
    url: parsed.toString(),
    hostname: parsed.hostname,
    objectType,
    objectId,
    timestamp,
  }
}

export function canonicalYouTubeUrlFromVerifiedId(input: {
  type: 'video' | 'channel' | 'playlist'
  id: unknown
  timestamp?: unknown
}): string | null {
  const rawId = typeof input.id === 'string' ? input.id.trim() : ''
  const id = input.type === 'channel' && /^@[A-Za-z0-9_.-]{3,100}$/.test(rawId)
    ? rawId
    : normalizeReferenceEntityId(rawId)
  if (!id) return null
  if (input.type === 'video' && !/^[A-Za-z0-9_-]{11}$/.test(id)) return null
  if (input.type === 'playlist' && !/^[A-Za-z0-9_-]{10,128}$/.test(id)) return null
  if (input.type === 'channel'
    && !/^(?:UC[A-Za-z0-9_-]{20,30}|@[A-Za-z0-9_.-]{3,100})$/.test(id)) return null
  const timestamp = typeof input.timestamp === 'string' && SAFE_TIMESTAMP.test(input.timestamp)
    ? input.timestamp
    : null
  if (input.type === 'video') {
    const url = new URL('https://www.youtube.com/watch')
    url.searchParams.set('v', id)
    if (timestamp) url.searchParams.set('t', timestamp)
    return url.toString()
  }
  if (input.type === 'playlist') {
    const url = new URL('https://www.youtube.com/playlist')
    url.searchParams.set('list', id)
    return url.toString()
  }
  return id.startsWith('@')
    ? `https://www.youtube.com/${id}`
    : `https://www.youtube.com/channel/${encodeURIComponent(id)}`
}

function observedAt(context: AgentReferenceContext): string {
  return context.observedAt && !Number.isNaN(Date.parse(context.observedAt))
    ? new Date(context.observedAt).toISOString()
    : new Date().toISOString()
}

export function buildExternalReference(input: {
  rawUrl: unknown
  label?: unknown
  kind?: Extract<AgentReferenceKind, 'external_object' | 'external_source' | 'external_media'>
  purpose?: Extract<AgentReferencePurpose, 'source' | 'evidence' | 'media' | 'navigate'>
  source: AgentReferenceSource
  sourceTool?: string
  outputPath?: string
  connector?: string
  entity?: AgentReferenceEntityV1
  mediaType?: string
  context?: AgentReferenceContext
}): AgentReferenceV1 | null {
  const youtube = normalizeYouTubeUrl(input.rawUrl)
  const checked = youtube
    ? { ok: true as const, value: youtube }
    : validateAndSanitizeExternalUrl(input.rawUrl)
  if (!checked.ok) return null
  const value = checked.value
  const context = input.context ?? {}
  const kind = input.kind ?? (value.provider === 'youtube' && youtube?.objectType !== 'search_result'
    ? 'external_media'
    : 'external_source')
  const purpose = input.purpose ?? (kind === 'external_media' ? 'media' : 'source')
  const label = cleanReferenceLabel(input.label, value.hostname)
  const entityValue = input.entity ?? (youtube?.objectId
    ? {
        namespace: `youtube_${youtube.objectType}`,
        type: youtube.objectType,
        id: youtube.objectId,
      }
    : undefined)
  const businessId = context.businessId ?? null
  const openMode = value.provider === 'youtube'
    || value.provider === 'facebook'
    || value.provider === 'instagram'
    || value.provider === 'meta'
    ? 'universal_link_first' as const
    : 'protected_web' as const
  return {
    version: AGENT_REFERENCE_VERSION,
    refId: deterministicReferenceId(['external', kind, value.url, entityValue?.namespace ?? '', entityValue?.id ?? '']),
    kind,
    label,
    destination: {
      type: kind,
      url: value.url,
      provider: value.provider,
      hostname: value.hostname,
      mediaType: input.mediaType,
    },
    entity: entityValue,
    purpose,
    audience: {
      businessId,
      businessScope: businessId ? 'exact' : 'personal',
      roles: [...(context.roles ?? DEFAULT_REFERENCE_ROLES)],
    },
    provenance: {
      source: input.source,
      verifiedBy: 'canonical_url_validator',
      sourceTool: input.sourceTool,
      outputPath: input.outputPath,
      connector: input.connector,
    },
    observedAt: observedAt(context),
    openMode,
    aliases: uniqueReferenceAliases([label, value.url, entityValue?.id]),
    display: { provider: value.provider, domain: value.hostname },
  }
}

export function buildVerifiedMetaObjectReference(input: {
  rawUrl: unknown
  label?: unknown
  adAccountId: unknown
  level: 'campaign' | 'ad_set' | 'ad' | 'creative' | 'commerce_order'
  objectId: unknown
  sourceTool: string
  outputPath: string
  context?: AgentReferenceContext
}): AgentReferenceV1 | null {
  const accountId = normalizeReferenceEntityId(input.adAccountId)
  const objectId = normalizeReferenceEntityId(input.objectId)
  if (!accountId || !objectId) return null
  const checked = validateAndSanitizeExternalUrl(input.rawUrl)
  if (!checked.ok || !['facebook', 'instagram', 'meta'].includes(checked.value.provider)) return null
  if (!isCanonicalMetaObjectUrl({
    rawUrl: checked.value.url,
    adAccountId: accountId,
    level: input.level,
    objectId,
  })) return null
  return buildExternalReference({
    rawUrl: checked.value.url,
    label: input.label,
    kind: 'external_object',
    purpose: 'navigate',
    source: 'tool_output',
    sourceTool: input.sourceTool,
    outputPath: input.outputPath,
    context: input.context,
    entity: {
      namespace: input.level === 'commerce_order' ? 'meta_commerce_order' : `meta_${input.level}`,
      type: input.level,
      id: objectId,
      accountId,
      level: input.level,
    },
  })
}

/** URLs typed by the owner are verified provenance; URLs invented later by a model are not. */
export function extractUserProvidedReferences(
  text: string,
  context: AgentReferenceContext = {},
): AgentReferenceV1[] {
  if (!shouldCollectAgentReferences()) return []
  const matches = text.match(/https?:\/\/[^\s<>"'`]+/gi) ?? []
  const out: AgentReferenceV1[] = []
  const seen = new Set<string>()
  for (const match of matches) {
    const rawUrl = match.replace(/[),.;!?\]}]+$/g, '')
    const ref = buildExternalReference({
      rawUrl,
      label: rawUrl,
      source: 'user_provided',
      outputPath: 'user_message',
      context,
    })
    if (!ref || seen.has(ref.refId)) continue
    seen.add(ref.refId)
    out.push(ref)
  }
  return out.slice(0, 20)
}

export function externalReferenceBusinessId(reference: AgentReferenceV1): BusinessId | null {
  return reference.audience.businessId
}
