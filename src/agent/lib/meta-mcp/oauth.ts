/**
 * Meta Ads MCP — OAuth 2.1 (Phase MA1).
 *
 * Mirrors the GSC connect pattern (src/agent/lib/gsc.ts + gsc-auth routes): the
 * owner clicks "Connect Meta Ads" once, consents on Meta's Business OAuth
 * dialog, and the callback stores tokens in agent_kv_settings. No long-lived
 * token rotation pain — Meta's MCP OAuth flow manages expiry via refresh_token.
 *
 * Flow (MCP authorization spec, verified live against mcp.facebook.com 2026-07-17):
 *   1. Discovery — the endpoint 401s with
 *      `www-authenticate: Bearer resource_metadata="https://mcp.facebook.com/.well-known/oauth-protected-resource/ads"`.
 *      That RFC 9728 document names the authorization server; its RFC 8414
 *      metadata gives authorization/token/registration endpoints.
 *   2. Client — dynamic client registration (RFC 7591) when Meta offers a
 *      registration_endpoint; otherwise fall back to the owner's existing app
 *      credentials (ALMA AI AGENT, App ID 1990978398451639 — plan §8 decision).
 *      Env META_MCP_CLIENT_ID / META_MCP_CLIENT_SECRET override both.
 *   3. PKCE (S256) authorization-code flow. Serverless has no session memory,
 *      so the verifier rides in agent_kv_settings keyed by the state param.
 *   4. Tokens stored under `meta_mcp_oauth:tokens`; refreshed on demand.
 *
 * Scope tier (plan §2.4): kv `meta_mcp_scope_tier` ∈ read | write | financial,
 * default READ — MA1 connects read-only. Upgrading = owner re-runs Connect at a
 * higher tier (MA3). The tier→scopes mapping below is authored from the scope
 * set the live endpoint advertises in its www-authenticate header.
 */
import crypto from 'node:crypto'
import { prisma } from '@/lib/prisma'

export const META_MCP_DEFAULT_ENDPOINT = 'https://mcp.facebook.com/ads'
/** Owner's ALMA AI AGENT app — public App ID, documented fallback client (plan §8). */
const FALLBACK_CLIENT_ID = '1990978398451639'

// agent_kv_settings keys (all additive — no schema change)
export const KV_TOKENS = 'meta_mcp_oauth:tokens'
export const KV_META = 'meta_mcp_oauth:meta'
export const KV_CLIENT = 'meta_mcp_oauth:client'
export const KV_PKCE_PREFIX = 'meta_mcp_oauth:pkce:'
export const KV_SCOPE_TIER = 'meta_mcp_scope_tier'
export const KV_ENABLED = 'meta_mcp_enabled'

export type MetaMcpScopeTier = 'read' | 'write' | 'financial'

/**
 * Tier → Meta OAuth scopes. Authored from the live endpoint's advertised set:
 * "ads_management ads_read catalog_management business_management
 *  pages_show_list instagram_basic ads_mcp_management".
 * READ deliberately excludes every *_management scope that can mutate ads or
 * catalogs; Meta's Business dialog additionally grants per-ad-account tiers.
 */
const TIER_SCOPES: Record<MetaMcpScopeTier, string[]> = {
  read: ['ads_read', 'business_management', 'pages_show_list', 'ads_mcp_management'],
  write: [
    'ads_read',
    'business_management',
    'pages_show_list',
    'ads_mcp_management',
    'ads_management',
    'catalog_management',
    'instagram_basic',
  ],
  // "financial" (budget edits) is granted inside Meta's dialog per ad account —
  // the OAuth scope string is the same as write (plan §1 auth row).
  financial: [
    'ads_read',
    'business_management',
    'pages_show_list',
    'ads_mcp_management',
    'ads_management',
    'catalog_management',
    'instagram_basic',
  ],
}

export function getMetaMcpEndpoint(): string {
  return (process.env.META_MCP_ENDPOINT || META_MCP_DEFAULT_ENDPOINT).replace(/\/$/, '')
}

/** Env half of the kill switch (default OFF — plan §2.5). */
export function isMetaMcpEnvEnabled(): boolean {
  const v = (process.env.META_MCP_ENABLED ?? '').trim().toLowerCase()
  return ['1', 'true', 'on', 'yes'].includes(v)
}

/** kv half of the kill switch — owner toggle without redeploy. Default ON (env is the master). */
export async function isMetaMcpKvEnabled(): Promise<boolean> {
  try {
    const row = await prisma.agentKvSetting.findUnique({ where: { key: KV_ENABLED } })
    if (!row?.value) return true
    return !['off', 'false', '0', 'no', 'disabled'].includes(row.value.trim().toLowerCase())
  } catch {
    return true
  }
}

/** Full kill switch: env AND kv. Every bridge tool checks this before calling out. */
export async function isMetaMcpEnabled(): Promise<boolean> {
  if (!isMetaMcpEnvEnabled()) return false
  return isMetaMcpKvEnabled()
}

export async function getMetaMcpScopeTier(): Promise<MetaMcpScopeTier> {
  try {
    const row = await prisma.agentKvSetting.findUnique({ where: { key: KV_SCOPE_TIER } })
    const v = row?.value?.trim().toLowerCase()
    if (v === 'write' || v === 'financial') return v
    return 'read'
  } catch {
    return 'read'
  }
}

// ── kv helpers ───────────────────────────────────────────────────────────────

async function kvGetJson<T>(key: string): Promise<T | null> {
  try {
    const row = await prisma.agentKvSetting.findUnique({ where: { key }, select: { value: true } })
    if (!row?.value) return null
    return JSON.parse(row.value) as T
  } catch {
    return null
  }
}

async function kvSetJson(key: string, value: unknown): Promise<void> {
  const v = JSON.stringify(value)
  await prisma.agentKvSetting.upsert({
    where: { key },
    create: { key, value: v },
    update: { value: v },
  })
}

// ── Discovery (RFC 9728 + RFC 8414) ─────────────────────────────────────────

export type AuthServerMetadata = {
  issuer?: string
  authorization_endpoint: string
  token_endpoint: string
  registration_endpoint?: string
  scopes_supported?: string[]
  code_challenge_methods_supported?: string[]
}

type DiscoveryCache = { authServer: string; metadata: AuthServerMetadata; fetchedAt: string }

const DISCOVERY_TTL_MS = 24 * 60 * 60 * 1000

async function fetchJson(url: string): Promise<Record<string, unknown> | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000) })
    if (!res.ok) return null
    return (await res.json()) as Record<string, unknown>
  } catch {
    return null
  }
}

/**
 * Resolve the authorization server + its metadata for the MCP endpoint,
 * cached in kv for a day (Meta's MCP auth is new — plan §8 isolates all of
 * this here so spec drift is a one-file fix).
 */
export async function discoverAuthServer(force = false): Promise<AuthServerMetadata> {
  if (!force) {
    const cached = await kvGetJson<DiscoveryCache>(KV_META)
    if (cached?.metadata?.token_endpoint && Date.now() - Date.parse(cached.fetchedAt) < DISCOVERY_TTL_MS) {
      return cached.metadata
    }
  }

  const endpoint = new URL(getMetaMcpEndpoint())
  // RFC 9728 path-aware form first (what the live 401 advertises), then root.
  const candidates = [
    `${endpoint.origin}/.well-known/oauth-protected-resource${endpoint.pathname}`,
    `${endpoint.origin}/.well-known/oauth-protected-resource`,
  ]
  let authServer = ''
  for (const url of candidates) {
    const doc = await fetchJson(url)
    const servers = doc?.authorization_servers
    if (Array.isArray(servers) && typeof servers[0] === 'string') {
      authServer = servers[0].replace(/\/$/, '')
      break
    }
  }
  // Last resort: Meta's OAuth lives on facebook.com (documented fallback, not a guess
  // we invent silently — the status route surfaces which path was used).
  if (!authServer) authServer = 'https://www.facebook.com'

  const asCandidates = [
    `${authServer}/.well-known/oauth-authorization-server`,
    `${authServer}/.well-known/openid-configuration`,
  ]
  let metadata: AuthServerMetadata | null = null
  for (const url of asCandidates) {
    const doc = await fetchJson(url)
    if (doc?.authorization_endpoint && doc?.token_endpoint) {
      metadata = doc as unknown as AuthServerMetadata
      break
    }
  }
  if (!metadata) {
    // Meta's classic OAuth dialog endpoints — final fallback so a missing
    // metadata document degrades to the owner's app-credential path.
    metadata = {
      issuer: authServer,
      authorization_endpoint: 'https://www.facebook.com/dialog/oauth',
      token_endpoint: 'https://graph.facebook.com/oauth/access_token',
    }
  }

  await kvSetJson(KV_META, { authServer, metadata, fetchedAt: new Date().toISOString() } satisfies DiscoveryCache)
  return metadata
}

// ── Client registration (RFC 7591 with app-credential fallback) ─────────────

type StoredClient = { client_id: string; client_secret?: string; source: 'env' | 'dynamic' | 'fallback_app' }

export async function ensureClient(metadata: AuthServerMetadata, redirectUri: string): Promise<StoredClient> {
  const envId = process.env.META_MCP_CLIENT_ID?.trim()
  if (envId) {
    return { client_id: envId, client_secret: process.env.META_MCP_CLIENT_SECRET?.trim() || undefined, source: 'env' }
  }

  const stored = await kvGetJson<StoredClient>(KV_CLIENT)
  if (stored?.client_id && stored.source === 'dynamic') return stored

  if (metadata.registration_endpoint) {
    try {
      const res = await fetch(metadata.registration_endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          client_name: 'ALMA AI Agent',
          redirect_uris: [redirectUri],
          grant_types: ['authorization_code', 'refresh_token'],
          response_types: ['code'],
          token_endpoint_auth_method: 'none',
        }),
        signal: AbortSignal.timeout(10_000),
      })
      if (res.ok) {
        const doc = (await res.json()) as { client_id?: string; client_secret?: string }
        if (doc.client_id) {
          const client: StoredClient = { client_id: doc.client_id, client_secret: doc.client_secret, source: 'dynamic' }
          await kvSetJson(KV_CLIENT, client)
          return client
        }
      }
    } catch {
      // fall through to the app-credential fallback
    }
  }

  // Plan §8: "if dynamic registration isn't offered, fall back to the owner's
  // existing app credentials (App ID 1990978398451639)".
  return { client_id: FALLBACK_CLIENT_ID, source: 'fallback_app' }
}

// ── PKCE authorize URL + callback exchange ───────────────────────────────────

const PKCE_TTL_MS = 10 * 60 * 1000

type PkceRow = { verifier: string; redirectUri: string; tier: MetaMcpScopeTier; createdAt: string }

function b64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/**
 * The registered OAuth redirect URI — same base-priority logic as
 * getGscRedirectUri so preview deployments work without per-branch env.
 */
export function getMetaMcpRedirectUri(reqOrigin?: string): string {
  const vercel = process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : ''
  const base = (process.env.NEXTAUTH_URL || process.env.APP_URL || reqOrigin || vercel || '').replace(/\/$/, '')
  return `${base}/api/assistant/meta-mcp/auth/callback`
}

/** Build the consent-dialog URL and persist the PKCE verifier keyed by state. */
export async function buildAuthorizationUrl(reqOrigin?: string): Promise<string> {
  const redirectUri = getMetaMcpRedirectUri(reqOrigin)
  const metadata = await discoverAuthServer()
  const client = await ensureClient(metadata, redirectUri)
  const tier = await getMetaMcpScopeTier()

  const verifier = b64url(crypto.randomBytes(48))
  const challenge = b64url(crypto.createHash('sha256').update(verifier).digest())
  const state = b64url(crypto.randomBytes(24))

  // Opportunistic cleanup of stale PKCE rows so the kv table never accumulates.
  try {
    const stale = new Date(Date.now() - PKCE_TTL_MS).toISOString()
    const rows = await prisma.agentKvSetting.findMany({
      where: { key: { startsWith: KV_PKCE_PREFIX } },
      select: { key: true, value: true },
    })
    const dead = rows
      .filter((r: { key: string; value: string }) => {
        try {
          return (JSON.parse(r.value) as PkceRow).createdAt < stale
        } catch {
          return true
        }
      })
      .map((r: { key: string }) => r.key)
    if (dead.length > 0) await prisma.agentKvSetting.deleteMany({ where: { key: { in: dead } } })
  } catch {
    // cleanup is best-effort
  }

  await kvSetJson(`${KV_PKCE_PREFIX}${state}`, {
    verifier,
    redirectUri,
    tier,
    createdAt: new Date().toISOString(),
  } satisfies PkceRow)

  const url = new URL(metadata.authorization_endpoint)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('client_id', client.client_id)
  url.searchParams.set('redirect_uri', redirectUri)
  url.searchParams.set('scope', TIER_SCOPES[tier].join(' '))
  url.searchParams.set('state', state)
  url.searchParams.set('code_challenge', challenge)
  url.searchParams.set('code_challenge_method', 'S256')
  // RFC 8707 resource indicator — MCP auth spec requires binding the token to
  // the MCP endpoint; harmless when the server ignores it.
  url.searchParams.set('resource', getMetaMcpEndpoint())
  return url.toString()
}

export type MetaMcpTokens = {
  access_token: string
  refresh_token?: string
  /** epoch ms; 0 = unknown (treat as long-lived until a 401 says otherwise) */
  expires_at: number
  scope?: string
  tier: MetaMcpScopeTier
  connected_at: string
}

/** Exchange the callback code for tokens and persist them. */
export async function handleAuthorizationCallback(code: string, state: string): Promise<MetaMcpTokens> {
  const pkceKey = `${KV_PKCE_PREFIX}${state}`
  const pkce = await kvGetJson<PkceRow>(pkceKey)
  await prisma.agentKvSetting.deleteMany({ where: { key: pkceKey } }).catch(() => {})
  if (!pkce?.verifier) throw new Error('pkce_state_missing — আবার Connect চাপুন')
  if (Date.now() - Date.parse(pkce.createdAt) > PKCE_TTL_MS) throw new Error('pkce_state_expired — আবার Connect চাপুন')

  const metadata = await discoverAuthServer()
  const client = await ensureClient(metadata, pkce.redirectUri)

  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: pkce.redirectUri,
    client_id: client.client_id,
    code_verifier: pkce.verifier,
    resource: getMetaMcpEndpoint(),
  })
  if (client.client_secret) body.set('client_secret', client.client_secret)

  const res = await fetch(metadata.token_endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body,
    signal: AbortSignal.timeout(15_000),
  })
  if (!res.ok) throw new Error(`meta_mcp token exchange failed: ${res.status} ${await res.text()}`)
  const data = (await res.json()) as {
    access_token?: string
    refresh_token?: string
    expires_in?: number
    scope?: string
  }
  if (!data.access_token) throw new Error('meta_mcp token exchange returned no access_token')

  const tokens: MetaMcpTokens = {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_at: data.expires_in ? Date.now() + data.expires_in * 1000 : 0,
    scope: data.scope,
    tier: pkce.tier,
    connected_at: new Date().toISOString(),
  }
  await kvSetJson(KV_TOKENS, tokens)
  return tokens
}

// ── Token access + refresh ───────────────────────────────────────────────────

export async function getMetaMcpConnection(): Promise<MetaMcpTokens | null> {
  const t = await kvGetJson<MetaMcpTokens>(KV_TOKENS)
  return t?.access_token ? t : null
}

export async function clearMetaMcpConnection(): Promise<void> {
  await prisma.agentKvSetting.deleteMany({
    where: { key: { in: [KV_TOKENS, KV_CLIENT] } },
  })
}

const EXPIRY_SKEW_MS = 60 * 1000

async function refreshTokens(current: MetaMcpTokens): Promise<MetaMcpTokens> {
  if (!current.refresh_token) throw new Error('not_connected — token expired and no refresh_token; আবার Connect চাপুন')
  const metadata = await discoverAuthServer()
  const client = await ensureClient(metadata, getMetaMcpRedirectUri())

  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: current.refresh_token,
    client_id: client.client_id,
    resource: getMetaMcpEndpoint(),
  })
  if (client.client_secret) body.set('client_secret', client.client_secret)

  const res = await fetch(metadata.token_endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body,
    signal: AbortSignal.timeout(15_000),
  })
  if (!res.ok) throw new Error(`meta_mcp token refresh failed: ${res.status} ${await res.text()}`)
  const data = (await res.json()) as {
    access_token?: string
    refresh_token?: string
    expires_in?: number
    scope?: string
  }
  if (!data.access_token) throw new Error('meta_mcp token refresh returned no access_token')

  const next: MetaMcpTokens = {
    ...current,
    access_token: data.access_token,
    // OAuth 2.1 servers may rotate the refresh token — keep the newest.
    refresh_token: data.refresh_token ?? current.refresh_token,
    expires_at: data.expires_in ? Date.now() + data.expires_in * 1000 : 0,
    scope: data.scope ?? current.scope,
  }
  await kvSetJson(KV_TOKENS, next)
  return next
}

/**
 * Mint a valid Bearer token for the MCP client. Refreshes when expired (or when
 * forceRefresh — the client's 401 recovery path). Throws 'not_connected' when
 * the owner hasn't connected yet.
 */
export async function getMetaMcpAccessToken(opts?: { forceRefresh?: boolean }): Promise<string> {
  let conn = await getMetaMcpConnection()
  if (!conn) throw new Error('not_connected')
  const expired = conn.expires_at > 0 && Date.now() > conn.expires_at - EXPIRY_SKEW_MS
  if (opts?.forceRefresh || expired) conn = await refreshTokens(conn)
  return conn.access_token
}
